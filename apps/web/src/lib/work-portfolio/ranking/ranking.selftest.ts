/**
 * Deterministic selftests for the Work Portfolio v2 contextual ranking pass
 * (R1 SL-12; Technical Plan TD-9 v2 and its v1.16 clarifications).
 *
 * Written BEFORE the merge code they guard (Slice Plan SL-12 ordering
 * constraint 3). The judge is stubbed throughout — on purpose: these tests
 * prove that the deterministic guarantees hold WHATEVER the model says, which
 * is only provable when the test controls what it says. What the model
 * actually judges is the eval's job (`eval/run-ranking-eval.ts`, SA-12.6).
 *
 *   SA-12.1  the pass sees only the authorized snapshot — content and aliases,
 *            never a row id — and nothing outside the Portfolio's candidates;
 *   SA-12.2  every governed item stays present and visible whatever the model
 *            returns: omitted, ranked last, relabelled, or malformed;
 *   SA-12.3  eligibility ≠ priority: a discretionary item may outrank a
 *            governed one, whose presence never depends on its rank;
 *   SA-12.4  a contextual admission is discretionary, not governed: no
 *            obligation, and the person's snooze / hide applies to it;
 *   SA-12.5  a claim is shown only if every ref it cites is the case's own;
 *   SA-12.7  any model failure leaves SL-7's order and reason codes, visibly;
 *   SA-12.8  nothing is persisted;
 *   SA-12.9  the call is bounded and correlated to the Organization;
 *   SA-12.10 a conversation reads the page's own projection, under the
 *            person's own session, and keeps obligations and suggestions apart;
 *   plus flags off ⇒ inert, and the eval set's own consistency.
 */
import assert from "node:assert/strict";
import { currentAiUsageContext } from "@agents/agent";
import {
  ORGANIZATION_FLAG_KEYS,
  PORTFOLIO_RANKING_STATUSES,
  type PortfolioPresentationState,
} from "@agents/types";
import { CONTEXTUAL_COPY, PREDICATE_COPY, RANKING_STATUS_COPY } from "../copy";
import { readWorkPortfolioForChat, summarizePortfolioForChat } from "../chat-summary";
import { loadWorkPortfolio } from "../load";
import { createFakeDb, type FakeDb } from "../../relationship-testing/fake-db";
import type {
  PortfolioCaseSnapshot,
  PortfolioCommitment,
  PortfolioReconsideration,
  PortfolioWork,
} from "../snapshot";
import { buildWorkPortfolio, type WorkPortfolio } from "../projection";
import {
  RANKING_MAX_CASES,
  RANKING_MAX_TEXT_CHARS,
  type PortfolioRankingJudge,
  type RankingInput,
  type RankingJudgeResult,
  type RankingOutput,
} from "./contract";
import { buildRankingFrame } from "./frame";
import { frameFromInput, mergeRanking, needsAttentionOrder } from "./merge";
import { rankWorkPortfolio, type RankedWorkPortfolio } from "./index";
import { loadRankingEvalSet, scoreRankingScenario } from "./eval/run-ranking-eval";

