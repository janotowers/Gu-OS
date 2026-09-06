/**
 * In-memory Supabase-shaped database fake for the admission selftests.
 *
 * Big enough to exercise the real query helpers rather than mocks of them: the
 * tests call `runAdmission`, which calls `@agents/db` for real, which lands
 * here. That is the point — a fake at the client boundary keeps the executor's
 * actual database interactions under test, including the unique-constraint
 * behavior the idempotency guarantee (SA-2.4) rests on.
 *
 * It models exactly what those helpers use: filtered selects, inserts with
 * unique-index enforcement, filtered updates, ordering and limits. Anything
 * beyond that throws rather than pretending, so a helper that grows a new query
 * shape fails loudly instead of silently passing against a fake that guessed.
 *
 * Test-only. Not exported from the module index.
 */
import { randomUUID } from "node:crypto";
import type { DbClient } from "@agents/db";

type Row = Record<string, unknown>;

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "neq"; column: string; value: unknown }
  | { kind: "lte"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null };

/**
 * Resolves a PostgREST column reference, including the `col->>key` JSON form
 * the reconciliation lookup uses. Without this the fake would silently match
 * nothing and a recovery test would pass for the wrong reason.
 */
function columnValue(row: Row, column: string): unknown {
  const arrow = column.indexOf("->>");
  if (arrow === -1) return row[column];
  const base = column.slice(0, arrow);
  const key = column.slice(arrow + 3).replace(/^'|'$/g, "");
  const container = row[base];
  if (!container || typeof container !== "object") return undefined;
  const value = (container as Record<string, unknown>)[key];
  return value === undefined || value === null ? value : String(value);
}

/** A unique index the fake enforces, so a duplicate insert really conflicts. */
export interface FakeUniqueIndex {
  table: string;
  columns: string[];
  /** Partial-index predicate. Rows it excludes can never collide. */
  where?: (row: Row) => boolean;
}

export interface FakeDbOptions {
  tables?: Record<string, Row[]>;
  uniqueIndexes?: FakeUniqueIndex[];
  /**
   * Fault injection, so a crash can be reproduced at a real write rather than
   * simulated by hand-editing the resulting rows.
   *
   * Each entry fails the Nth write to that table (1-based) exactly once. A
   * partial-failure test that constructed the post-crash state itself would
   * prove the recovery reads what the test wrote; failing the actual write
   * proves it recovers what the code wrote.
   */
  failWrite?: Array<{ table: string; occurrence?: number }>;
  /**
   * Column defaults per table, applied on insert.
   *
   * The fake speaks PostgREST, not PostgreSQL: it never sees a DEFAULT clause.
   * Declaring the nullable columns the code reads back keeps `null` meaning
   * `null` here rather than `undefined`, so a recovery assertion cannot pass
   * for the wrong reason.
   */
  defaults?: Record<string, Row>;
  /**
   * Fires immediately before each durable write, and is awaited.
   *
   * The coordination point a concurrency test needs: it can hold one worker
   * mid-materialisation while another reclaims and finishes, which is the only
   * way to exercise two workers actually racing inside the same Case rather
   * than one merely resuming after the other stopped.
   */
  onWrite?: (table: string) => Promise<void> | void;
}

export interface FakeDb {
  client: DbClient;
  tables: Record<string, Row[]>;
  /** Every table a query touched, in order. Used to assert "zero reads". */
  reads: string[];
  writes: string[];
  /** Arms a one-shot write failure after construction. */
  failNextWrite(table: string): void;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const actual = columnValue(row, filter.column);
    if (filter.kind === "eq") return actual === filter.value;
    if (filter.kind === "neq") return actual !== filter.value;
    if (filter.kind === "lte") {
      // Timestamps are compared as ISO strings, which sort chronologically.
      if (actual === null || actual === undefined) return false;
      return String(actual) <= String(filter.value);
    }
    return actual === null || actual === undefined;
  });
}

