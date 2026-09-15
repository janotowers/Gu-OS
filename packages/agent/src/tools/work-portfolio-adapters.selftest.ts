/**
 * Selftests for the model-facing Work Portfolio tool (R1 SL-12, SA-12.10).
 *
 * The web app's selftests prove what the Portfolio reads; these prove what a
 * model can reach through the seam: one read-only tool, available only when
 * enabled; the person's OWN session or a refusal — never the service role for
 * case-level truth; the Organization from memberships, never from a model
 * argument; a refusal returned as a result rather than a failed turn; and
 * every call audited in `tool_calls`, which the graph leaves to the tool.
 */
import assert from "node:assert/strict";
import { TOOL_CATALOG } from "./catalog";
import { toolOwnsAuditTrail } from "./tool-audit-ownership";
import {
  WORK_PORTFOLIO_TOOL_IDS,
  buildWorkPortfolioTools,
  readWorkPortfolioForTool,
  type WorkPortfolioToolDeps,
} from "./work-portfolio-adapters";
import type { ToolContext } from "./tool-context";

interface Invoker {
  name: string;
  schema: { shape?: Record<string, unknown> };
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

/** Just enough of `tool_calls` for createToolCall / updateToolCallStatus. */
function auditDb() {
  const rows: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      assert.equal(table, "tool_calls", "the tool writes its audit row and nothing else");
      return {
        insert(row: Record<string, unknown>) {
          const withId = { id: `tool-call-${rows.length + 1}`, ...row };
          rows.push(withId);
          return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: async (_column: string, id: string) => {
              Object.assign(rows.find((r) => r.id === id) ?? {}, patch);
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as ToolContext["db"], rows };
}

const ORG = "11111111-1111-1111-1111-111111111111";
const ACTOR = { role: "actor-jwt" } as unknown as NonNullable<ToolContext["actorDb"]>;

function ctx(db: ToolContext["db"], overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    actorDb: ACTOR,
    userId: "user-1",
    sessionId: "session-1",
    enabledTools: [],
    integrations: [],
    channel: "web",
    ...overrides,
  };
}

function deps(overrides: Partial<WorkPortfolioToolDeps> = {}) {
  const calls: Array<Parameters<WorkPortfolioToolDeps["readWorkPortfolio"]>[0]> = [];
  const value: WorkPortfolioToolDeps & { calls: typeof calls } = {
    calls,
    listActorOrganizations: async () => [ORG],
    readWorkPortfolio: async (params) => {
      calls.push(params);
      return { status: "ok", needs_attention: [] };
    },
    ...overrides,
  };
  return value;
}

let passed = 0;
async function t(label: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function main() {
  console.log("work-portfolio tool (R1 SL-12, SA-12.10)");

  await t("exactly one tool id, catalogued as low-risk and read-only, with no Organization parameter", () => {
    assert.deepEqual([...WORK_PORTFOLIO_TOOL_IDS], ["work_portfolio_read"]);
    const entry = TOOL_CATALOG.find((d) => d.id === "work_portfolio_read");
    assert.ok(entry);
    assert.equal(entry.risk, "low");
    assert.ok(/read-only/i.test(entry.description));
    const properties = (entry.parameters_schema as { properties: Record<string, unknown> }).properties;
    assert.deepEqual(Object.keys(properties), ["view"], "the model cannot name an Organization");
  });

  await t("not offered unless the person enabled it", () => {
    const { client } = auditDb();
    assert.deepEqual(buildWorkPortfolioTools(ctx(client), deps(), () => false), []);
    assert.equal(buildWorkPortfolioTools(ctx(client), deps(), () => true).length, 1);
  });

  await t("without the person's own session it REFUSES — and never reads with the service role", async () => {
    const d = deps();
    const result = await readWorkPortfolioForTool(ctx(auditDb().client, { actorDb: undefined }), d, "mine");
    assert.equal(result.status, "no_user_session");
    assert.equal(d.calls.length, 0, "nothing was read at all");
  });

  await t("the Organization comes from memberships: none or several fail closed", async () => {
    for (const orgs of [[], [ORG, "22222222-2222-2222-2222-222222222222"]]) {
      const d = deps({ listActorOrganizations: async () => orgs });
      const result = await readWorkPortfolioForTool(ctx(auditDb().client), d, "mine");
      assert.equal(result.status, "organization_not_resolved");
      assert.equal(d.calls.length, 0);
    }
  });

  await t("a read passes the resolved Organization, the person's OWN session and the service role separately", async () => {
    const d = deps();
    const { client } = auditDb();
    const result = await readWorkPortfolioForTool(ctx(client), d, "organization");
    assert.equal(result.status, "ok");
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0].organizationId, ORG);
    assert.equal(d.calls[0].actorDb, ACTOR, "case-level truth is read with the actor's JWT");
    assert.equal(d.calls[0].serviceDb, client);
    assert.equal(d.calls[0].actorUserId, "user-1");
    assert.equal(d.calls[0].view, "organization");
  });

  await t("the tool defaults to My Work, returns JSON, and turns a failure into a result", async () => {
    const [tool] = buildWorkPortfolioTools(ctx(auditDb().client), deps(), () => true) as unknown as Invoker[];
    const ok = JSON.parse(String(await tool.invoke({})));
    assert.equal(ok.status, "ok");
    const [failing] = buildWorkPortfolioTools(
      ctx(auditDb().client),
      deps({ readWorkPortfolio: async () => { throw new Error("boom"); } }),
      () => true
    ) as unknown as Invoker[];
    const failed = JSON.parse(String(await failing.invoke({ view: "mine" })));
    assert.deepEqual(failed, { status: "failed", error: "boom" });
    const unwired = JSON.parse(String(await (buildWorkPortfolioTools(ctx(auditDb().client), null, () => true) as unknown as Invoker[])[0].invoke({})));
    assert.equal(unwired.status, "not_configured");
  });

  await t("the graph writes no audit row for this tool, so the tool must write its own", () => {
    assert.equal(toolOwnsAuditTrail("work_portfolio_read"), true);
  });

  await t("every call writes and closes its own tool_calls row: arguments, outcome and what was read", async () => {
    const audit = auditDb();
    const [tool] = buildWorkPortfolioTools(ctx(audit.client), deps(), () => true) as unknown as Invoker[];
    await tool.invoke({ view: "organization" });
    assert.equal(audit.rows.length, 1);
    const row = audit.rows[0];
    assert.equal(row.tool_name, "work_portfolio_read");
    assert.equal(row.session_id, "session-1");
    assert.deepEqual(row.arguments_json, { view: "organization" });
    assert.equal(row.status, "executed");
    assert.deepEqual(row.result_json, { status: "ok", result: { status: "ok", needs_attention: [] } });
  });

  await t("a refusal is audited as an executed result; a failure as failed", async () => {
    const refusedAudit = auditDb();
    const [refused] = buildWorkPortfolioTools(ctx(refusedAudit.client, { actorDb: undefined }), deps(), () => true) as unknown as Invoker[];
    await refused.invoke({});
    assert.equal(refusedAudit.rows[0].status, "executed");
    assert.equal((refusedAudit.rows[0].result_json as { status: string }).status, "no_user_session");
    const failedAudit = auditDb();
    const [failing] = buildWorkPortfolioTools(
      ctx(failedAudit.client),
      deps({ readWorkPortfolio: async () => { throw new Error("boom"); } }),
      () => true
    ) as unknown as Invoker[];
    await failing.invoke({});
    assert.equal(failedAudit.rows[0].status, "failed");
  });

  console.log(`\nwork-portfolio tool selftest: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