const ORG = "11111111-1111-1111-1111-111111111111";
const ADVISOR = "0a0a0a0a-0000-0000-0000-000000000003";
const NOW = new Date("2026-09-14T15:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let passed = 0;
async function t(label: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ============================================================
// Fixtures
// ============================================================

let seq = 0;
const uuid = () => {
  seq += 1;
  return `cccccccc-0000-0000-0000-${String(seq).padStart(12, "0")}`;
};

function snapshot(
  caseId: string,
  overrides: Partial<PortfolioCaseSnapshot> & { updatedAt?: string; closed?: boolean } = {}
): PortfolioCaseSnapshot {
  const { updatedAt, closed, ...rest } = overrides;
  return {
    case: {
      id: caseId,
      organization_id: ORG,
      user_id: ADVISOR,
      case_type: "lead_opportunity",
      status: "active",
      runtime_authority: "legacy",
      assigned_to_user_id: ADVISOR,
      next_action_at: iso(DAY),
      created_at: iso(-10 * DAY),
      updated_at: updatedAt ?? iso(-DAY),
    },
    closure: closed
      ? { id: uuid(), fact_key: "opportunity.closure", value: { outcome: "won" }, recorded_at: iso(-DAY), subject_id: null }
      : null,
    objective: { id: uuid(), fact_key: "opportunity.objective", value: { objective: "Comprar casa en Zibatá" }, recorded_at: iso(-5 * DAY), subject_id: null },
    case_facts: [],
    reconsiderations: [],
    work: [],
    commitments: [],
    approval_requests: [],
    approval_decisions: [],
    authority_conflict: null,
    effect_operations: [],
    ...rest,
  };
}

function dueCommitment(): PortfolioCommitment {
  const subject = uuid();
  const fact = (fact_key: string, value: unknown) => ({ id: uuid(), fact_key, value, recorded_at: iso(-3 * DAY), subject_id: subject });
  return {
    subject_id: subject,
    label: "Enviar la ficha",
    created_at: iso(-3 * DAY),
    status: fact("commitment.status", { status: "open", evidence_refs: [], note: null }),
    actor: fact("commitment.actor", { actor: "advisor" }),
    due: fact("commitment.due", { due_at: iso(-HOUR), basis: "stated", due_expression: null }),
    expected_outcome: fact("commitment.expected_outcome", { expected_outcome: "Enviar la ficha" }),
  };
}

function openWork(): PortfolioWork {
  return {
    id: uuid(),
    work_type: "prepare_comparison",
    status: "todo",
    origin: "agent_proposed",
    blocked_reason: null,
    purpose: "Comparar tres casas",
    created_at: iso(-DAY),
    updated_at: iso(-DAY),
  };
}

function settled(yieldPosture: string, at = iso(-HOUR)): PortfolioReconsideration {
  return {
    wake_key: `scheduled:${at}`,
    claim_event_id: uuid(),
    claimed_at: at,
    posture: "wait",
    rationale: "El prospecto pidió tiempo.",
    diagnosis: "Esperando al prospecto.",
    uncertainty: null,
    next_action_at: iso(DAY),
    settlement: {
      event_id: uuid(),
      settled_at: at,
      yield_posture: yieldPosture as NonNullable<PortfolioReconsideration["settlement"]>["yield_posture"],
      proposed_work_ids: [],
      commitment_subject_ids: [],
    },
  };
}

interface Fixture {
  governed: PortfolioCaseSnapshot;
  quiet: PortfolioCaseSnapshot;
  waiting: PortfolioCaseSnapshot;
  closed: PortfolioCaseSnapshot;
  snapshots: PortfolioCaseSnapshot[];
}

function fixture(): Fixture {
  const governed = snapshot(uuid(), { commitments: [dueCommitment()], updatedAt: iso(-3 * HOUR) });
  const work = openWork();
  const quiet = snapshot(uuid(), {
    work: [work],
    reconsiderations: [{ ...settled("work_underway"), posture: "work" }],
    updatedAt: iso(-HOUR),
  });
  const waiting = snapshot(uuid(), { reconsiderations: [settled("waiting_for_prospect")], updatedAt: iso(-2 * HOUR) });
  const closed = snapshot(uuid(), { closed: true, updatedAt: iso(-30 * 60_000) });
  return { governed, quiet, waiting, closed, snapshots: [governed, quiet, waiting, closed] };
}

function portfolioOf(snapshots: readonly PortfolioCaseSnapshot[], presentation: PortfolioPresentationState[] = []): WorkPortfolio {
  return buildWorkPortfolio({ actor: { userId: ADVISOR, role: "advisor" }, snapshots, presentation, now: NOW });
}

function flagsDb(ranking: boolean): FakeDb {
  const flags: Array<Record<string, unknown>> = [
    { id: "f1", organization_id: ORG, flag_key: ORGANIZATION_FLAG_KEYS.relationshipOps, enabled: true, value_text: null },
  ];
  if (ranking) {
    flags.push({ id: "f2", organization_id: ORG, flag_key: ORGANIZATION_FLAG_KEYS.portfolioContextualRanking, enabled: true, value_text: null });
  }
  return createFakeDb({ tables: { organization_feature_flags: flags } });
}

function stubJudge(
  answer: RankingJudgeResult | ((input: RankingInput, signal: AbortSignal) => Promise<RankingJudgeResult>)
): PortfolioRankingJudge & { calls: RankingInput[] } {
  const calls: RankingInput[] = [];
  return {
    calls,
    modelId: null,
    async rank(input, signal) {
      calls.push(input);
      return typeof answer === "function" ? answer(input, signal) : answer;
    },
  };
}

const ok = (output: RankingOutput): RankingJudgeResult => ({ ok: true, output });
const claim = (text: string, refs: string[]) => ({ text, refs });

async function rank(
  fx: Fixture,
  judge: PortfolioRankingJudge,
  opts: { ranking?: boolean; presentation?: PortfolioPresentationState[]; timeoutMs?: number } = {}
): Promise<{ ranked: RankedWorkPortfolio; db: FakeDb; portfolio: WorkPortfolio }> {
  const db = flagsDb(opts.ranking ?? true);
  const portfolio = portfolioOf(fx.snapshots, opts.presentation);
  const ranked = await rankWorkPortfolio({
    serviceDb: db.client,
    organizationId: ORG,
    actor: { userId: ADVISOR, role: "advisor" },
    portfolio,
    snapshots: fx.snapshots,
    judge,
    now: NOW,
    timeoutMs: opts.timeoutMs,
  });
  return { ranked, db, portfolio };
}

const ids = (entries: ReadonlyArray<{ case: { id: string } }>) => entries.map((e) => e.case.id);

/** The frame alias of a Case in this fixture (governed first, then by recency). */
function aliasOf(fx: Fixture, caseId: string): string {
  const frame = buildRankingFrame({ portfolio: portfolioOf(fx.snapshots), snapshots: fx.snapshots, actorRole: "advisor", now: NOW });
  const found = frame.cases.find((c) => c.case_id === caseId);
  assert.ok(found, "the case is a ranking candidate");
  return found.ref;
}

// ============================================================
// Suite
// ============================================================

async function main(): Promise<void> {
  console.log("\nSA-12.1 — the pass sees only the authorized snapshot, as content and aliases");

  await t("candidates are the Portfolio's own entries: governed first, then open Cases by recency; closed Cases never", () => {
    const fx = fixture();
    const frame = buildRankingFrame({ portfolio: portfolioOf(fx.snapshots), snapshots: fx.snapshots, actorRole: "advisor", now: NOW });
    assert.deepEqual(
      frame.cases.map((c) => c.case_id),
      [fx.governed.case.id, fx.quiet.case.id, fx.waiting.case.id]
    );
    assert.deepEqual(frame.cases.map((c) => c.governed), [true, false, false]);
    assert.ok(!frame.cases.some((c) => c.case_id === fx.closed.case.id), "an Outcome is not attention");
  });

  await t("the model's input carries no row id, no Organization and no person — only content and aliases", () => {
    const fx = fixture();
    const frame = buildRankingFrame({ portfolio: portfolioOf(fx.snapshots), snapshots: fx.snapshots, actorRole: "advisor", now: NOW });
    const text = JSON.stringify(frame.input);
    assert.ok(!UUID.test(text), "no UUID reaches the model");
    assert.ok(!text.includes(ORG) && !text.includes(ADVISOR));
    assert.deepEqual(frame.input.cases.map((c) => c.ref), ["c1", "c2", "c3"]);
  });

  await t("every alias maps back to the durable row it stands for", () => {
    const fx = fixture();
    const frame = buildRankingFrame({ portfolio: portfolioOf(fx.snapshots), snapshots: fx.snapshots, actorRole: "advisor", now: NOW });
    const quiet = frame.cases.find((c) => c.case_id === fx.quiet.case.id)!;
    assert.deepEqual(quiet.refs[quiet.ref], { kind: "case", id: fx.quiet.case.id });
    assert.deepEqual(quiet.refs[`${quiet.ref}.w1`], { kind: "work_item", id: fx.quiet.work[0].id });
    assert.deepEqual(quiet.refs[`${quiet.ref}.r1`], {
      kind: "case_event",
      id: fx.quiet.reconsiderations[0].claim_event_id,
      event_kind: "supervisor_reconsidered",
    });
  });

  console.log("\nSA-12.9 — bounded input");

  await t("more candidates than the bound: the input is cut, governed Cases first", () => {
    const governed = [snapshot(uuid(), { commitments: [dueCommitment()] }), snapshot(uuid(), { commitments: [dueCommitment()] })];
    const quiet = Array.from({ length: 50 }, (_, i) => snapshot(uuid(), { updatedAt: iso(-(i + 1) * HOUR) }));
    const snapshots = [...quiet, ...governed];
    const frame = buildRankingFrame({ portfolio: portfolioOf(snapshots), snapshots, actorRole: "advisor", now: NOW });
    assert.equal(frame.input.cases.length, RANKING_MAX_CASES);
    assert.deepEqual(frame.cases.slice(0, 2).map((c) => c.governed), [true, true]);
  });

  await t("a long text is cut at the bound, and says it was cut", () => {
    const snap = snapshot(uuid(), {
      case_facts: [{ id: uuid(), fact_key: "opportunity.notes", value: { text: "x".repeat(2000) }, recorded_at: iso(-DAY), subject_id: null }],
    });
    const frame = buildRankingFrame({ portfolio: portfolioOf([snap]), snapshots: [snap], actorRole: "advisor", now: NOW });
    const value = frame.input.cases[0].facts[0].value;
    assert.ok(value.length <= RANKING_MAX_TEXT_CHARS + 20, `bounded — was ${value.length}`);
    assert.ok(value.endsWith("(truncated)"));
  });

  console.log("\nSA-12.2 — the governed floor holds whatever the model returns");

  await t("a model that OMITS the governed Case: it is still in Needs Attention, after the ranked ones", async () => {
    const fx = fixture();
    const q = aliasOf(fx, fx.quiet.case.id);
    const { ranked } = await rank(
      fx,
      stubJudge(ok({ items: [{ case: q, kind: "contextual", priority: 1, why: claim("w", [q]), what_gu_needs: claim("n", [`${q}.w1`]), why_now: claim("t", [`${q}.r1`]) }] }))
    );
    const attention = ranked.organizationWork.entries.filter((e) => e.section === "needs_attention");
    assert.deepEqual(ids(attention), [fx.quiet.case.id, fx.governed.case.id]);
    assert.equal(ranked.ranking.status, "ranked");
    assert.equal(ranked.ranking.diagnostics.governed_unranked, 1);
  });

  await t("a model that ranks the governed Case LAST, or RELABELS it contextual: it stays governed and present", async () => {
    const fx = fixture();
    const g = aliasOf(fx, fx.governed.case.id);
    const { ranked } = await rank(fx, stubJudge(ok({ items: [{ case: g, kind: "contextual", priority: 99 }] })));
    const entry = ranked.organizationWork.entries.find((e) => e.case.id === fx.governed.case.id)!;
    assert.equal(entry.section, "needs_attention");
    assert.ok(entry.attention.length > 0, "still the governed need SL-7 found");
    assert.equal(entry.contextual, null, "a governed Case is never turned into a discretionary one");
    assert.equal(entry.presentation.visible, true);
  });

  await t("MALFORMED output: SL-7's order stands, every governed Case present", async () => {
    const fx = fixture();
    const { ranked, portfolio } = await rank(fx, stubJudge({ ok: false, reason: "invalid_output" }));
    assert.equal(ranked.ranking.status, "invalid_output");
    assert.deepEqual(ids(ranked.organizationWork.entries), ids(portfolio.organizationWork.entries));
  });

  await t("an unknown case alias in the answer is ignored and counted, never resolved to a Case", () => {
    const frame = frameFromInput(minimalInput());
    const merged = mergeRanking(frame, { items: [{ case: "c99", kind: "contextual", priority: 1, why: claim("w", ["c99"]), what_gu_needs: claim("n", ["c99"]), why_now: claim("t", ["c99"]) }] });
    assert.equal(merged.contextual.size, 0);
    assert.equal(merged.diagnostics.unknown_cases, 1);
  });

  await t("the merge never admits a GOVERNED case contextually, even with fully grounded claims", () => {
    const frame = frameFromInput(minimalInput());
    const merged = mergeRanking(frame, {
      items: [{ case: "c1", kind: "contextual", priority: 1, why: claim("w", ["c1.f1"]), what_gu_needs: claim("n", ["c1"]), why_now: claim("t", ["c1.a1"]) }],
    });
    assert.equal(merged.contextual.has("c1"), false, "governed stays governed at the merge, not only at the view");
    assert.equal(merged.priorities.get("c1"), 1, "its rank is still honoured");
    assert.equal(merged.diagnostics.relabelled_governed, 1);
  });

  await t("a model claiming a NON-governed Case is governed creates nothing", () => {
    const frame = frameFromInput(minimalInput());
    const merged = mergeRanking(frame, { items: [{ case: "c2", kind: "governed", priority: 1 }] });
    assert.equal(merged.contextual.size, 0);
    assert.deepEqual(needsAttentionOrder(frame, merged), ["c1"], "only the real governed case is in the floor");
  });

  console.log("\nSA-12.3 — eligibility is not priority");

  await t("a discretionary item may outrank a governed one; the governed one stays present", async () => {
    const fx = fixture();
    const g = aliasOf(fx, fx.governed.case.id);
    const q = aliasOf(fx, fx.quiet.case.id);
    const { ranked } = await rank(
      fx,
      stubJudge(ok({
        items: [
          { case: g, kind: "governed", priority: 2 },
          { case: q, kind: "contextual", priority: 1, why: claim("w", [`${q}.r1`]), what_gu_needs: claim("n", [`${q}.w1`]), why_now: claim("t", [q]) },
        ],
      }))
    );
    const attention = ranked.organizationWork.entries.filter((e) => e.section === "needs_attention");
    assert.deepEqual(ids(attention), [fx.quiet.case.id, fx.governed.case.id]);
    assert.deepEqual(attention.map((e) => e.rank), [1, 2]);
  });

  console.log("\nSA-12.4 — discretionary is not governed");

  await t("an admitted Case joins Needs Attention as contextual, with no governed need and no obligation", async () => {
    const fx = fixture();
    const q = aliasOf(fx, fx.quiet.case.id);
    const { ranked } = await rank(
      fx,
      stubJudge(ok({ items: [{ case: q, kind: "contextual", priority: 1, why: claim("Riesgo de perder al prospecto", [`${q}.r1`]), what_gu_needs: claim("Una llamada hoy", [q]), why_now: claim("Pidió hablar hoy", [`${q}.r1`]) }] }))
    );
    const entry = ranked.organizationWork.entries.find((e) => e.case.id === fx.quiet.case.id)!;
    assert.equal(entry.section, "needs_attention");
    assert.deepEqual(entry.attention, [], "no AttentionProjection is invented for it");
    assert.equal(entry.contextual?.must_surface, false);
    assert.equal(entry.contextual?.kind, "contextual");
    assert.equal(entry.contextual?.why.text, "Riesgo de perder al prospecto");
  });

  await t("the person's HIDE applies to a contextual item — it moves to their hidden list — but not to a governed one", async () => {
    const fx = fixture();
    const q = aliasOf(fx, fx.quiet.case.id);
    const hide = (caseId: string): PortfolioPresentationState => ({
      id: uuid(), user_id: ADVISOR, organization_id: ORG, subject_kind: "case", subject_id: caseId,
      seen_at: null, snooze_until: null, hidden_at: iso(-HOUR), pinned: false, created_at: iso(-HOUR), updated_at: iso(-HOUR),
    });
    const { ranked } = await rank(
      fx,
      stubJudge(ok({ items: [{ case: q, kind: "contextual", priority: 1, why: claim("w", [q]), what_gu_needs: claim("n", [q]), why_now: claim("t", [q]) }] })),
      { presentation: [hide(fx.quiet.case.id), hide(fx.governed.case.id)] }
    );
    assert.ok(ids(ranked.organizationWork.suppressed).includes(fx.quiet.case.id), "discretionary: the hide holds");
    assert.ok(ids(ranked.organizationWork.entries).includes(fx.governed.case.id), "governed: still shown (SL-7's exemption)");
  });

  console.log("\nSA-12.5 — a claim is shown only if every ref it cites is the case's own");

  await t("citing ANOTHER case's alias, or one that does not exist, drops the admission", () => {
    const frame = frameFromInput(minimalInput());
    const merged = mergeRanking(frame, {
      items: [
        { case: "c2", kind: "contextual", priority: 1, why: claim("w", ["c1.f1"]), what_gu_needs: claim("n", ["c2"]), why_now: claim("t", ["c2.r1"]) },
        { case: "c3", kind: "contextual", priority: 2, why: claim("w", ["c3.f9"]), what_gu_needs: claim("n", ["c3"]), why_now: claim("t", ["c3"]) },
      ],
    });
    assert.equal(merged.contextual.size, 0);
    assert.equal(merged.diagnostics.dropped_admissions, 2);
    assert.ok(merged.diagnostics.ungrounded_claims >= 2);
  });

  await t("a contextual answer missing any of WHY / WHAT GU NEEDS / WHY NOW is not admitted", () => {
    const frame = frameFromInput(minimalInput());
    const merged = mergeRanking(frame, { items: [{ case: "c2", kind: "contextual", priority: 1, why: claim("w", ["c2"]), what_gu_needs: claim("n", ["c2"]) }] });
    assert.equal(merged.contextual.size, 0);
  });

  await t("a grounded admission keeps the model's words and the rows they cite", () => {
    const frame = frameFromInput(minimalInput());
    const merged = mergeRanking(frame, {
      items: [{ case: "c2", kind: "contextual", priority: 1, why: claim("Molestia registrada", ["c2.r1"]), what_gu_needs: claim("Llamar", ["c2"]), why_now: claim("Hoy", ["c2.r1"]) }],
    });
    const admitted = merged.contextual.get("c2");
    assert.ok(admitted);
    assert.equal(admitted.why.text, "Molestia registrada");
    assert.deepEqual(admitted.why.refs, [frame.cases[1].refs["c2.r1"]]);
  });

  console.log("\nSA-12.7 — any model failure leaves SL-7's order, visibly");

  for (const [label, judge, status] of [
    ["the judge THROWS", stubJudge(async () => { throw new Error("boom"); }), "model_error"],
    ["no model configured", stubJudge({ ok: false, reason: "model_unavailable" }), "model_unavailable"],
    ["the provider fails", stubJudge({ ok: false, reason: "model_error" }), "model_error"],
  ] as const) {
    await t(`${label} ⇒ status ${status}, SL-7's order exactly, nothing contextual`, async () => {
      const fx = fixture();
      const { ranked, portfolio } = await rank(fx, judge);
      assert.equal(ranked.ranking.status, status);
      assert.deepEqual(ids(ranked.organizationWork.entries), ids(portfolio.organizationWork.entries));
      assert.ok(ranked.organizationWork.entries.every((e) => e.contextual === null && e.rank === null));
    });
  }

  await t("a judge that outlives the timeout ⇒ status timeout, SL-7's order", async () => {
    const fx = fixture();
    const slow = stubJudge(
      (_input, signal) =>
        new Promise<RankingJudgeResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
        })
    );
    const { ranked, portfolio } = await rank(fx, slow, { timeoutMs: 25 });
    assert.equal(ranked.ranking.status, "timeout");
    assert.deepEqual(ids(ranked.organizationWork.entries), ids(portfolio.organizationWork.entries));
  });

  console.log("\nflags off ⇒ inert; no candidates ⇒ no call");

  await t("with the ranking flag off, the judge is never called and SL-7's order stands", async () => {
    const fx = fixture();
    const judge = stubJudge(ok({ items: [] }));
    const { ranked, portfolio } = await rank(fx, judge, { ranking: false });
    assert.equal(judge.calls.length, 0);
    assert.equal(ranked.ranking.status, "disabled");
    assert.deepEqual(ids(ranked.organizationWork.entries), ids(portfolio.organizationWork.entries));
  });

  await t("a Portfolio with nothing open to rank never calls the model", async () => {
    const closedOnly = snapshot(uuid(), { closed: true });
    const judge = stubJudge(ok({ items: [] }));
    const db = flagsDb(true);
    const ranked = await rankWorkPortfolio({
      serviceDb: db.client, organizationId: ORG, actor: { userId: ADVISOR, role: "advisor" },
      portfolio: portfolioOf([closedOnly]), snapshots: [closedOnly], judge, now: NOW,
    });
    assert.equal(judge.calls.length, 0);
    assert.equal(ranked.ranking.status, "no_candidates");
  });

  console.log("\nSA-12.8 — nothing is persisted; SA-12.9 — the call is correlated");

  await t("the pass reads the flag and writes nothing", async () => {
    const fx = fixture();
    const q = aliasOf(fx, fx.quiet.case.id);
    const db = flagsDb(true);
    const before = JSON.stringify(db.tables);
    await rankWorkPortfolio({
      serviceDb: db.client, organizationId: ORG, actor: { userId: ADVISOR, role: "advisor" },
      portfolio: portfolioOf(fx.snapshots), snapshots: fx.snapshots, now: NOW,
      judge: stubJudge(ok({ items: [{ case: q, kind: "contextual", priority: 1, why: claim("w", [q]), what_gu_needs: claim("n", [q]), why_now: claim("t", [q]) }] })),
    });
    assert.equal(JSON.stringify(db.tables), before, "no row changed");
    assert.deepEqual([...new Set(db.queries.map((q) => q.table))], ["organization_feature_flags"]);
  });

  await t("the model call runs under the Organization's AI-usage context", async () => {
    const fx = fixture();
    let seen: Record<string, unknown> | null = null;
    await rank(
      fx,
      stubJudge(async () => {
        seen = (currentAiUsageContext()?.context ?? null) as Record<string, unknown> | null;
        return { ok: true, output: { items: [] } };
      })
    );
    assert.ok(seen, "an ambient context exists during the call");
    assert.equal((seen as Record<string, unknown>).organizationId, ORG);
    assert.equal((seen as Record<string, unknown>).userId, ADVISOR);
    assert.equal((seen as Record<string, unknown>).channel, "web");
  });

  console.log("\nSA-12.10 — a conversation reads the page's own projection");

  await t("the chat read lists the Cases the page lists, in the page's order, read under the person's own session — and writes nothing", async () => {
    const a = uuid();
    const b = uuid();
    const rows = [loaderCaseRow(a, iso(-HOUR)), loaderCaseRow(b, iso(-2 * HOUR))];

    // The page's path: SL-7's loader, then the ranking pass.
    const pageService = chatServiceDb();
    const loaded = await loadWorkPortfolio({
      serviceDb: pageService.client, userDb: createFakeDb({ tables: { operational_cases: rows } }).client,
      actorUserId: ADVISOR, organizationId: ORG, now: NOW,
    });
    assert.equal(loaded.status, "ok");
    if (loaded.status !== "ok") return;
    const alias = buildRankingFrame({ portfolio: loaded.portfolio, snapshots: loaded.snapshots, actorRole: "advisor", now: NOW })
      .cases.find((c) => c.case_id === b)!.ref;
    const answer = ok({
      items: [{ case: alias, kind: "contextual", priority: 1, why: claim("Pidió una llamada", [alias]), what_gu_needs: claim("Llamar hoy", [alias]), why_now: claim("Lo pidió para hoy", [alias]) }],
    });
    const page = await rankWorkPortfolio({
      serviceDb: pageService.client, organizationId: ORG, actor: loaded.portfolio.actor,
      portfolio: loaded.portfolio, snapshots: loaded.snapshots, judge: stubJudge(answer), now: NOW,
    });

    // The conversation's path, over identical data.
    const service = chatServiceDb();
    const user = createFakeDb({ tables: { operational_cases: rows } });
    const summary = await readWorkPortfolioForChat({
      serviceDb: service.client, actorDb: user.client, actorUserId: ADVISOR, organizationId: ORG,
      view: "mine", judge: stubJudge(answer), now: NOW,
    });
    assert.equal(summary.status, "ok");
    if (summary.status !== "ok") return;
    assert.deepEqual(
      [...summary.needs_attention.map((n) => n.case_id), ...summary.others.map((o) => o.case_id)],
      ids(page.myWork.entries),
      "the same Cases, in the same order"
    );
    assert.deepEqual(summary.needs_attention.map((n) => [n.case_id, n.kind, n.rank]), [[b, "contextual", 1]]);
    assert.ok(user.reads.includes("operational_cases"), "Cases are read under the person's own session");
    assert.ok(!service.reads.includes("operational_cases"), "never with the service role");
    assert.deepEqual([...service.writes, ...user.writes], []);
  });

  await t("governed obligations and Gu's suggestions stay apart; a hidden Case is only counted", async () => {
    const fx = fixture();
    const q = aliasOf(fx, fx.quiet.case.id);
    const hidden: PortfolioPresentationState = {
      id: uuid(), user_id: ADVISOR, organization_id: ORG, subject_kind: "case", subject_id: fx.waiting.case.id,
      seen_at: null, snooze_until: null, hidden_at: iso(-HOUR), pinned: false, created_at: iso(-HOUR), updated_at: iso(-HOUR),
    };
    const { ranked } = await rank(
      fx,
      stubJudge(ok({ items: [{ case: q, kind: "contextual", priority: 1, why: claim("Riesgo", [`${q}.r1`]), what_gu_needs: claim("Una llamada", [q]), why_now: claim("Hoy", [`${q}.r1`]) }] })),
      { presentation: [hidden] }
    );
    const summary = summarizePortfolioForChat(ranked, "organization");
    assert.equal(summary.order, RANKING_STATUS_COPY.ranked);
    assert.deepEqual(
      summary.needs_attention.map((n) => n.case_id),
      ids(ranked.organizationWork.entries.filter((e) => e.section === "needs_attention"))
    );
    const byId = new Map(summary.needs_attention.map((n) => [n.case_id, n]));
    const governed = byId.get(fx.governed.case.id)!;
    assert.equal(governed.kind, "governed");
    assert.equal(governed.contextual, null);
    assert.ok(governed.governed.length > 0);
    assert.ok(governed.governed.every((g) => Object.values(PREDICATE_COPY).includes(g.need) && g.why && g.what_gu_needs && g.why_now));
    const contextual = byId.get(fx.quiet.case.id)!;
    assert.equal(contextual.kind, "contextual");
    assert.deepEqual(contextual.governed, [], "a suggestion never carries an obligation");
    assert.deepEqual(contextual.contextual, { why: "Riesgo", what_gu_needs: "Una llamada", why_now: "Hoy" });
    assert.equal(summary.hidden_by_you, 1);
    assert.ok(!JSON.stringify(summary).includes(fx.waiting.case.id), "what the person hid is counted, not listed");
  });

  await t("when the model fails, the chat names the deterministic order and invents nothing", async () => {
    const fx = fixture();
    const { ranked } = await rank(fx, stubJudge({ ok: false, reason: "model_error" }));
    const summary = summarizePortfolioForChat(ranked, "organization");
    assert.ok(summary.order.startsWith("Orden determinista"));
    assert.ok(summary.needs_attention.length > 0);
    assert.ok(summary.needs_attention.every((n) => n.kind === "governed" && n.rank === null && n.contextual === null));
  });

  await t("no membership, or Relationship Operations off: a refusal with a hint — no Case read, no model call", async () => {
    for (const [options, status] of [
      [{ member: false }, "no_membership"],
      [{ relationshipOps: false }, "inert"],
    ] as const) {
      const service = chatServiceDb(options);
      const user = createFakeDb({ tables: { operational_cases: [loaderCaseRow(uuid(), iso(-HOUR))] } });
      const judge = stubJudge(ok({ items: [] }));
      const result = await readWorkPortfolioForChat({
        serviceDb: service.client, actorDb: user.client, actorUserId: ADVISOR, organizationId: ORG, view: "mine", judge, now: NOW,
      });
      assert.equal(result.status, status);
      assert.ok("hint" in result && /do not retry/i.test(result.hint));
      assert.deepEqual(user.reads, [], `${status}: no Case read`);
      assert.equal(judge.calls.length, 0, `${status}: no model call`);
    }
  });

  console.log("\nthe viewer is told which order they see");

  await t("every ranking status has copy, and every non-ranked one says the order is the deterministic one", () => {
    for (const status of PORTFOLIO_RANKING_STATUSES) {
      const text = RANKING_STATUS_COPY[status];
      assert.ok(text && text.length > 10, `copy for ${status}`);
      if (status !== "ranked") assert.ok(text.startsWith("Orden determinista"), `${status} names the fallback`);
    }
    assert.ok(CONTEXTUAL_COPY.note.includes("no es una obligación"), "a contextual item never reads as governed");
  });

  console.log("\neval set");

  await t("both eval sets carry the ratified bars, unchanged, and are internally consistent", () => {
    const main = loadRankingEvalSet("main");
    const holdout = loadRankingEvalSet("holdout");
    for (const [name, set] of [["main", main], ["holdout", holdout]] as const) {
      assert.equal(set.failure_rate_bar, 0.2, name);
      assert.equal(set.unsupported_attention_bar, 0, name);
      assert.equal(set.floor_violation_bar, 0, name);
      assert.equal(set.batches, 2, name);
      assert.equal(set.runs_per_batch, 5, name);
      const seen = new Set<string>();
      for (const s of set.scenarios) {
        assert.ok(!seen.has(s.id), `duplicate scenario ${s.id}`);
        seen.add(s.id);
        const refs = s.input.cases.map((c) => c.ref);
        assert.deepEqual(
          s.input.cases.filter((c) => c.governed.length > 0).map((c) => c.ref).sort(),
          [...s.governed].sort(),
          `${s.id}: governed list matches the input`
        );
        for (const ref of [...s.expect_contextual, ...s.must_not_admit, ...s.order_pairs.flat()]) {
          assert.ok(refs.includes(ref), `${s.id}: ${ref} is a case of the scenario`);
        }
        assert.ok(!s.expect_contextual.some((r) => s.must_not_admit.includes(r)), `${s.id}: expect and forbid are disjoint`);
        assert.ok(!s.expect_contextual.some((r) => s.governed.includes(r)), `${s.id}: a governed case cannot be admitted contextually`);
        assert.equal(typeof s.rubric, "string");
      }
      const covered = new Set(set.scenarios.flatMap((s) => s.covers ?? []));
      for (const required of ["no_inflation", "no_attractiveness", "contextual_admission", "eligibility_not_priority", "untrusted_content", "governed_floor", "evidence_too_thin"]) {
        assert.ok(covered.has(required), `the ${name} set covers ${required}`);
      }
    }
    // The holdout measures the same contract at the same granularity, with
    // different situations: one failure weighs the same against the 20% bar.
    assert.equal(holdout.scenarios.length, main.scenarios.length);
    const mainIds = new Set(main.scenarios.map((s) => s.id));
    assert.ok(holdout.scenarios.every((s) => !mainIds.has(s.id)), "no scenario is shared");
  });

  await t("the scorer counts an unsupported admission, a missed one and a pair out of order — and nothing when right", () => {
    const set = loadRankingEvalSet();
    const scenario = set.scenarios.find((s) => s.id === "eligibility-is-not-priority")!;
    const good = scoreRankingScenario(scenario, ok({
      items: [
        { case: "c2", kind: "contextual", priority: 1, why: claim("w", ["c2.r1"]), what_gu_needs: claim("n", ["c2"]), why_now: claim("t", ["c2.r1"]) },
        { case: "c1", kind: "governed", priority: 2 },
      ],
    }));
    assert.deepEqual([good.violations, good.unsupported, good.floor], [[], [], []]);
    const bad = scoreRankingScenario(scenario, ok({ items: [{ case: "c1", kind: "governed", priority: 1 }] }));
    assert.ok(bad.violations.some((v) => v.includes("c2")), "the expected admission is missing and the pair is wrong");
    const quiet = set.scenarios.find((s) => s.id === "quiet-portfolio-no-inflation")!;
    const inflated = scoreRankingScenario(quiet, ok({
      items: [{ case: "c1", kind: "contextual", priority: 1, why: claim("w", ["c1"]), what_gu_needs: claim("n", ["c1"]), why_now: claim("t", ["c1"]) }],
    }));
    assert.equal(inflated.unsupported.length, 1);
    const none = scoreRankingScenario(quiet, { ok: false, reason: "model_error" });
    assert.ok(none.violations[0].includes("no judgment"));
  });

  console.log(`\nwork-portfolio ranking selftest: ${passed} checks passed`);
}

