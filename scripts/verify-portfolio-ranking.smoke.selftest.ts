// Smoke test for the SL-12 hosted verifier's I/O — the half that
// `portfolio-ranking-evidence.selftest.ts` deliberately does not cover.
//
// The RS-2 run spends human approvals and the advisor's own time, so a typo in
// a filter or a mis-assembled checkpoint must fail HERE, before anyone is asked
// for anything. The phases run against the in-memory fake: the bounded flag
// activation, SL-7's governed seed plus SL-12's contextual seed (both with the
// real supervisor and deterministic stub judges), checkpoints, the advisor's
// session through the SAME library calls the page and the chat tool make, then
// verify, then the restoration. What this proves is narrow: the verifier's
// reads, writes and evidence assembly are internally consistent and produce an
// artifact the evaluator accepts. It proves nothing about PostgreSQL, RLS, the
// rendered page or the meter — the hosted run and the other suites own those.
// Where the hosted run relies on the graph's audit row and the AI-usage meter,
// this test writes the row those would write, and says so.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createFakeDb } from "../apps/web/src/lib/relationship-testing/fake-db";
import { loadWorkPortfolio } from "../apps/web/src/lib/work-portfolio/load";
import { rankWorkPortfolio, type RankedPortfolioView } from "../apps/web/src/lib/work-portfolio/ranking";
import { buildRankingFrame } from "../apps/web/src/lib/work-portfolio/ranking/frame";
import type { PortfolioRankingJudge, RankingOutput } from "../apps/web/src/lib/work-portfolio/ranking/contract";
import { readWorkPortfolioForChat } from "../apps/web/src/lib/work-portfolio/chat-summary";
import { phaseSeed as seedGovernedCase } from "./verify-portfolio";
import {
  phaseActivateRanking,
  phaseRestoreRanking,
  phaseSeed,
  phaseVerify,
  takeCheckpoint,
  type RunManifest,
} from "./verify-portfolio-ranking";
import type { PageCapture, ProbeResult } from "./lib/portfolio-ranking-evidence";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const ADVISOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_CASE = "cccccccc-0000-0000-0000-00000000000b";
const SESSION = "dddddddd-0000-0000-0000-000000000001";

