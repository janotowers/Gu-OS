/**
 * Hosted verification of R1 Cycle 3 order 5, Slice Plan §8 Q9: `tool_calls`
 * is read-own and NOT user-writable in a delivered environment.
 *
 * The DB-backed suite (packages/db/test-rls) proves the policy against a fresh
 * rebuild and refuses to run against a hosted database, because it drops
 * schemas. This verifier is its hosted counterpart, and it changes nothing:
 *
 *   - read-only: the migration is recorded, the table's policies are exactly
 *     the two the migration creates, and row-level security is on;
 *   - behavior: ONE transaction, always ROLLED BACK. It uses two synthetic
 *     users (random ids, never a real person) with a session and an audit row
 *     each, and exercises the real roles with request-scoped claims, as a real
 *     request would: own-read; cross-user and anon denial; the user's INSERT,
 *     UPDATE and DELETE refused; and the service role still writing.
 *
 * It prints outcomes and counts only — no identifier, no row content.
 *
 *   npx tsx scripts/verify-tool-calls-rls.ts --env-file .env.staging.local --env staging [--json out.json]
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { assertBinding, parseTargetArgs, resolveTarget } from "./lib/target-env";

const MIGRATION = "20260915192651";
const EXPECTED_POLICIES = [
  { name: "Service role manages tool calls", cmd: "ALL" },
  { name: "Users read own tool calls", cmd: "SELECT" },
];

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonAt = argv.indexOf("--json");
  const jsonPath = jsonAt >= 0 ? argv[jsonAt + 1] : undefined;
  const target = resolveTarget(parseTargetArgs(argv.filter((_, i) => i !== jsonAt && i !== jsonAt + 1)));
  assertBinding(target);
  const client = new Client({ connectionString: target.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const checks: Check[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    console.log(`tool_calls read-own verification — ${target.name} (${target.projectRef})\n`);

    // ---- read-only -------------------------------------------------------
    const recorded = await client.query(
      "select 1 from supabase_migrations.schema_migrations where version = $1",
      [MIGRATION]
    );
    check(`migration ${MIGRATION} is recorded`, recorded.rowCount === 1);

    const rls = await client.query<{ on: boolean }>(
      "select relrowsecurity as on from pg_class where oid = 'public.tool_calls'::regclass"
    );
    check("row-level security is enabled on tool_calls", rls.rows[0]?.on === true);

    const policies = await client.query<{ policyname: string; cmd: string; roles: string[] }>(
      `select policyname, cmd, roles from pg_policies
        where schemaname = 'public' and tablename = 'tool_calls' order by policyname`
    );
    const found = policies.rows.map((p) => `${p.policyname} [${p.cmd}]`);
    check(
      "the table's policies are exactly the migration's two",
      policies.rowCount === EXPECTED_POLICIES.length &&
        EXPECTED_POLICIES.every((e) => policies.rows.some((p) => p.policyname === e.name && p.cmd === e.cmd)),
      found.join("; ")
    );
    const read = policies.rows.find((p) => p.policyname === "Users read own tool calls");
    check(
      "the user policy is SELECT for authenticated only",
      read?.cmd === "SELECT" && String(read.roles) === "{authenticated}",
      read ? `${read.cmd} to ${String(read.roles)}` : "missing"
    );
    check(
      "the 00001 policy granting users write authority is gone",
      !policies.rows.some((p) => p.policyname === "Users can manage own tool calls")
    );

    // ---- behavior, in one transaction that is always rolled back ----------
    const userA = randomUUID();
    const userB = randomUUID();
    await client.query("begin");
    try {
      for (const id of [userA, userB]) {
        await client.query("insert into auth.users (id, email) values ($1, $2)", [
          id,
          `q9-verify-${id}@example.invalid`,
        ]);
      }
      const session = async (userId: string) =>
        (await client.query<{ id: string }>("insert into public.agent_sessions (user_id) values ($1) returning id", [userId]))
          .rows[0].id;
      const row = async (sessionId: string) =>
        (
          await client.query<{ id: string }>(
            "insert into public.tool_calls (session_id, tool_name, status) values ($1, 'q9_verify', 'executed') returning id",
            [sessionId]
          )
        ).rows[0].id;
      const sessionA = await session(userA);
      const sessionB = await session(userB);
      const rowA = await row(sessionA);
      const rowB = await row(sessionB);

      // Runs `fn` as `role` with request-scoped claims, then undoes it.
      const as = async <T>(role: "authenticated" | "anon" | "service_role", sub: string | null, fn: () => Promise<T>) => {
        await client.query("savepoint q9");
        try {
          await client.query("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify(sub ? { sub, role } : { role }),
          ]);
          await client.query(`set local role ${role}`);
          return await fn();
        } finally {
          await client.query("rollback to savepoint q9");
        }
      };
      const sqlState = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? "unknown";
        }
      };
      const count = async (sql: string, params: unknown[] = []) =>
        Number((await client.query<{ n: string }>(sql, params)).rows[0].n);

      check(
        "a user reads the audit rows of their own sessions",
        (await as("authenticated", userA, () =>
          count("select count(*) as n from public.tool_calls where session_id in ($1, $2)", [sessionA, sessionB])
        )) === 1
      );
      check(
        "another user's audit row is invisible",
        (await as("authenticated", userA, () => count("select count(*) as n from public.tool_calls where id = $1", [rowB]))) === 0
      );
      check(
        "anon reads no audit row",
        (await as("anon", null, () =>
          count("select count(*) as n from public.tool_calls where id in ($1, $2)", [rowA, rowB])
        )) === 0
      );
      const insertState = await as("authenticated", userA, () =>
        sqlState(() =>
          client.query("insert into public.tool_calls (session_id, tool_name) values ($1, 'forged_tool')", [sessionA])
        )
      );
      check("a user cannot INSERT an audit row, not even for their own session", insertState === "42501", `SQLSTATE ${insertState}`);
      const updated = await as("authenticated", userA, async () =>
        (await client.query("update public.tool_calls set status = 'failed' where id = $1", [rowA])).rowCount
      );
      check("a user cannot UPDATE their own audit row", updated === 0, `${updated} row(s) affected`);
      const deleted = await as("authenticated", userA, async () =>
        (await client.query("delete from public.tool_calls where id = $1", [rowA])).rowCount
      );
      check("a user cannot DELETE their own audit row", deleted === 0, `${deleted} row(s) affected`);
      const serviceWrites = await as("service_role", null, async () => {
        const opened = await client.query<{ id: string }>(
          "insert into public.tool_calls (session_id, tool_name, status) values ($1, 'q9_verify_writer', 'approved') returning id",
          [sessionA]
        );
        const closed = await client.query("update public.tool_calls set status = 'executed' where id = $1", [opened.rows[0].id]);
        return (opened.rowCount ?? 0) + (closed.rowCount ?? 0);
      });
      check("the authorized writer, the service role, still opens and closes audit rows", serviceWrites === 2);
    } finally {
      await client.query("rollback");
    }
    const leftovers = await count0(client, "select count(*) as n from public.tool_calls where tool_name like 'q9_verify%'");
    check("nothing persisted: the synthetic users, sessions and rows were rolled back", leftovers === 0, `${leftovers} row(s)`);
  } finally {
    await client.end();
  }

  const passed = checks.every((c) => c.ok);
  const evidence = {
    ranAt: new Date().toISOString(),
    scope: "R1 Cycle 3 order 5 — Slice Plan §8 Q9",
    environment: target.name,
    migration: `${MIGRATION}_tool_calls_read_own.sql`,
    method:
      "read-only catalog checks, then one transaction always rolled back: two synthetic users (random ids, never a real person), the real authenticated / anon / service_role roles with request-scoped claims",
    checks,
    passed,
  };
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(`\n${passed ? "PASSED" : "FAILED"} — ${checks.filter((c) => c.ok).length}/${checks.length} checks`);
  if (!passed) process.exitCode = 1;
}

async function count0(client: Client, sql: string): Promise<number> {
  return Number((await client.query<{ n: string }>(sql)).rows[0].n);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