/** A Case row as the actor's own-JWT read returns it (SL-7's loader input). */
function loaderCaseRow(caseId: string, updatedAt: string): Record<string, unknown> {
  return {
    id: caseId, user_id: ADVISOR, organization_id: ORG, case_type: "lead_opportunity", case_type_id: "ct-1",
    status: "active", runtime_authority: "legacy", assigned_to_user_id: ADVISOR, next_action_at: iso(DAY),
    workflow_definition_version: 1, version: 3, context_jsonb: {}, created_at: iso(-10 * DAY), updated_at: updatedAt,
  };
}

/** The service-role side of the loader: the membership, the flags, Work Items. */
function chatServiceDb(options: { member?: boolean; relationshipOps?: boolean } = {}): FakeDb {
  const flags: Array<Record<string, unknown>> = [
    { id: "f2", organization_id: ORG, flag_key: ORGANIZATION_FLAG_KEYS.portfolioContextualRanking, enabled: true, value_text: null },
  ];
  if (options.relationshipOps !== false) {
    flags.push({ id: "f1", organization_id: ORG, flag_key: ORGANIZATION_FLAG_KEYS.relationshipOps, enabled: true, value_text: null });
  }
  return createFakeDb({
    tables: {
      organization_memberships:
        options.member === false ? [] : [{ id: "m1", organization_id: ORG, user_id: ADVISOR, role: "advisor", status: "active" }],
      organization_feature_flags: flags,
      work_items: [],
    },
  });
}

/** Three cases: c1 governed, c2 and c3 not — the merge's unit fixture. */
function minimalInput(): RankingInput {
  return {
    now: NOW.toISOString(),
    actor_role: "advisor",
    cases: [
      { ref: "c1", objective: "a", runtime_authority: "legacy", section: "needs_attention", governed: [{ ref: "c1.a1", predicate: "due_commitment", why: "w", what_gu_needs: "n", why_now: "t" }], facts: [{ ref: "c1.f1", key: "k", value: "v", recorded_at: NOW.toISOString() }], commitments: [], work: [], reconsiderations: [], days_since_update: 0 },
      { ref: "c2", objective: "b", runtime_authority: "legacy", section: "waiting", governed: [], facts: [], commitments: [], work: [], reconsiderations: [{ ref: "c2.r1", at: NOW.toISOString(), posture: "wait", diagnosis: "d", rationale: "r", outcome: null }], days_since_update: 0 },
      { ref: "c3", objective: "c", runtime_authority: "legacy", section: "gu_handling", governed: [], facts: [], commitments: [], work: [], reconsiderations: [], days_since_update: 0 },
    ],
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