let passed = 0;
async function t(label: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function harness() {
  return createFakeDb({
    tables: {
      organizations: [
        { id: ORG, name: "Pilot", status: "active" },
        { id: OTHER_ORG, name: "Other", status: "active" },
      ],
      organization_memberships: [
        { id: "m1", organization_id: ORG, user_id: ADVISOR, role: "advisor", status: "active" },
        { id: "m2", organization_id: ORG, user_id: OWNER, role: "owner", status: "active" },
      ],
      organization_feature_flags: [
        { id: "f1", organization_id: ORG, flag_key: "relationship_ops", enabled: true, value_text: null },
        { id: "f2", organization_id: ORG, flag_key: "relationship_admission_mode", enabled: true, value_text: "shadow" },
      ],
      operational_case_types: [
        { id: "ct-1", case_type: "lead_opportunity", user_id: null, default_skill_slug: "lead-opportunity-supervisor" },
      ],
      workflow_definitions: [
        { id: "def-1", owner_scope: "global", user_id: null, case_type: "lead_opportunity", version: 1, status: "published" },
      ],
      operational_cases: [
        { id: OTHER_CASE, user_id: "someone", organization_id: OTHER_ORG, case_type: "gate_a_fixture", status: "active", version: 0 },
      ],
      operational_case_events: [],
      case_facts: [],
      case_subjects: [],
      work_items: [],
      work_item_events: [],
      work_item_dependencies: [],
      work_item_attempts: [],
      portfolio_presentation_state: [],
      agent_sessions: [{ id: SESSION, user_id: ADVISOR }],
      tool_calls: [],
      ai_usage_events: [],
    },
    defaults: {
      case_facts: { superseded_by: null, subject_id: null, source_ref: null, confidence: null },
      case_subjects: { label: null, source_ref: null, created_by_user_id: null },
      operational_cases: { runtime_authority: null },
      work_items: {
        status: "todo",
        version: 1,
        attempt_count: 0,
        current_attempt_id: null,
        not_before: null,
        blocked_reason: null,
        result_jsonb: null,
      },
    },
    uniqueIndexes: [
      {
        table: "operational_case_events",
        columns: ["case_id", "payload_jsonb->>wake_key"],
        where: (row) => (row.payload_jsonb as Record<string, unknown> | undefined)?.kind === "supervisor_reconsidered",
      },
      { table: "work_items", columns: ["case_id", "idempotency_key"] },
    ],
  });
}

/** What the page's `data-*` attributes encode for one view (page.tsx, CaseCard). */
function captureOf(view: RankedPortfolioView, name: "org" | "mine", status: string): PageCapture {
  return {
    view: name,
    rankingStatus: status,
    entries: [...view.entries, ...view.suppressed].map((e) => ({
      caseId: e.case.id,
      section: e.section,
      kind: e.attention.length > 0 ? "governed" : e.contextual ? "contextual" : "none",
      rank: e.rank,
      visible: e.presentation.visible,
      predicates: e.attention.map((a) => a.predicate),
      claimRefs: e.contextual
        ? [e.contextual.why, e.contextual.what_gu_needs, e.contextual.why_now].flatMap((c) => c.refs.map((r) => `${r.kind}:${r.id}`))
        : [],
    })),
  };
}

async function main(): Promise<void> {
  console.log("verify-portfolio-ranking smoke selftest (R1 SL-12)");
  const dir = mkdtempSync(path.join(tmpdir(), "sl12-smoke-"));
  const file = (name: string) => path.join(dir, name);
  const fake = harness();
  const db = fake.client;
  const now = new Date();
  let manifest!: RunManifest;
  let governedCaseId = "";

  await t("activation records the flag as found (absent) BEFORE turning the ranking on", async () => {
    manifest = await phaseActivateRanking(db, { organizationId: ORG, advisorUserId: ADVISOR, run: "smoke", manifestPath: file("run.json") });
    assert.deepEqual(manifest.flagPrior, { present: false, enabled: false, valueText: null });
    assert.deepEqual(JSON.parse(readFileSync(file("run.json"), "utf8")).flagPrior, manifest.flagPrior, "on disk first");
    const flag = fake.tables.organization_feature_flags.find((f) => f.flag_key === "portfolio_contextual_ranking");
    assert.equal(flag?.enabled, true);
  });

  await t("seeds: SL-7's governed Case, then ONE contextual Case with no governed predicate and a null model id", async () => {
    await seedGovernedCase(db, { organizationId: ORG, advisorUserId: ADVISOR, run: "smoke-sl7", out: file("sl7-seed.json") });
    governedCaseId = JSON.parse(readFileSync(file("sl7-seed.json"), "utf8")).caseId;
    const seeded = await phaseSeed(db, manifest, now);
    manifest = { ...manifest, seededCaseId: seeded };
    const opCase = fake.tables.operational_cases.find((c) => c.id === seeded)!;
    assert.equal(opCase.runtime_authority, "legacy");
    assert.equal(fake.tables.work_items.filter((w) => w.case_id === seeded).length, 0, "no work");
    const reconsidered = fake.tables.operational_case_events.find(
      (e) => e.case_id === seeded && (e.payload_jsonb as Record<string, unknown>).kind === "supervisor_reconsidered"
    )!;
    assert.equal((reconsidered.payload_jsonb as Record<string, unknown>).model_id, null);
    await assert.rejects(phaseSeed(db, manifest, now), /already has a controlled Case/);
  });

  let orgCapture!: PageCapture;
  await t("checkpoint → the advisor's session (page + chat) → checkpoint → verify: every check passes", async () => {
    const t0 = await takeCheckpoint(db, manifest, "t0", now);
    assert.deepEqual(t0.mustSurface[governedCaseId], ["blocked_on_human", "due_commitment"]);
    assert.deepEqual(t0.mustSurface[manifest.seededCaseId!], []);

    // The page: SL-7's load, then the ranking pass with a judge that admits the
    // seeded Case citing its own reconsideration.
    const loaded = await loadWorkPortfolio({ serviceDb: db, userDb: db, actorUserId: ADVISOR, organizationId: ORG, now });
    assert.equal(loaded.status, "ok");
    if (loaded.status !== "ok") return;
    const frame = buildRankingFrame({ portfolio: loaded.portfolio, snapshots: loaded.snapshots, actorRole: "advisor", now });
    const c = frame.cases.find((x) => x.case_id === manifest.seededCaseId)!.ref;
    const g = frame.cases.find((x) => x.case_id === governedCaseId)!.ref;
    const output: RankingOutput = {
      assessments: [{ case: c, human_intervention_needed_now: true, reason: "Pidió una persona hoy." }],
      items: [
        { case: c, kind: "contextual", priority: 1, why: { text: "Pidió una persona", refs: [`${c}.r1`] }, what_gu_needs: { text: "Llamarle hoy", refs: [c] }, why_now: { text: "Hoy", refs: [`${c}.r1`] } },
        { case: g, kind: "governed", priority: 2 },
      ],
    };
    const judge: PortfolioRankingJudge = { modelId: null, rank: async () => ({ ok: true, output }) };
    const ranked = await rankWorkPortfolio({ serviceDb: db, organizationId: ORG, actor: loaded.portfolio.actor, portfolio: loaded.portfolio, snapshots: loaded.snapshots, judge, now });
    assert.equal(ranked.ranking.status, "ranked");
    orgCapture = captureOf(ranked.organizationWork, "org", ranked.ranking.status);
    const mineCapture = captureOf(ranked.myWork, "mine", ranked.ranking.status);

    // The chat: the tool's own read, then the audit row and usage row the graph
    // and the meter write in the hosted run (the fake has neither wired).
    const summary = await readWorkPortfolioForChat({ serviceDb: db, actorDb: db, actorUserId: ADVISOR, organizationId: ORG, view: "organization", judge, now });
    assert.equal(summary.status, "ok");
    fake.tables.tool_calls.push({
      id: "eeeeeeee-0000-0000-0000-000000000001",
      session_id: SESSION,
      tool_name: "work_portfolio_read",
      arguments_json: { view: "organization" },
      result_json: { status: "ok", result: summary },
      status: "executed",
      created_at: now.toISOString(),
    });
    fake.tables.ai_usage_events.push({
      id: "ffffffff-0000-0000-0000-000000000001",
      occurred_at: now.toISOString(),
      organization_id: ORG,
      user_id: ADVISOR,
      channel: "web",
      status: "ok",
      model_role: "relationship_portfolio_ranking",
    });

    const t1 = await takeCheckpoint(db, manifest, "t1", now);
    const probe: ProbeResult = {
      attempted: true,
      how: "smoke: the fake cannot enforce RLS; the hosted probe runs in the advisor's page",
      reads: [
        { target: "other_organization_cases", status: 200, rows: 0 },
        { target: "other_user_presentation", status: 200, rows: 0 },
      ],
    };
    const { ok, checks } = await phaseVerify(db, manifest, {
      t0,
      t1,
      captures: { organizationWork: orgCapture, myWork: mineCapture, chatAnswer: "Te necesitan dos Casos." },
      probe,
      json: file("evidence.json"),
    });
    assert.deepEqual(checks.filter((x) => !x.ok).map((x) => `${x.label}: ${x.detail ?? ""}`), []);
    assert.equal(ok, true);

    // Negatives through the SAME assembly: a claim citing another Case's row,
    // and a business row changing mid-session.
    const foreign = {
      ...orgCapture,
      entries: orgCapture.entries.map((e) => (e.kind === "contextual" ? { ...e, claimRefs: [`case:${governedCaseId}`] } : e)),
    };
    assert.equal((await phaseVerify(db, manifest, { t0, t1, captures: { organizationWork: foreign, myWork: mineCapture, chatAnswer: "x" }, probe })).ok, false);
    const tampered = { ...t1, containment: { ...t1.containment, case_facts: { rows: 0, digest: "sha256:changed" } } };
    assert.equal((await phaseVerify(db, manifest, { t0, t1: tampered, captures: { organizationWork: orgCapture, myWork: mineCapture, chatAnswer: "x" }, probe })).ok, false);
  });

  await t("the evidence artifact carries digests and counts, never a raw identifier", () => {
    const evidence = readFileSync(file("evidence.json"), "utf8");
    for (const raw of [ORG, ADVISOR, governedCaseId, manifest.seededCaseId!, SESSION]) {
      assert.ok(!evidence.includes(raw), `raw id leaked: ${raw.slice(0, 8)}`);
    }
    const parsed = JSON.parse(evidence);
    assert.equal(parsed.passed, true);
    assert.equal(parsed.session.rankingCalls, 1);
    assert.equal(parsed.flag.scope, "this run only");
  });

  await t("restoration puts the flag back exactly as found — absent", async () => {
    await phaseRestoreRanking(db, manifest);
    assert.equal(fake.tables.organization_feature_flags.some((f) => f.flag_key === "portfolio_contextual_ranking"), false);
    assert.equal(fake.tables.organization_feature_flags.length, 2, "the other flags are untouched");
  });

  await t("…and a flag that was present is restored to its recorded value, not deleted", async () => {
    fake.tables.organization_feature_flags.push({ id: "f3", organization_id: ORG, flag_key: "portfolio_contextual_ranking", enabled: false, value_text: null });
    const second = await phaseActivateRanking(db, { organizationId: ORG, advisorUserId: ADVISOR, run: "smoke-2", manifestPath: file("run2.json") });
    assert.deepEqual(second.flagPrior, { present: true, enabled: false, valueText: null });
    await phaseRestoreRanking(db, second);
    const flag = fake.tables.organization_feature_flags.find((f) => f.flag_key === "portfolio_contextual_ranking");
    assert.equal(flag?.enabled, false);
  });

  console.log(`verify-portfolio-ranking smoke selftest ok — ${passed} checks passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
