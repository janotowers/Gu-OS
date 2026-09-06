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
  | { kind: "is"; column: string; value: null };

/** A unique index the fake enforces, so a duplicate insert really conflicts. */
export interface FakeUniqueIndex {
  table: string;
  columns: string[];
}

export interface FakeDbOptions {
  tables?: Record<string, Row[]>;
  uniqueIndexes?: FakeUniqueIndex[];
}

export interface FakeDb {
  client: DbClient;
  tables: Record<string, Row[]>;
  /** Every table a query touched, in order. Used to assert "zero reads". */
  reads: string[];
  writes: string[];
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    if (filter.kind === "eq") return row[filter.column] === filter.value;
    if (filter.kind === "neq") return row[filter.column] !== filter.value;
    return row[filter.column] === null || row[filter.column] === undefined;
  });
}

export function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const tables: Record<string, Row[]> = options.tables ?? {};
  const uniqueIndexes = options.uniqueIndexes ?? [];
  const reads: string[] = [];
  const writes: string[] = [];

  function table(name: string): Row[] {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function uniqueViolation(name: string, candidate: Row): boolean {
    return uniqueIndexes
      .filter((index) => index.table === name)
      .some((index) =>
        table(name).some((existing) =>
          index.columns.every(
            (column) => existing[column] === candidate[column]
          )
        )
      );
  }

  function builder(name: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let pending: Row[] = [];
    let patch: Row = {};
    let orderColumn: string | null = null;
    let orderAscending = true;
    let limitValue: number | null = null;

    function apply(): { rows: Row[]; error: unknown } {
      if (mode === "insert") {
        writes.push(name);
        const inserted: Row[] = [];
        for (const row of pending) {
          const withId: Row = { id: randomUUID(), ...row };
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
        const { rows, error } = apply();
        return { data: rows[0] ?? null, error };
      },
      single: async () => {
        const { rows, error } = apply();
        if (!error && rows.length === 0) {
          return {
            data: null,
            error: { code: "PGRST116", message: "no rows returned" },
          };
        }
        return { data: rows[0] ?? null, error };
      },
      then: (resolve: (value: { data: Row[]; error: unknown }) => unknown) => {
        const { rows, error } = apply();
        return resolve({ data: rows, error });
      },
    };
    return self;
  }

  return {
    client: { from: (name: string) => builder(name) } as unknown as DbClient,
    tables,
    reads,
    writes,
  };
}