export function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const tables: Record<string, Row[]> = options.tables ?? {};
  const uniqueIndexes = options.uniqueIndexes ?? [];
  const reads: string[] = [];
  const writes: string[] = [];
  const defaults = options.defaults ?? {};
  const writeCounts = new Map<string, number>();
  const armedFaults = (options.failWrite ?? []).map((fault) => ({
    table: fault.table,
    occurrence: fault.occurrence ?? 1,
    fired: false,
  }));

  function takeFault(name: string, ordinal: number): boolean {
    const fault = armedFaults.find(
      (candidate) =>
        !candidate.fired &&
        candidate.table === name &&
        candidate.occurrence === ordinal
    );
    if (!fault) return false;
    fault.fired = true;
    return true;
  }

  function table(name: string): Row[] {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function uniqueViolation(name: string, candidate: Row): boolean {
    return uniqueIndexes
      .filter((index) => index.table === name)
      .some((index) => {
        // Partial-index semantics: a row outside the predicate, or with no
        // value for an indexed expression, is simply not covered.
        if (index.where && !index.where(candidate)) return false;
        const candidateKey = index.columns.map((column) =>
          columnValue(candidate, column)
        );
        if (candidateKey.some((value) => value === null || value === undefined)) {
          return false;
        }
        return table(name).some(
          (existing) =>
            (!index.where || index.where(existing)) &&
            index.columns.every(
              (column, i) => columnValue(existing, column) === candidateKey[i]
            )
        );
      });
  }

  function builder(name: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let pending: Row[] = [];
    let patch: Row = {};
    let orderColumn: string | null = null;
    let orderAscending = true;
    let limitValue: number | null = null;

    /** Awaited before any durable write, so a test can hold a worker there. */
    async function beforeWrite(): Promise<void> {
      if (mode === "select") return;
      await options.onWrite?.(name);
    }

    function apply(): { rows: Row[]; error: unknown } {
      if (mode === "insert") {
        const ordinal = (writeCounts.get(name) ?? 0) + 1;
        writeCounts.set(name, ordinal);
        if (takeFault(name, ordinal)) {
          return {
            rows: [],
            error: {
              code: "INJECTED",
              message: `injected write failure on ${name} #${ordinal}`,
            },
          };
        }
        writes.push(name);
        const inserted: Row[] = [];
        for (const row of pending) {
          const withId: Row = {
            id: randomUUID(),
            ...(defaults[name] ?? {}),
            ...row,
          };
          if (uniqueViolation(name, withId)) {
            return {
              rows: [],
              error: {
                code: "23505",
                message: `duplicate key value violates unique constraint on ${name}`,
              },
            };
          }
          table(name).push(withId);
          inserted.push(withId);
        }
        return { rows: inserted, error: null };
      }

      if (mode === "update") {
        const ordinal = (writeCounts.get(name) ?? 0) + 1;
        writeCounts.set(name, ordinal);
        if (takeFault(name, ordinal)) {
          return {
            rows: [],
            error: {
              code: "INJECTED",
              message: `injected write failure on ${name} #${ordinal}`,
            },
          };
        }
        writes.push(name);
        const affected = table(name).filter((row) => matches(row, filters));
        for (const row of affected) Object.assign(row, patch);
        return { rows: affected, error: null };
      }

      if (mode === "delete") {
        writes.push(name);
        const affected = table(name).filter((row) => matches(row, filters));
        tables[name] = table(name).filter((row) => !matches(row, filters));
        return { rows: affected, error: null };
      }

      reads.push(name);
      let rows = table(name).filter((row) => matches(row, filters));
      if (orderColumn) {
        const column = orderColumn;
        rows = [...rows].sort((a, b) => {
          const left = String(a[column] ?? "");
          const right = String(b[column] ?? "");
          return orderAscending
            ? left.localeCompare(right)
            : right.localeCompare(left);
        });
      }
      if (limitValue !== null) rows = rows.slice(0, limitValue);
      return { rows, error: null };
    }

    const self: Record<string, unknown> = {
      select: () => self,
      insert: (values: Row | Row[]) => {
        mode = "insert";
        pending = Array.isArray(values) ? values : [values];
        return self;
      },
      update: (values: Row) => {
        mode = "update";
        patch = values;
        return self;
      },
      delete: () => {
        mode = "delete";
        return self;
      },
      eq: (column: string, value: unknown) => {
        filters.push({ kind: "eq", column, value });
        return self;
      },
      neq: (column: string, value: unknown) => {
        filters.push({ kind: "neq", column, value });
        return self;
      },
      lte: (column: string, value: unknown) => {
        filters.push({ kind: "lte", column, value });
        return self;
      },
      is: (column: string, value: null) => {
        filters.push({ kind: "is", column, value });
        return self;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderColumn = column;
        orderAscending = opts?.ascending ?? true;
        return self;
      },
      limit: (count: number) => {
        limitValue = count;
        return self;
      },
      maybeSingle: async () => {
        await beforeWrite();
        const { rows, error } = apply();
        return { data: rows[0] ?? null, error };
      },
      single: async () => {
        await beforeWrite();
        const { rows, error } = apply();
        if (!error && rows.length === 0) {
          return {
            data: null,
            error: { code: "PGRST116", message: "no rows returned" },
          };
        }
        return { data: rows[0] ?? null, error };
      },
      then: (resolve: (value: { data: Row[]; error: unknown }) => unknown) =>
        Promise.resolve()
          .then(() => beforeWrite())
          .then(() => {
            const { rows, error } = apply();
            return resolve({ data: rows, error });
          }),
    };
    return self;
  }

  return {
    client: { from: (name: string) => builder(name) } as unknown as DbClient,
    tables,
    reads,
    writes,
    failNextWrite(table: string) {
      armedFaults.push({
        table,
        occurrence: (writeCounts.get(table) ?? 0) + 1,
        fired: false,
      });
    },
  };
}
