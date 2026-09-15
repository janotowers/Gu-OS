/**
 * One logical tool invocation = one `tool_calls` row — R1 Cycle 3 order 5,
 * decided by the Accountable on 2026-09-15 (Slice Plan §8 Q7, Q8).
 *
 * Q8. A confirmation row a person approved is that invocation's canonical
 * record: it evolves to `executed` or `failed`, and the tool writes no second
 * row. Auto-executed with no confirmation row, the tool writes its own. The
 * graph opens an invocation scope around every tool call and names the row;
 * the model never can. A row that is not this invocation's approved
 * confirmation row — another session's, another tool's, one still awaiting a
 * person, one already closed — is never reused.
 *
 * Q7. The two introspection tools audit themselves through the same runner as
 * every low-risk tool, and answer exactly as before.
 */
import assert from "node:assert/strict";
import { buildLangChainTools } from "./adapters";
import { buildLegacyGatewayTools, type LegacyGatewayDeps } from "./legacy-gateway-adapters";
import {
  closeToolInvocation,
  createTrackedToolCall,
  failToolInvocation,
  openToolInvocation,
} from "./tool-call-audit";
import type { ToolContext } from "./tool-context";

type Row = Record<string, unknown>;

/** Just enough of `tool_calls` and `profiles` for the audit path's query shapes. */
function fakeDb(profiles: Row[] = []) {
  const tables: Record<string, Row[]> = { tool_calls: [], profiles };
  let next = 1;
  const client = {
    from(table: string) {
      const rows = tables[table];
      assert.ok(rows, `the audit path touched an unexpected table: ${table}`);
      const filters: Array<[string, unknown]> = [];
      const matching = () => rows.filter((row) => filters.every(([column, value]) => row[column] === value));
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
        single: async () => {
          const [row] = matching();
          return row ? { data: row, error: null } : { data: null, error: { message: "no row" } };
        },
        insert(row: Row) {
          const withId = { id: `tool-call-${next++}`, ...row };
          rows.push(withId);
          return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
        },
        update(patch: Row) {
          return {
            eq: async (column: string, value: unknown) => {
              for (const row of rows) if (row[column] === value) Object.assign(row, patch);
              return { error: null };
            },
          };
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as ToolContext["db"], tables };
}

function ctxFor(db: ToolContext["db"], enabled: string[] = []): ToolContext {
  return {
    db,
    userId: "user-1",
    sessionId: "session-1",
    channel: "web",
    enabledTools: enabled.map((tool_id, i) => ({
      id: `setting-${i}`,
      user_id: "user-1",
      tool_id,
      enabled: true,
      config_json: {},
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    })),
    integrations: [],
  };
}

interface Invoker {
  name: string;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

function legacyLeadTool(db: ToolContext["db"]): Invoker {
  const deps: LegacyGatewayDeps = {
    listActorOrganizations: async () => ["11111111-1111-1111-1111-111111111111"],
    readLeadContext: async () => ({ value: { legacyLeadId: "lead-1" }, provenance: {} }),
    readRecentMessages: async () => ({}),
    readDealAppointments: async () => ({}),
    readPropertyDetails: async () => ({}),
    describeRefusal: () => null,
  };
  const [tool] = buildLegacyGatewayTools(ctxFor(db), deps, (id) => id === "legacy_lead_get_context");
  return tool as unknown as Invoker;
}

/** The row the graph writes when it asks a person, as they approved it. */
function confirmationRow(overrides: Row = {}): Row {
  return {
    id: "confirmation-1",
    session_id: "session-1",
    tool_name: "legacy_lead_get_context",
    arguments_json: { legacy_lead_id: "lead-1" },
    status: "approved",
    requires_confirmation: true,
    ...overrides,
  };
}

let passed = 0;
async function t(label: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function main() {
  console.log("one tool_calls row per invocation (R1 Cycle 3 order 5 — §8 Q7, Q8)");

  await t("Q8 an approved confirmation row is the invocation's one row: the tool writes its execution into it", async () => {
    const { client, tables } = fakeDb();
    tables.tool_calls.push(confirmationRow());
    const invocation = openToolInvocation("legacy_lead_get_context", "confirmation-1");
    const output = JSON.parse(
      String(await invocation.run(() => legacyLeadTool(client).invoke({ legacy_lead_id: "lead-1" })))
    );
    assert.equal(tables.tool_calls.length, 1, "the tool wrote no second row");
    const [row] = tables.tool_calls;
    assert.equal(row.id, "confirmation-1");
    assert.equal(row.status, "executed", "the canonical row evolved to executed");
    assert.deepEqual(row.result_json, output);
    assert.deepEqual(row.arguments_json, { legacy_lead_id: "lead-1" }, "the approved arguments stay on record");
    assert.equal(invocation.state.rowId, "confirmation-1");
  });

  await t("Q8 auto-executed with no confirmation row, the tool creates its own one row", async () => {
    const { client, tables } = fakeDb();
    const invocation = openToolInvocation("legacy_lead_get_context", null);
    await invocation.run(() => legacyLeadTool(client).invoke({ legacy_lead_id: "lead-1" }));
    assert.equal(tables.tool_calls.length, 1);
    assert.equal(tables.tool_calls[0].status, "executed");
    assert.equal(invocation.state.rowId, tables.tool_calls[0].id);
  });

  await t("Q8 a row that is not this invocation's approved confirmation is never reused", async () => {
    for (const foreign of [
      confirmationRow({ session_id: "session-2" }),
      confirmationRow({ tool_name: "appointment_get" }),
      confirmationRow({ status: "pending_confirmation" }),
      confirmationRow({ status: "executed" }),
    ]) {
      const { client, tables } = fakeDb();
      tables.tool_calls.push({ ...foreign });
      const invocation = openToolInvocation("legacy_lead_get_context", "confirmation-1");
      await invocation.run(() => legacyLeadTool(client).invoke({ legacy_lead_id: "lead-1" }));
      assert.equal(tables.tool_calls.length, 2, `a new row, not ${JSON.stringify(foreign)}`);
      assert.deepEqual(tables.tool_calls[0], foreign, "the foreign row is untouched");
      assert.notEqual(invocation.state.rowId, "confirmation-1");
    }
  });

  await t("Q8 only the first row an invocation opens can claim its confirmation row, and only for its own tool", async () => {
    const { client, tables } = fakeDb();
    tables.tool_calls.push(confirmationRow());
    const ctx = ctxFor(client);
    const invocation = openToolInvocation("legacy_lead_get_context", "confirmation-1");
    await invocation.run(async () => {
      const other = await createTrackedToolCall(ctx, "appointment_get", {}, false);
      assert.notEqual(other.id, "confirmation-1", "another tool's audit never takes this invocation's row");
      const first = await createTrackedToolCall(ctx, "legacy_lead_get_context", {}, false);
      assert.equal(first.id, "confirmation-1");
      const second = await createTrackedToolCall(ctx, "legacy_lead_get_context", {}, false);
      assert.notEqual(second.id, "confirmation-1", "the row is claimed once");
    });
  });

  await t("Q8 outside a graph invocation a tool creates its own row, as before", async () => {
    const { client, tables } = fakeDb();
    tables.tool_calls.push(confirmationRow());
    await legacyLeadTool(client).invoke({ legacy_lead_id: "lead-1" });
    assert.equal(tables.tool_calls.length, 2);
    assert.equal(tables.tool_calls[0].status, "approved", "no scope, no claim");
  });

  await t("Q8 after the run: a claimed row the tool closed is left as the tool closed it", async () => {
    const { client, tables } = fakeDb();
    tables.tool_calls.push(confirmationRow());
    const invocation = openToolInvocation("legacy_lead_get_context", "confirmation-1");
    const output = String(await invocation.run(() => legacyLeadTool(client).invoke({ legacy_lead_id: "lead-1" })));
    const closed = await closeToolInvocation(client, { state: invocation.state, graphRowId: "confirmation-1", output });
    assert.deepEqual(closed, { rowId: "confirmation-1", status: "executed" });
    assert.equal(tables.tool_calls.length, 1);
    assert.deepEqual(tables.tool_calls[0].result_json, JSON.parse(output), "the tool's record stands");
  });

  await t("Q8 after the run: a claimed row the tool left open is closed from the result", async () => {
    const { client, tables } = fakeDb();
    tables.tool_calls.push(confirmationRow());
    const invocation = openToolInvocation("legacy_lead_get_context", "confirmation-1");
    await invocation.run(() => createTrackedToolCall(ctxFor(client), "legacy_lead_get_context", {}, false));
    const closed = await closeToolInvocation(client, {
      state: invocation.state,
      graphRowId: "confirmation-1",
      output: JSON.stringify({ error: "the source refused" }),
    });
    assert.deepEqual(closed, { rowId: "confirmation-1", status: "failed" });
    assert.equal(tables.tool_calls[0].status, "failed");
  });

  await t("Q8 after the run: a graph row the tool never claimed is closed by the graph, as before", async () => {
    const { client, tables } = fakeDb();
    tables.tool_calls.push(confirmationRow({ tool_name: "bash" }));
    const invocation = openToolInvocation("bash", "confirmation-1");
    await invocation.run(async () => "no audit of its own");
    const executed = await closeToolInvocation(client, {
      state: invocation.state,
      graphRowId: "confirmation-1",
      output: JSON.stringify({ stdout: "ok" }),
    });
    assert.deepEqual(executed, { rowId: "confirmation-1", status: "executed" });
    assert.deepEqual(tables.tool_calls[0].result_json, { stdout: "ok" });
    const raw = await closeToolInvocation(client, { state: invocation.state, graphRowId: "confirmation-1", output: "plain text" });
    assert.deepEqual(raw, { rowId: "confirmation-1", status: "executed" });
    assert.deepEqual(tables.tool_calls[0].result_json, { raw: "plain text" });
  });

  await t("Q8 after the run: a tool that kept its own row closes it; the graph leaves it alone", async () => {
    const { client, tables } = fakeDb();
    const invocation = openToolInvocation("legacy_lead_get_context", null);
    const output = String(await invocation.run(() => legacyLeadTool(client).invoke({ legacy_lead_id: "lead-1" })));
    assert.equal(await closeToolInvocation(client, { state: invocation.state, graphRowId: null, output }), null);
    assert.equal(tables.tool_calls.length, 1);
    assert.equal(tables.tool_calls[0].status, "executed");
  });

  await t("Q8 on a throw: the invocation's row is closed as failed; a row is created only when it has none", async () => {
    const payload = { status: "validation_error", error: "bad input" };
    const created: string[] = [];
    const createRow = async (db: ToolContext["db"]) => {
      const row = await createTrackedToolCall(ctxFor(db), "legacy_lead_get_context", {}, false);
      created.push(row.id);
      return row;
    };

    const withConfirmation = fakeDb();
    withConfirmation.tables.tool_calls.push(confirmationRow());
    const claimedOrNot = openToolInvocation("legacy_lead_get_context", "confirmation-1");
    const rowId = await failToolInvocation(withConfirmation.client, {
      state: claimedOrNot.state,
      graphRowId: "confirmation-1",
      payload,
      createRow: () => createRow(withConfirmation.client),
    });
    assert.equal(rowId, "confirmation-1");
    assert.equal(withConfirmation.tables.tool_calls.length, 1, "no second row for the failure");
    assert.equal(withConfirmation.tables.tool_calls[0].status, "failed");
    assert.deepEqual(withConfirmation.tables.tool_calls[0].result_json, payload);

    const none = fakeDb();
    const bare = openToolInvocation("legacy_lead_get_context", null);
    const newRow = await failToolInvocation(none.client, {
      state: bare.state,
      graphRowId: null,
      payload,
      createRow: () => createRow(none.client),
    });
    assert.deepEqual(created, [newRow]);
    assert.equal(none.tables.tool_calls.length, 1);
    assert.equal(none.tables.tool_calls[0].status, "failed");
  });

  await t("Q7 get_user_preferences writes and closes exactly one row, and answers exactly as before", async () => {
    const profile = {
      id: "user-1",
      name: "Ana",
      timezone: "America/Mexico_City",
      language: "es",
      agent_name: "Gu",
      email: "ana@example.test",
      phone: null,
    };
    const { client, tables } = fakeDb([profile]);
    const tools = buildLangChainTools(ctxFor(client, ["get_user_preferences"])) as unknown as Invoker[];
    const tool = tools.find((candidate) => candidate.name === "get_user_preferences");
    assert.ok(tool);
    const output = JSON.parse(String(await tool.invoke({})));
    assert.deepEqual(output, {
      name: "Ana",
      timezone: "America/Mexico_City",
      language: "es",
      agent_name: "Gu",
      email: "ana@example.test",
      phone: null,
    });
    assert.equal(tables.tool_calls.length, 1);
    assert.equal(tables.tool_calls[0].tool_name, "get_user_preferences");
    assert.equal(tables.tool_calls[0].status, "executed");
    assert.deepEqual(tables.tool_calls[0].result_json, output);
  });

  await t("Q7 list_enabled_tools writes and closes exactly one row, and still answers with the plain list", async () => {
    const { client, tables } = fakeDb();
    const tools = buildLangChainTools(ctxFor(client, ["list_enabled_tools", "get_user_preferences"])) as unknown as Invoker[];
    const tool = tools.find((candidate) => candidate.name === "list_enabled_tools");
    assert.ok(tool);
    const output = JSON.parse(String(await tool.invoke({})));
    assert.ok(Array.isArray(output), "the model still gets a JSON array");
    assert.deepEqual([...output].sort(), ["get_user_preferences", "list_enabled_tools"]);
    assert.equal(tables.tool_calls.length, 1);
    assert.equal(tables.tool_calls[0].tool_name, "list_enabled_tools");
    assert.equal(tables.tool_calls[0].status, "executed");
    assert.deepEqual(tables.tool_calls[0].result_json, output);
  });

  console.log(`\none-row-per-invocation selftest: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
