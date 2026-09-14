/**
 * Deterministic selftests for the Work Portfolio v1 (R1 SL-7, the
 * deterministic floor — Technical Plan TD-9).
 *
 * Written BEFORE the modules they guard (Slice Plan SL-7 ordering constraint
 * 3): the TD-9 presentation-cannot-suppress test before the presentation
 * filter, and each predicate's tests with or before the predicate. Each group
 * names the Slice Acceptance assertion it evidences:
 *
 *   SA-7.1  My Work / Organization Work — two projections over one truth;
 *   SA-7.2  authorization before any projection — an unauthorized Case never
 *           enters the candidate set, not even to be filtered afterwards;
 *   SA-7.3  every attention item carries WHY / WHAT GU NEEDS / WHY NOW,
 *           each referenced to durable rows;
 *   SA-7.4  the six must-surface predicates, from truth and never invented —
 *           typed fixtures for the three without a producer and for
 *           `stalled`'s positive case (D4, D5, D7);
 *   SA-7.5  a must-surface item stays visible however it was snoozed or
 *           hidden (TD-9 hard guard);
 *   SA-7.6  the 14-day snooze cap (D6), and no presentation write reaches
 *           business truth;
 *   SA-7.7  seen / snoozed / hidden / pinned do not resolve a need;
 *   SA-7.8  Portfolio actions land in the canonical owning mechanism only;
 *   SA-7.9  assignment never grants approval authority (D3);
 *   SA-7.10 postures are earned from durable state, never invented.
 *
 * Plus the shared baseline: flags off ⇒ inert. SA-7.11 and SA-7.12 are
 * PostgreSQL semantics and live in the DB-backed cross-tenant suite
 * (`packages/db/test-rls/run.ts`), not here — a fake cannot enforce RLS.
 *
 * No model is involved anywhere in SL-7, so there is no eval and no model bar.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeOrgAction } from "@agents/db";
import {
  MUST_SURFACE_PREDICATES,
  MUST_SURFACE_WIRING,
  PORTFOLIO_SNOOZE_CAP_DAYS,
  type AttentionProjection,
  type MustSurfacePredicate,
  type PortfolioPresentationState,
} from "@agents/types";
import { createFakeDb, type FakeDb } from "../relationship-testing/fake-db";
import { resolveCommitmentDue } from "../relationship-supervisor/commitments";
import {
  hitlActionsForInteraction,
  hitlKindForInteraction,
} from "../human-interaction/hitl-adapter";
import type {
  PortfolioApprovalRequest,
  PortfolioCaseSnapshot,
  PortfolioCommitment,
  PortfolioReconsideration,
  PortfolioWork,
} from "./snapshot";
import {
  awaitedHumanAsk,
  commitmentDueState,
  evaluateMustSurface,
  hasValidReentryPath,
  isValidDueInstant,
} from "./must-surface";
import { derivePosture } from "./posture";
import {
  decidePresentation,
  effectiveSnoozeUntil,
  presentationPatchFor,
} from "./presentation";
import { buildWorkPortfolio, canDecideApprovals } from "./projection";
import { PREDICATE_COPY, renderClause } from "./copy";
import { loadWorkPortfolio } from "./load";
import {
  completePortfolioWork,
  decidePortfolioApproval,
  NO_APPROVAL_REQUEST_PRODUCER,
  writePortfolioPresentation,
  type ApprovalRequestSource,
} from "./actions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const OWNER = "0a0a0a0a-0000-0000-0000-000000000001";
const ADMIN = "0a0a0a0a-0000-0000-0000-000000000002";
const ADVISOR = "0a0a0a0a-0000-0000-0000-000000000003";
const ADVISOR_2 = "0a0a0a0a-0000-0000-0000-000000000004";
const REVOKED = "0a0a0a0a-0000-0000-0000-000000000005";
const OUTSIDER = "0a0a0a0a-0000-0000-0000-000000000006";
const CASE_ID = "cccccccc-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-14T15:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let passed = 0;
async function t(label: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ============================================================
// Snapshot fixtures — the typed input contract of the pure rules
// ============================================================

let seq = 0;
const id = (prefix: string) => `${prefix}-${String(++seq).padStart(4, "0")}`;

function work(overrides: Partial<PortfolioWork> = {}): PortfolioWork {
  return {
    id: id("work"),
    work_type: "confirm_budget_with_advisor",
    status: "todo",
    origin: "agent_proposed",
    blocked_reason: null,
    purpose: "Confirmar con el asesor el presupuesto real del prospecto",
    created_at: iso(-2 * DAY),
    updated_at: iso(-2 * DAY),
    ...overrides,
  };
}

function reconsideration(
  yieldPosture: string,
  overrides: {
    proposedWorkIds?: string[];
    commitmentSubjectIds?: string[];
    settled?: boolean;
    at?: string;
    posture?: string;
  } = {}
): PortfolioReconsideration {
  const at = overrides.at ?? iso(-2 * DAY);
  const wakeKey = `scheduled:${at}`;
  return {
    wake_key: wakeKey,
    claim_event_id: id("event"),
    claimed_at: at,
    posture: (overrides.posture ?? "targeted_human_input") as PortfolioReconsideration["posture"],
    rationale: "El prospecto mencionó un presupuesto distinto al registrado.",
    diagnosis: "Presupuesto en conflicto",
    uncertainty: null,
    next_action_at: iso(DAY),
    settlement:
      overrides.settled === false
        ? null
        : {
            event_id: id("event"),
            settled_at: at,
            yield_posture: yieldPosture as NonNullable<
              PortfolioReconsideration["settlement"]
            >["yield_posture"],
            proposed_work_ids: overrides.proposedWorkIds ?? [],
            commitment_subject_ids: overrides.commitmentSubjectIds ?? [],
          },
  };
}

function commitment(
  facts: {
    status?: unknown;
    actor?: unknown;
    due?: unknown;
    expected?: string;
  } = {}
): PortfolioCommitment {
  const subjectId = id("subject");
  const fact = (fact_key: string, value: unknown) =>
    value === undefined
      ? null
      : { id: id("fact"), fact_key, value, recorded_at: iso(-3 * DAY), subject_id: subjectId };
  return {
    subject_id: subjectId,
    label: facts.expected ?? "Enviar tres opciones al prospecto",
    created_at: iso(-3 * DAY),
    status: fact("commitment.status", facts.status ?? { status: "open", evidence_refs: [], note: null }),
    actor: fact("commitment.actor", facts.actor ?? { actor: "advisor" }),
    due: fact(
      "commitment.due",
      facts.due === undefined
        ? { due_at: iso(-HOUR), basis: "stated", due_expression: null }
        : facts.due
    ),
    expected_outcome: fact("commitment.expected_outcome", {
      expected_outcome: facts.expected ?? "Enviar tres opciones al prospecto",
    }),
  };
}

function approvalRequest(overrides: Partial<PortfolioApprovalRequest> = {}): PortfolioApprovalRequest {
  return {
    request_id: id("approval-request"),
    approval_kind: "prospect_message_send",
    decision_subject: "Enviar al prospecto el mensaje preparado con tres opciones",
    consequence: "El mensaje sale por WhatsApp a nombre de la inmobiliaria",
    requested_at: iso(-HOUR),
    requested_by_work_item_id: null,
    evidence_hash: "sha256:basis-1",
    evidence_snapshot: { draft: "…" },
    withdrawn_at: null,
    superseded_by: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PortfolioCaseSnapshot> & {
  caseOverrides?: Partial<PortfolioCaseSnapshot["case"]>;
} = {}): PortfolioCaseSnapshot {
  const { caseOverrides, ...rest } = overrides;
  return {
    case: {
      id: CASE_ID,
      organization_id: ORG,
      user_id: ADVISOR,
      case_type: "lead_opportunity",
      status: "active",
      runtime_authority: "legacy",
      assigned_to_user_id: ADVISOR,
      next_action_at: iso(DAY),
      created_at: iso(-10 * DAY),
      updated_at: iso(-DAY),
      ...caseOverrides,
    },
    closure: null,
    objective: null,
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

/** A Case whose supervisor asked a human question that is still open. */
function blockedOnHumanSnapshot(): { snap: PortfolioCaseSnapshot; ask: PortfolioWork } {
  const ask = work();
  const snap = snapshot({
    work: [ask],
    reconsiderations: [reconsideration("waiting_for_human_input", { proposedWorkIds: [ask.id] })],
  });
  return { snap, ask };
}

function presentationRow(
  overrides: Partial<PortfolioPresentationState> = {}
): PortfolioPresentationState {
  return {
    id: id("presentation"),
    user_id: ADVISOR,
    organization_id: ORG,
    subject_kind: "case",
    subject_id: CASE_ID,
    seen_at: null,
    snooze_until: null,
    hidden_at: null,
    pinned: false,
    created_at: iso(-HOUR),
    updated_at: iso(-HOUR),
    ...overrides,
  };
}

const predicatesOf = (items: readonly AttentionProjection[]) =>
  items.map((item) => item.predicate).sort();

const only = (items: readonly AttentionProjection[], predicate: MustSurfacePredicate) =>
  items.filter((item) => item.predicate === predicate);

// ============================================================
// SA-7.5 — TD-9's hard guard. Written before the filter it guards.
// ============================================================

async function testPresentationCannotSuppressMustSurface(): Promise<void> {
  console.log("SA-7.5 — presentation state cannot suppress a governed obligation (TD-9)");

  await t("TD-9: a snoozed AND hidden pending-approval fixture still surfaces", () => {
    const snap = snapshot({ approval_requests: [approvalRequest()] });
    const attention = evaluateMustSurface(snap, NOW);
    assert.deepEqual(predicatesOf(attention), ["pending_approval"]);

    const row = presentationRow({
      snooze_until: iso(10 * DAY),
      hidden_at: iso(-HOUR),
    });
    const decision = decidePresentation({ mustSurface: attention.length > 0 }, row, NOW);
    assert.equal(decision.visible, true, "must-surface is exempt from snooze and hide");
    assert.equal(decision.exemptBecauseMustSurface, true);
    assert.equal(decision.userSuppression, "hidden", "the user's choice is still reported, not erased");
  });

  await t("a snoozed and hidden due advisor commitment and an open human ask still surface", () => {
    const { snap } = blockedOnHumanSnapshot();
    snap.commitments = [commitment()];
    const attention = evaluateMustSurface(snap, NOW);
    assert.deepEqual(predicatesOf(attention), ["blocked_on_human", "due_commitment"]);
    for (const row of [
      presentationRow({ snooze_until: iso(14 * DAY) }),
      presentationRow({ hidden_at: iso(-DAY) }),
      presentationRow({ snooze_until: iso(3 * DAY), hidden_at: iso(-DAY), pinned: false }),
    ]) {
      assert.equal(decidePresentation({ mustSurface: true }, row, NOW).visible, true);
    }
  });

  await t("predicate computation cannot read presentation state — the snapshot has no place for it", () => {
    const { snap } = blockedOnHumanSnapshot();
    assert.ok(!Object.keys(snap).some((key) => /presentation|snooze|hidden|seen|pinned/.test(key)));
    const before = JSON.stringify(evaluateMustSurface(snap, NOW));
    // Whatever the person did in their own view, the rules see the same truth.
    decidePresentation({ mustSurface: true }, presentationRow({ hidden_at: iso(-HOUR) }), NOW);
    assert.equal(JSON.stringify(evaluateMustSurface(snap, NOW)), before);
  });

  await t("the rule module does not import the presentation module or its table", () => {
    const source = readFileSync(path.join(__dirname, "must-surface.ts"), "utf8");
    assert.ok(!/presentation/i.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
      "must-surface.ts mentions presentation outside a comment");
  });

  await t("a NON-must-surface Case is honestly snoozed or hidden, and returns when the snooze ends", () => {
    const quiet = { mustSurface: false };
    assert.equal(decidePresentation(quiet, null, NOW).visible, true);
    const snoozed = decidePresentation(quiet, presentationRow({ snooze_until: iso(DAY) }), NOW);
    assert.equal(snoozed.visible, false);
    assert.equal(snoozed.userSuppression, "snoozed");
    const expired = decidePresentation(quiet, presentationRow({ snooze_until: iso(-1) }), NOW);
    assert.equal(expired.visible, true, "an elapsed snooze no longer suppresses");
    const hidden = decidePresentation(quiet, presentationRow({ hidden_at: iso(-DAY) }), NOW);
    assert.equal(hidden.visible, false);
    assert.equal(hidden.userSuppression, "hidden");
  });
}

// ============================================================
// SA-7.6 — the 14-day cap, and presentation never reaching business truth
// ============================================================

async function testSnoozeCap(): Promise<void> {
  console.log("\nSA-7.6 — the 14-day snooze cap (D6)");

  await t("a stored snooze beyond the cap is read as ending 14 days after its write", () => {
    const row = presentationRow({ updated_at: iso(-DAY), snooze_until: iso(365 * DAY) });
    assert.equal(effectiveSnoozeUntil(row), iso(-DAY + 14 * DAY));
    const decision = decidePresentation(
      { mustSurface: false },
      row,
      new Date(NOW.getTime() + 13 * DAY + HOUR)
    );
    assert.equal(decision.visible, true, "past the cap the Case returns, whatever was stored");
  });

  await t("a snooze request longer than the cap is refused before any write", () => {
    assert.throws(() => presentationPatchFor({ kind: "snooze", days: PORTFOLIO_SNOOZE_CAP_DAYS + 1 }, NOW));
    assert.throws(() => presentationPatchFor({ kind: "snooze", days: 0 }, NOW));
    const patch = presentationPatchFor({ kind: "snooze", days: PORTFOLIO_SNOOZE_CAP_DAYS }, NOW);
    assert.equal(patch.snooze_until, iso(PORTFOLIO_SNOOZE_CAP_DAYS * DAY));
  });

  await t("PORTFOLIO_SNOOZE_CAP_DAYS matches the M-PRESENTATION migration's clamp and CHECK", () => {
    const dir = path.resolve(__dirname, "..", "..", "..", "..", "..", "packages", "db", "forward", "supabase", "migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_portfolio_presentation_state.sql"));
    assert.ok(file, "M-PRESENTATION migration not found");
    const sql = readFileSync(path.join(dir, file), "utf8");
    const intervals = [...sql.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1]));
    assert.ok(intervals.length >= 3, "clamp comparison, clamp assignment and CHECK");
    assert.ok(intervals.every((days) => days === PORTFOLIO_SNOOZE_CAP_DAYS), `found ${intervals.join(",")}`);
  });
}

// ============================================================
// SA-7.4 — the six predicates (D4, D5, D7). Never from invented urgency.
// ============================================================

async function testPendingApproval(): Promise<void> {
  console.log("\nSA-7.4 pending approval / protected decision — rule and typed fixtures (producer: SL-9)");

  await t("live wiring records the producer gap instead of emulating it", () => {
    assert.equal(MUST_SURFACE_WIRING.pending_approval.wiring, "rule_only");
    assert.equal(MUST_SURFACE_WIRING.authority_conflict.wiring, "rule_only");
    assert.equal(MUST_SURFACE_WIRING.unknown_outcome_effect.wiring, "rule_only");
    assert.deepEqual([...MUST_SURFACE_PREDICATES].sort(), Object.keys(MUST_SURFACE_WIRING).sort());
  });

  await t("a pending request surfaces as an ApprovalRequest pinned to its evidence", () => {
    const request = approvalRequest();
    const [item] = evaluateMustSurface(snapshot({ approval_requests: [request] }), NOW);
    assert.equal(item.predicate, "pending_approval");
    assert.equal(item.interaction.interaction, "approval_request");
    if (item.interaction.interaction !== "approval_request") return;
    assert.equal(item.interaction.evidence_hash, request.evidence_hash);
    assert.equal(item.interaction.approval_kind, request.approval_kind);
  });

  await t("decided from ANY surface — web, Telegram — it exits: the web must not ask again (S4 §13)", () => {
    const request = approvalRequest();
    for (const decision of ["approved", "rejected", "revoked"] as const) {
      const snap = snapshot({
        approval_requests: [request],
        approval_decisions: [
          {
            id: id("approval"),
            approval_kind: request.approval_kind,
            decision,
            decided_at: iso(-HOUR / 2),
            evidence_hash: request.evidence_hash,
            superseded_by: null,
          },
        ],
      });
      assert.equal(only(evaluateMustSurface(snap, NOW), "pending_approval").length, 0, decision);
    }
  });

  await t("a decision on a DIFFERENT basis does not answer this request", () => {
    const request = approvalRequest();
    const snap = snapshot({
      approval_requests: [request],
      approval_decisions: [
        {
          id: id("approval"),
          approval_kind: request.approval_kind,
          decision: "approved",
          decided_at: iso(-HOUR / 2),
          evidence_hash: "sha256:some-other-basis",
          superseded_by: null,
        },
      ],
    });
    assert.equal(only(evaluateMustSurface(snap, NOW), "pending_approval").length, 1);
  });

  await t("a withdrawn or superseded request no longer surfaces", () => {
    assert.equal(
      evaluateMustSurface(snapshot({ approval_requests: [approvalRequest({ withdrawn_at: iso(-60_000) })] }), NOW).length,
      0
    );
    assert.equal(
      evaluateMustSurface(snapshot({ approval_requests: [approvalRequest({ superseded_by: "approval-request-x" })] }), NOW).length,
      0
    );
  });
}

async function testBlockedOnHuman(): Promise<void> {
  console.log("\nSA-7.4 blocked on a human — live (SL-4 settlements + Work Plane)");

  await t("latest settlement waiting_for_human_input with its proposed Work open ⇒ an InformationRequest", () => {
    const { snap, ask } = blockedOnHumanSnapshot();
    const items = only(evaluateMustSurface(snap, NOW), "blocked_on_human");
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.interaction.interaction, "information_request");
    if (item.interaction.interaction === "information_request") {
      assert.equal(item.interaction.work_item_id, ask.id);
      assert.equal(item.interaction.question, ask.purpose);
    }
  });

  await t("the ask stays open through todo, ready, running and review, and exits once the Work is done or cancelled", () => {
    for (const status of ["todo", "ready", "running", "review"] as const) {
      const { snap, ask } = blockedOnHumanSnapshot();
      ask.status = status;
      assert.equal(only(evaluateMustSurface(snap, NOW), "blocked_on_human").length, 1, status);
    }
    for (const status of ["done", "cancelled"] as const) {
      const { snap, ask } = blockedOnHumanSnapshot();
      ask.status = status;
      assert.equal(only(evaluateMustSurface(snap, NOW), "blocked_on_human").length, 0, status);
    }
  });

  await t("a technical block (max_attempts_exhausted) is never 'blocked on a human' (S4 §7.7)", () => {
    const { snap, ask } = blockedOnHumanSnapshot();
    ask.status = "blocked";
    ask.blocked_reason = "max_attempts_exhausted";
    assert.equal(only(evaluateMustSurface(snap, NOW), "blocked_on_human").length, 0);
    const standalone = snapshot({
      work: [work({ status: "blocked", blocked_reason: "max_attempts_exhausted" })],
    });
    assert.equal(evaluateMustSurface(standalone, NOW).length, 0);
  });

  await t("a LATER settlement supersedes the ask; an unsettled later claim does not", () => {
    const { snap } = blockedOnHumanSnapshot();
    snap.reconsiderations.push(reconsideration("work_underway", { at: iso(-DAY), posture: "work" }));
    assert.equal(only(evaluateMustSurface(snap, NOW), "blocked_on_human").length, 0);

    const interrupted = blockedOnHumanSnapshot();
    interrupted.snap.reconsiderations.push(
      reconsideration("work_underway", { at: iso(-DAY), settled: false, posture: "work" })
    );
    assert.equal(
      only(evaluateMustSurface(interrupted.snap, NOW), "blocked_on_human").length,
      1,
      "an interrupted run left no settlement, so the latest SETTLED one still governs"
    );
  });

  await t("a waiting_for_human_input settlement that proposed no Work carries no answerable ask (D4 literal)", () => {
    const snap = snapshot({ reconsiderations: [reconsideration("waiting_for_human_input")] });
    assert.equal(only(evaluateMustSurface(snap, NOW), "blocked_on_human").length, 0);
    assert.equal(awaitedHumanAsk(snap), null);
  });

  await t("any Work Item in review is a HumanWorkRequest, even without a settlement", () => {
    const reviewed = work({ status: "review", origin: "definition_template", work_type: "review_contract" });
    const [item] = only(evaluateMustSurface(snapshot({ work: [reviewed] }), NOW), "blocked_on_human");
    assert.equal(item.interaction.interaction, "human_work_request");
    if (item.interaction.interaction === "human_work_request") {
      assert.equal(item.interaction.work_item_id, reviewed.id);
    }
  });

  await t("an open ask that is ALSO in review is surfaced once, not twice", () => {
    const { snap, ask } = blockedOnHumanSnapshot();
    ask.status = "review";
    assert.equal(only(evaluateMustSurface(snap, NOW), "blocked_on_human").length, 1);
  });
}

async function testDueCommitment(): Promise<void> {
  console.log("\nSA-7.4 due commitment — live, exactly D5");

  const dueAt = (due: unknown) =>
    only(evaluateMustSurface(snapshot({ commitments: [commitment({ due })] }), NOW), "due_commitment").length;

  await t("open + advisor + a full instant at or before t ⇒ due; one millisecond later ⇒ not yet", () => {
    assert.equal(dueAt({ due_at: NOW.toISOString(), basis: "stated", due_expression: null }), 1, "due_at exactly at t");
    assert.equal(dueAt({ due_at: iso(-DAY), basis: "inferred_from_context", due_expression: null }), 1);
    assert.equal(dueAt({ due_at: iso(1), basis: "stated", due_expression: null }), 0);
  });

  await t("a due_expression is never due, whatever it says", () => {
    for (const expression of ["viernes", "ayer", "2026-09-01", "la próxima semana"]) {
      assert.equal(dueAt({ due_at: null, basis: "stated", due_expression: expression }), 0, expression);
    }
  });

  await t("gu, prospect and external commitments are never a human obligation by time alone", () => {
    for (const actor of ["gu", "prospect", "external"]) {
      const snap = snapshot({ commitments: [commitment({ actor: { actor } })] });
      assert.equal(evaluateMustSurface(snap, NOW).length, 0, actor);
    }
  });

  await t("only an OPEN commitment can be due", () => {
    for (const status of ["fulfilled", "changed", "cancelled", "superseded", "unresolved"]) {
      const snap = snapshot({
        commitments: [commitment({ status: { status, evidence_refs: [], note: null } })],
      });
      assert.equal(evaluateMustSurface(snap, NOW).length, 0, status);
    }
  });

  await t("a malformed due_at is a contract violation — never read as a date, never fires", () => {
    for (const bad of ["2026-09-11", "2026-09-11T10:00:00", "viernes", "2026-02-30T10:00:00Z", "5", 1726300000000, true]) {
      assert.equal(isValidDueInstant(bad), false, String(bad));
      assert.equal(dueAt({ due_at: bad, basis: "stated", due_expression: null }), 0, String(bad));
    }
    const violation = commitment({ due: { due_at: "2026-09-11", basis: "stated", due_expression: null } });
    assert.equal(commitmentDueState(violation), "contract_violation");
    assert.equal(commitmentDueState(commitment({ due: { due_at: null, basis: "stated", due_expression: "viernes" } })), "expression");
    assert.equal(commitmentDueState(commitment()), "instant");
  });

  await t("the consumer's notion of an instant agrees with the SL-4 producer's", () => {
    for (const raw of [
      "2026-09-11T10:00:00Z",
      "2026-09-11T10:00:00-06:00",
      "2026-09-11T10:00:00.123+05:30",
      "2026-09-11T10:00Z",
      "2026-09-11",
      "2026-09-11T10:00:00",
      "2026-02-30T10:00:00Z",
      "viernes",
    ]) {
      const produced = resolveCommitmentDue(raw, "stated");
      assert.equal(isValidDueInstant(raw), produced?.due_at != null, raw);
      if (produced?.due_at) assert.equal(isValidDueInstant(produced.due_at), true);
    }
  });

  await t("a commitment with no due fact, or no actor fact, is not due", () => {
    const noDue = commitment();
    noDue.due = null;
    const noActor = commitment();
    noActor.actor = null;
    assert.equal(evaluateMustSurface(snapshot({ commitments: [noDue, noActor] }), NOW).length, 0);
  });
}

async function testRuleOnlyExceptions(): Promise<void> {
  console.log("\nSA-7.4 authority conflict (SL-6) and unknown_outcome effect (SL-9) — rules and typed fixtures");

  await t("an unresolved authority surfaces with its uncertainty carried literally", () => {
    for (const state of ["unknown", "conflicting"] as const) {
      const snap = snapshot({
        authority_conflict: { resolution_id: id("authority"), state, detected_at: iso(-HOUR) },
      });
      const [item] = evaluateMustSurface(snap, NOW);
      assert.equal(item.predicate, "authority_conflict");
      assert.equal(item.interaction.interaction, "exception_review");
      if (item.interaction.interaction === "exception_review" && item.interaction.exception === "authority_conflict") {
        assert.equal(item.interaction.authority_state, state);
      }
    }
  });

  await t("only an effect in unknown_outcome surfaces, and never as a success", () => {
    const ops = (["claimed", "running", "succeeded", "failed", "unknown_outcome"] as const).map((status) => ({
      id: id("effect"),
      capability: "send_prospect_message",
      status,
      updated_at: iso(-HOUR),
    }));
    const items = evaluateMustSurface(snapshot({ effect_operations: ops }), NOW);
    assert.deepEqual(predicatesOf(items), ["unknown_outcome_effect"]);
    const [item] = items;
    if (item.interaction.interaction === "exception_review" && item.interaction.exception === "unknown_effect_outcome") {
      assert.equal(item.interaction.outcome, "unknown_outcome");
    } else {
      assert.fail("expected an unknown_effect_outcome ExceptionReview");
    }
  });
}

async function testStalled(): Promise<void> {
  console.log("\nSA-7.4 stalled — exactly D7 (positive case by typed fixture; live data is legacy-authority)");

  const stalledBase = (overrides: Partial<PortfolioCaseSnapshot["case"]> = {}) =>
    snapshot({ caseOverrides: { runtime_authority: "gu_os", next_action_at: null, ...overrides } });

  await t("gu_os authority + no re-entry path ⇒ stalled, even with no Gu OS reconsideration ever", () => {
    const snap = stalledBase();
    assert.equal(snap.reconsiderations.length, 0);
    assert.equal(hasValidReentryPath(snap), false);
    const [item] = evaluateMustSurface(snap, NOW);
    assert.equal(item.predicate, "stalled");
    assert.equal(item.interaction.interaction, "exception_review");
  });

  await t("under legacy (or unset) authority the absence of a Gu OS path is NOT a Gu OS stall", () => {
    for (const authority of ["legacy", null] as const) {
      assert.equal(evaluateMustSurface(stalledBase({ runtime_authority: authority }), NOW).length, 0, String(authority));
    }
  });

  await t("next_action_at set — past OR future — is a valid re-entry path; there is no timeout", () => {
    assert.equal(evaluateMustSurface(stalledBase({ next_action_at: iso(-365 * DAY) }), NOW).length, 0);
    assert.equal(evaluateMustSurface(stalledBase({ next_action_at: iso(HOUR) }), NOW).length, 0);
  });

  await t("pending todo / ready / running Work is a re-entry path; blocked Work is not", () => {
    for (const status of ["todo", "ready", "running"] as const) {
      const snap = stalledBase();
      snap.work = [work({ status, origin: "definition_template" })];
      assert.equal(only(evaluateMustSurface(snap, NOW), "stalled").length, 0, status);
    }
    const blocked = stalledBase();
    blocked.work = [work({ status: "blocked", blocked_reason: "max_attempts_exhausted" })];
    assert.equal(only(evaluateMustSurface(blocked, NOW), "stalled").length, 1, "blocked work re-enters nothing");
  });

  await t("an awaited human response is a re-entry path: Work in review, or an unanswered ask", () => {
    const review = stalledBase();
    review.work = [work({ status: "review" })];
    assert.equal(only(evaluateMustSurface(review, NOW), "stalled").length, 0);

    const ask = work({ status: "review" });
    const awaiting = stalledBase();
    awaiting.work = [ask];
    awaiting.reconsiderations = [reconsideration("waiting_for_human_input", { proposedWorkIds: [ask.id] })];
    assert.equal(only(evaluateMustSurface(awaiting, NOW), "stalled").length, 0);
  });

  await t("a closed Opportunity, a non-live status or another case type is never stalled", () => {
    const closed = stalledBase();
    closed.closure = { id: id("fact"), fact_key: "opportunity.closure", value: { outcome: "duplicate" }, recorded_at: iso(-DAY), subject_id: null };
    assert.equal(evaluateMustSurface(closed, NOW).length, 0, "closed");
    for (const status of ["paused", "completed", "failed"] as const) {
      assert.equal(evaluateMustSurface(stalledBase({ status }), NOW).length, 0, status);
    }
    for (const status of ["waiting_internal", "waiting_external"] as const) {
      assert.equal(evaluateMustSurface(stalledBase({ status }), NOW).length, 1, status);
    }
    assert.equal(evaluateMustSurface(stalledBase({ case_type: "property_optioning" }), NOW).length, 0);
  });
}

async function testNeverInvented(): Promise<void> {
  console.log("\nSA-7.4 never from invented urgency; SA-7.3 every clause cites durable rows");

  await t("a quiet Case under legacy authority, untouched for a year, raises nothing", () => {
    const snap = snapshot({
      caseOverrides: { updated_at: iso(-365 * DAY), next_action_at: null },
      commitments: [commitment({ actor: { actor: "prospect" }, due: { due_at: iso(-300 * DAY), basis: "stated", due_expression: null } })],
    });
    assert.equal(evaluateMustSurface(snap, NOW).length, 0);
  });

  await t("WHY / WHAT GU NEEDS / WHY NOW each cite at least one row that exists in the snapshot", () => {
    const { snap } = blockedOnHumanSnapshot();
    snap.commitments = [commitment()];
    snap.approval_requests = [approvalRequest()];
    snap.authority_conflict = { resolution_id: id("authority"), state: "unknown", detected_at: iso(-HOUR) };
    snap.effect_operations = [{ id: id("effect"), capability: "send_prospect_message", status: "unknown_outcome", updated_at: iso(-HOUR) }];
    const items = evaluateMustSurface(snap, NOW);
    assert.equal(items.length, 5);

    const known = new Set<string>([
      snap.case.id,
      ...snap.work.map((w) => w.id),
      ...snap.reconsiderations.flatMap((r) => [r.claim_event_id, r.settlement?.event_id ?? ""]),
      ...snap.commitments.flatMap((c) => [c.subject_id, c.status?.id, c.actor?.id, c.due?.id, c.expected_outcome?.id].filter(Boolean) as string[]),
      ...snap.approval_requests.map((r) => r.request_id),
      snap.authority_conflict.resolution_id,
      ...snap.effect_operations.map((e) => e.id),
    ]);
    for (const item of items) {
      for (const clause of [item.why, item.what_gu_needs, item.why_now]) {
        assert.ok(clause.code.length > 0, `${item.predicate}: clause code`);
        assert.ok(clause.refs.length > 0, `${item.predicate}/${clause.code}: no durable ref`);
        for (const ref of clause.refs) {
          assert.ok(known.has(ref.id), `${item.predicate}/${clause.code}: ${ref.kind}:${ref.id} is not durable truth`);
        }
      }
      assert.ok(item.interaction.evidence_refs.length > 0);
      assert.equal(item.case_id, snap.case.id);
    }
  });

  await t("every clause the rules emit has Spanish copy — a missing template fails here, not as a blank", () => {
    const { snap } = blockedOnHumanSnapshot();
    snap.commitments = [commitment()];
    snap.approval_requests = [approvalRequest()];
    snap.authority_conflict = { resolution_id: id("authority"), state: "conflicting", detected_at: iso(-HOUR) };
    snap.effect_operations = [{ id: id("effect"), capability: "send_prospect_message", status: "unknown_outcome", updated_at: iso(-HOUR) }];
    snap.work.push(work({ status: "review", origin: "definition_template" }));
    const stall = snapshot({ caseOverrides: { runtime_authority: "gu_os", next_action_at: null } });
    const items = [...evaluateMustSurface(snap, NOW), ...evaluateMustSurface(stall, NOW)];
    assert.deepEqual(
      [...new Set(items.map((i) => i.predicate))].sort(),
      [...MUST_SURFACE_PREDICATES].sort(),
      "the fixture exercises all six predicates"
    );
    for (const item of items) {
      assert.ok(PREDICATE_COPY[item.predicate]);
      for (const clause of [item.why, item.what_gu_needs, item.why_now]) {
        const text = renderClause(clause, (instant) => instant ?? "—");
        assert.ok(text.length > 0 && !text.includes("undefined"), `${clause.code}: ${text}`);
      }
    }
  });

  await t("attention items have stable identities, so a re-render is the same need", () => {
    const { snap } = blockedOnHumanSnapshot();
    const a = evaluateMustSurface(snap, NOW).map((i) => i.id);
    const b = evaluateMustSurface(snap, new Date(NOW.getTime() + HOUR)).map((i) => i.id);
    assert.deepEqual(a, b);
  });
}

// ============================================================
// SA-7.7 — seen / snoozed / hidden / pinned never resolve a need
// ============================================================

async function testExitSemantics(): Promise<void> {
  console.log("\nSA-7.7 — exit semantics");

  await t("marking seen, snoozing, hiding and pinning leave the attention set exactly as it was", () => {
    const { snap } = blockedOnHumanSnapshot();
    const before = evaluateMustSurface(snap, NOW);
    for (const change of [
      { kind: "seen" as const },
      { kind: "snooze" as const, days: 7 },
      { kind: "hide" as const },
      { kind: "pin" as const },
    ]) {
      const patch = presentationPatchFor(change, NOW);
      assert.ok(Object.keys(patch).every((key) => ["seen_at", "snooze_until", "hidden_at", "pinned"].includes(key)));
      assert.deepEqual(evaluateMustSurface(snap, NOW), before, change.kind);
    }
  });

  await t("the need exits only when durable truth changes: the ask's Work is done", () => {
    const { snap, ask } = blockedOnHumanSnapshot();
    assert.equal(evaluateMustSurface(snap, NOW).length, 1);
    ask.status = "done";
    assert.equal(evaluateMustSurface(snap, NOW).length, 0);
  });
}

// ============================================================
// SA-7.10 — posture is earned, never invented
// ============================================================

async function testPosture(): Promise<void> {
  console.log("\nSA-7.10 — posture derivation");

  await t("no settled reconsideration ⇒ no derived posture, even under gu_os and even when stalled", () => {
    const stalled = snapshot({ caseOverrides: { runtime_authority: "gu_os", next_action_at: null } });
    const posture = derivePosture(stalled, evaluateMustSurface(stalled, NOW));
    assert.deepEqual(posture.postures, []);
    assert.equal(posture.reconsidered, false);

    const running = snapshot({ work: [work({ status: "running", origin: "definition_template" })] });
    assert.deepEqual(derivePosture(running, []).postures, [], "running Work does not invent Gu Handling");

    const interrupted = snapshot({ reconsiderations: [reconsideration("work_underway", { settled: false })] });
    assert.deepEqual(derivePosture(interrupted, []).postures, [], "an unsettled claim is not a posture");
  });

  await t("work_underway ⇒ gu_handling, without any running Work, and shadow under legacy authority", () => {
    const snap = snapshot({ reconsiderations: [reconsideration("work_underway", { posture: "work" })] });
    const posture = derivePosture(snap, []);
    assert.deepEqual(posture.postures, ["gu_handling"]);
    assert.equal(posture.mode, "shadow");
    const authoritative = derivePosture(
      snapshot({ caseOverrides: { runtime_authority: "gu_os" }, reconsiderations: [reconsideration("work_underway", { posture: "work" })] }),
      []
    );
    assert.equal(authoritative.mode, "authoritative");
  });

  await t("waiting yields ⇒ waiting; watching is never derived without a detection mechanism (S4 §7.4)", () => {
    for (const yieldPosture of ["waiting_for_prospect", "waiting_until_time", "waiting_for_external_signal"]) {
      const posture = derivePosture(snapshot({ reconsiderations: [reconsideration(yieldPosture, { posture: "wait" })] }), []);
      assert.deepEqual(posture.postures, ["waiting"], yieldPosture);
    }
  });

  await t("an unanswered ask ⇒ needs_attention AND waiting; once answered ⇒ gu_handling", () => {
    const { snap, ask } = blockedOnHumanSnapshot();
    assert.deepEqual(derivePosture(snap, evaluateMustSurface(snap, NOW)).postures.sort(), ["needs_attention", "waiting"]);
    ask.status = "done";
    assert.deepEqual(derivePosture(snap, evaluateMustSurface(snap, NOW)).postures, ["gu_handling"]);
  });

  await t("a recorded closure adds outcomes; no_useful_work_now is quiet handling, not a stall", () => {
    const snap = snapshot({ reconsiderations: [reconsideration("no_useful_work_now", { posture: "no_op" })] });
    snap.closure = { id: id("fact"), fact_key: "opportunity.closure", value: { outcome: "duplicate" }, recorded_at: iso(-HOUR), subject_id: null };
    assert.deepEqual(derivePosture(snap, []).postures.sort(), ["gu_handling", "outcomes"]);
  });
}

// ============================================================
// SA-7.1 / SA-7.9 — two projections over one truth; approval authority
// ============================================================

async function testProjection(): Promise<void> {
  console.log("\nSA-7.1 — My Work and Organization Work");

  const assigned = snapshot({ caseOverrides: { id: "case-assigned", assigned_to_user_id: ADVISOR } });
  const otherAdvisor = snapshot({ caseOverrides: { id: "case-other", assigned_to_user_id: ADVISOR_2 } });
  const unassigned = snapshot({ caseOverrides: { id: "case-unassigned", assigned_to_user_id: null } });
  const approval = snapshot({
    caseOverrides: { id: "case-approval", assigned_to_user_id: ADVISOR_2 },
    approval_requests: [approvalRequest()],
  });
  const snaps = [assigned, otherAdvisor, unassigned, approval];

  await t("My Work holds the actor's assigned Cases; Organization Work holds every authorized Case", () => {
    const portfolio = buildWorkPortfolio({ actor: { userId: ADVISOR, role: "advisor" }, snapshots: snaps, presentation: [], now: NOW });
    const ids = (entries: typeof portfolio.myWork.entries) => entries.map((e) => e.case.id).sort();
    assert.deepEqual(ids(portfolio.myWork.entries), ["case-assigned"]);
    assert.deepEqual(ids(portfolio.organizationWork.entries), ["case-approval", "case-assigned", "case-other", "case-unassigned"]);
  });

  await t("one truth: a Case in both projections is the SAME entry, not a copy with its own state", () => {
    const portfolio = buildWorkPortfolio({ actor: { userId: ADVISOR, role: "advisor" }, snapshots: snaps, presentation: [], now: NOW });
    const mine = portfolio.myWork.entries.find((e) => e.case.id === "case-assigned");
    const org = portfolio.organizationWork.entries.find((e) => e.case.id === "case-assigned");
    assert.equal(mine, org);
  });

  await t("SA-7.9 an approval the actor may decide enters My Work for owner and org_admin only", () => {
    for (const role of ["owner", "org_admin"] as const) {
      const portfolio = buildWorkPortfolio({ actor: { userId: OWNER, role }, snapshots: snaps, presentation: [], now: NOW });
      assert.ok(portfolio.myWork.entries.some((e) => e.case.id === "case-approval"), role);
      const entry = portfolio.myWork.entries.find((e) => e.case.id === "case-approval")!;
      assert.deepEqual(entry.myWorkReasons, ["approval_authority"]);
    }
    const advisor = buildWorkPortfolio({ actor: { userId: ADVISOR_2, role: "advisor" }, snapshots: snaps, presentation: [], now: NOW });
    const entry = advisor.myWork.entries.find((e) => e.case.id === "case-approval")!;
    assert.deepEqual(entry.myWorkReasons, ["assigned"], "assignment is why it is theirs — never approval authority");
    assert.equal(entry.canDecideApprovals, false);
  });

  await t("Needs Attention is the must-surface subset and lists first; the rest keep their sections", () => {
    const { snap } = blockedOnHumanSnapshot();
    snap.case = { ...snap.case, id: "case-ask" };
    const handled = snapshot({
      caseOverrides: { id: "case-handled" },
      reconsiderations: [reconsideration("work_underway", { posture: "work" })],
    });
    const portfolio = buildWorkPortfolio({ actor: { userId: ADVISOR, role: "advisor" }, snapshots: [handled, snap, unassigned], presentation: [], now: NOW });
    const sections = portfolio.organizationWork.entries.map((e) => [e.case.id, e.section]);
    assert.deepEqual(sections[0], ["case-ask", "needs_attention"]);
    assert.deepEqual(
      Object.fromEntries(sections),
      { "case-ask": "needs_attention", "case-handled": "gu_handling", "case-unassigned": "not_reconsidered" }
    );
  });

  await t("presentation is per person: one user's snooze changes nothing in another user's view", () => {
    const quiet = snapshot({ caseOverrides: { id: "case-quiet" }, reconsiderations: [reconsideration("work_underway", { posture: "work" })] });
    const row = presentationRow({ user_id: ADVISOR, subject_id: "case-quiet", snooze_until: iso(DAY) });
    const mine = buildWorkPortfolio({ actor: { userId: ADVISOR, role: "advisor" }, snapshots: [quiet], presentation: [row], now: NOW });
    const theirs = buildWorkPortfolio({ actor: { userId: ADVISOR_2, role: "advisor" }, snapshots: [quiet], presentation: [row], now: NOW });
    assert.equal(mine.organizationWork.entries.length, 0);
    assert.equal(mine.organizationWork.suppressed.length, 1);
    assert.equal(theirs.organizationWork.entries.length, 1, "someone else's row is not mine to apply");
  });

  await t("interaction payloads render through the CURRENT HITL action contract (TD-15 adapter)", () => {
    const { snap } = blockedOnHumanSnapshot();
    const [item] = evaluateMustSurface(snap, NOW);
    assert.equal(hitlKindForInteraction(item.interaction), "information_request");
    const actions = hitlActionsForInteraction(item.interaction);
    assert.ok(actions.length > 0 && actions.every((a) => typeof a.id === "string" && a.label.length > 0));
    assert.ok(actions.some((a) => a.requiresNotes), "an information request is answered with the information");
    const exception = evaluateMustSurface(
      snapshot({ caseOverrides: { runtime_authority: "gu_os", next_action_at: null } }),
      NOW
    )[0];
    assert.deepEqual(hitlActionsForInteraction(exception.interaction), [], "no SL-7 action resolves a stall");
  });
}

// ============================================================
// Loader — SA-7.2 authorization first, flags off ⇒ inert
// ============================================================

const membership = (userId: string, role: string, status = "active", organizationId = ORG) => ({
  id: id("membership"),
  organization_id: organizationId,
  user_id: userId,
  role,
  status,
});

const caseRow = (overrides: Record<string, unknown> = {}) => ({
  id: CASE_ID,
  user_id: ADVISOR,
  organization_id: ORG,
  case_type: "lead_opportunity",
  case_type_id: "ct-1",
  status: "active",
  runtime_authority: "legacy",
  assigned_to_user_id: ADVISOR,
  next_action_at: iso(DAY),
  workflow_definition_version: 1,
  version: 3,
  context_jsonb: {},
  created_at: iso(-10 * DAY),
  updated_at: iso(-DAY),
  ...overrides,
});

function serviceTables(options: { relationshipOps?: boolean } = {}): Record<string, Array<Record<string, unknown>>> {
  return {
    organization_memberships: [
      membership(OWNER, "owner"),
      membership(ADMIN, "org_admin"),
      membership(ADVISOR, "advisor"),
      membership(ADVISOR_2, "advisor"),
      membership(REVOKED, "advisor", "inactive"),
      membership(OUTSIDER, "owner", "active", OTHER_ORG),
    ],
    organization_feature_flags:
      options.relationshipOps === false
        ? []
        : [{ id: "flag-1", organization_id: ORG, flag_key: "relationship_ops", enabled: true, value_text: null }],
  };
}

/**
 * The actor's own-JWT view. RLS is what decides this set in production; the
 * fake models its OUTCOME (only the Organization's rows the actor may read) so
 * the loader can be shown never to look beyond it. That RLS really produces
 * this outcome is the DB-backed suite's claim, not this file's.
 */
function userView(rows: Array<Record<string, unknown>>): FakeDb {
  return createFakeDb({ tables: { operational_cases: rows } });
}

async function testLoader(): Promise<void> {
  console.log("\nSA-7.2 — authorization before any projection; flags off ⇒ inert");

  await t("no active membership ⇒ refused before a single business row is read", async () => {
    for (const actor of [REVOKED, OUTSIDER, "not-a-member"]) {
      const service = createFakeDb({ tables: serviceTables() });
      const user = userView([caseRow()]);
      const result = await loadWorkPortfolio({ serviceDb: service.client, userDb: user.client, actorUserId: actor, organizationId: ORG, now: NOW });
      assert.equal(result.status, "no_membership", actor);
      assert.deepEqual(user.reads, [], `${actor}: the actor's view was never queried`);
      assert.deepEqual(service.reads, ["organization_memberships"], `${actor}: only the membership was read`);
    }
  });

  await t("relationship_ops off ⇒ inert: no Case, fact, Work or presentation read, and nothing written", async () => {
    const service = createFakeDb({ tables: serviceTables({ relationshipOps: false }) });
    const user = userView([caseRow()]);
    const result = await loadWorkPortfolio({ serviceDb: service.client, userDb: user.client, actorUserId: ADVISOR, organizationId: ORG, now: NOW });
    assert.equal(result.status, "inert");
    assert.deepEqual(user.reads, []);
    assert.deepEqual(service.reads.sort(), ["organization_feature_flags", "organization_memberships"]);
    assert.deepEqual([...service.writes, ...user.writes], []);
  });

  await t("the candidate set is the actor's authorized read; Work is fetched ONLY for those Cases", async () => {
    const service = createFakeDb({
      tables: {
        ...serviceTables(),
        work_items: [
          { id: "work-mine", case_id: CASE_ID, user_id: ADVISOR, work_type: "confirm", status: "todo", origin: "agent_proposed", input_contract_jsonb: {}, created_at: iso(-DAY), updated_at: iso(-DAY) },
          { id: "work-foreign", case_id: "case-foreign", user_id: OUTSIDER, work_type: "secret", status: "todo", origin: "agent_proposed", input_contract_jsonb: {}, created_at: iso(-DAY), updated_at: iso(-DAY) },
        ],
      },
    });
    // The foreign Case exists in the database but the actor's RLS view never
    // returns it — so it must never reach a service-role read either.
    const user = userView([caseRow()]);
    const result = await loadWorkPortfolio({ serviceDb: service.client, userDb: user.client, actorUserId: ADVISOR, organizationId: ORG, now: NOW });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const everything = JSON.stringify(result.portfolio);
    assert.ok(!everything.includes("case-foreign") && !everything.includes("work-foreign"));
    // Not merely dropped after fetching: every service-role Work read was
    // keyed to the authorized Case ids and nothing else.
    const workReads = service.queries.filter((q) => q.table === "work_items");
    assert.ok(workReads.length > 0);
    for (const query of workReads) {
      const keyed = query.filters.find((f) => f.kind === "in" && f.column === "case_id");
      assert.ok(keyed && keyed.kind === "in", "a Work read without a Case-id key");
      assert.deepEqual(keyed.values, [CASE_ID]);
    }
  });

  await t("a Case of another Organization returned by a misbehaving view is dropped, never projected", async () => {
    const service = createFakeDb({ tables: serviceTables() });
    const user = userView([caseRow(), caseRow({ id: "case-other-org", organization_id: OTHER_ORG })]);
    const result = await loadWorkPortfolio({ serviceDb: service.client, userDb: user.client, actorUserId: ADVISOR, organizationId: ORG, now: NOW });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.ok(!JSON.stringify(result.portfolio).includes("case-other-org"));
    }
  });
}

// ============================================================
// Actions — SA-7.8 canonical mechanisms only, SA-7.9 the approval gate
// ============================================================

type Tables = Record<string, Array<Record<string, unknown>>>;

function actionTables(extra: Tables = {}): Tables {
  const ask = {
    id: "work-ask",
    case_id: CASE_ID,
    work_run_id: null,
    user_id: ADVISOR,
    workflow_definition_version: 1,
    work_type: "confirm_budget_with_advisor",
    origin: "agent_proposed",
    status: "todo",
    priority: 100,
    required_capability: "confirm_budget_with_advisor",
    not_before: null,
    due_at: null,
    attempt_count: 0,
    max_attempts: 3,
    current_attempt_id: null,
    blocked_reason: null,
    input_contract_jsonb: { purpose: "Confirmar el presupuesto real", proposed_by: "case_supervisor" },
    output_contract_jsonb: {},
    verification_contract_jsonb: {},
    result_jsonb: null,
    idempotency_key: "scheduled:x:confirm_budget_with_advisor",
    version: 1,
    created_at: iso(-2 * DAY),
    updated_at: iso(-2 * DAY),
  };
  return {
    ...serviceTables(),
    operational_cases: [caseRow()],
    work_items: [ask],
    work_item_dependencies: [],
    work_item_attempts: [],
    work_item_events: [],
    operational_case_events: [
      {
        id: "event-claim",
        case_id: CASE_ID,
        event_type: "state_changed",
        actor: "agent",
        created_at: iso(-2 * DAY),
        payload_jsonb: {
          kind: "supervisor_reconsidered",
          v: 1,
          wake_key: "scheduled:x",
          posture: "targeted_human_input",
          yield_posture: "no_useful_work_now",
          rationale: "Presupuesto en conflicto",
          diagnosis: null,
          uncertainty: null,
          proposed_work_ids: [],
          commitment_subject_ids: [],
          next_action_at: iso(DAY),
          stage: "shadow",
          model_id: null,
          policy_version: null,
        },
      },
      {
        id: "event-settled",
        case_id: CASE_ID,
        event_type: "state_changed",
        actor: "agent",
        created_at: iso(-2 * DAY + 1000),
        payload_jsonb: {
          kind: "supervisor_reconsideration_settled",
          v: 1,
          wake_key: "scheduled:x",
          yield_posture: "waiting_for_human_input",
          proposed_work_ids: ["work-ask"],
          commitment_subject_ids: [],
        },
      },
    ],
    case_facts: [],
    case_subjects: [],
    case_approvals: [],
    ...extra,
  };
}

const businessTables = (fake: FakeDb) =>
  [...new Set(fake.writes)].sort();

async function testActions(): Promise<void> {
  console.log("\nSA-7.8 / SA-7.9 — Portfolio actions");

  await t("SA-7.9 case_approval.decide: owner and org_admin allowed; an ASSIGNED advisor, a revoked member and an outsider refused", async () => {
    const db = createFakeDb({ tables: actionTables() }).client;
    assert.equal((await authorizeOrgAction(db, OWNER, ORG, "case_approval.decide")).allowed, true);
    assert.equal((await authorizeOrgAction(db, ADMIN, ORG, "case_approval.decide")).allowed, true);
    const advisor = await authorizeOrgAction(db, ADVISOR, ORG, "case_approval.decide");
    assert.equal(advisor.allowed, false);
    assert.equal(advisor.reason, "role_not_permitted", "the Case IS assigned to this advisor — and it does not matter");
    assert.equal((await authorizeOrgAction(db, REVOKED, ORG, "case_approval.decide")).reason, "no_active_membership");
    assert.equal((await authorizeOrgAction(db, OUTSIDER, ORG, "case_approval.decide")).reason, "no_active_membership");
  });

  await t("the projection's rendering of D3 agrees with the gate for every role", async () => {
    for (const role of ["owner", "org_admin", "advisor"] as const) {
      const db = createFakeDb({ tables: { organization_memberships: [membership(ADVISOR, role)] } }).client;
      const gate = await authorizeOrgAction(db, ADVISOR, ORG, "case_approval.decide");
      assert.equal(canDecideApprovals(role), gate.allowed, role);
    }
  });

  const request = approvalRequest({ request_id: "request-1" });
  const fixtureSource: ApprovalRequestSource = {
    async find(caseId, requestId) {
      return caseId === CASE_ID && requestId === "request-1" ? request : null;
    },
  };

  await t("SA-7.8 deciding an approval writes the CURRENT case_approvals row plus its attributed timeline event — nothing else", async () => {
    const fake = createFakeDb({ tables: actionTables() });
    const result = await decidePortfolioApproval({
      serviceDb: fake.client, actorUserId: ADMIN, organizationId: ORG, caseId: CASE_ID,
      requestId: "request-1", decision: "approved", rationale: "Correcto", requests: fixtureSource, now: NOW,
    });
    assert.equal(result.status, "done");
    assert.deepEqual(businessTables(fake), ["case_approvals", "operational_case_events"]);
    const [approval] = fake.tables.case_approvals;
    assert.equal(approval.decided_by, ADMIN);
    assert.equal(approval.user_id, ADVISOR, "the tenant key stays the Case owner's");
    assert.equal(approval.evidence_hash, request.evidence_hash, "the decision pins the basis that was asked");
    const event = fake.tables.operational_case_events.at(-1)!;
    const payload = event.payload_jsonb as Record<string, unknown>;
    assert.equal(event.event_type, "human_decision");
    assert.equal(payload.actor_user_id, ADMIN);
    assert.equal(payload.actor_role, "org_admin", "actor AND role persisted at decision time (TD-1)");
  });

  await t("SA-7.9 the assigned advisor is refused and nothing is written", async () => {
    const fake = createFakeDb({ tables: actionTables() });
    const result = await decidePortfolioApproval({
      serviceDb: fake.client, actorUserId: ADVISOR, organizationId: ORG, caseId: CASE_ID,
      requestId: "request-1", decision: "approved", rationale: null, requests: fixtureSource, now: NOW,
    });
    assert.deepEqual(result, { status: "refused", reason: "role_not_permitted" });
    assert.deepEqual(fake.writes, []);
  });

  await t("a request already decided elsewhere is not decided twice (S4 §13, invariant 22)", async () => {
    const fake = createFakeDb({
      tables: actionTables({
        case_approvals: [{
          id: "approval-telegram", case_id: CASE_ID, user_id: ADVISOR, approval_kind: request.approval_kind,
          decision: "approved", decided_by: OWNER, decided_at: iso(-60_000), evidence_hash: request.evidence_hash,
          evidence_snapshot_jsonb: {}, superseded_by: null, rationale: "desde Telegram",
        }],
      }),
    });
    const result = await decidePortfolioApproval({
      serviceDb: fake.client, actorUserId: OWNER, organizationId: ORG, caseId: CASE_ID,
      requestId: "request-1", decision: "rejected", rationale: "tarde", requests: fixtureSource, now: NOW,
    });
    assert.deepEqual(result, { status: "refused", reason: "already_decided" });
    assert.deepEqual(fake.writes, []);
  });

  await t("the LIVE request source has no producer before SL-9: it finds nothing and decides nothing", async () => {
    const fake = createFakeDb({ tables: actionTables() });
    const result = await decidePortfolioApproval({
      serviceDb: fake.client, actorUserId: OWNER, organizationId: ORG, caseId: CASE_ID,
      requestId: "request-1", decision: "approved", rationale: null, requests: NO_APPROVAL_REQUEST_PRODUCER, now: NOW,
    });
    assert.deepEqual(result, { status: "refused", reason: "no_pending_request" });
    assert.deepEqual(fake.writes, []);
  });

  await t("SA-7.8 completing the open ask moves ONLY Work Plane rows, through the kernel's own claim path", async () => {
    const fake = createFakeDb({ tables: actionTables() });
    const result = await completePortfolioWork({
      serviceDb: fake.client, actorUserId: ADVISOR_2, organizationId: ORG, caseId: CASE_ID,
      workItemId: "work-ask", answer: "El presupuesto real es 4.5M", now: NOW,
    });
    assert.equal(result.status, "done");
    assert.deepEqual(businessTables(fake), ["work_item_attempts", "work_item_events", "work_items"]);
    const [item] = fake.tables.work_items;
    assert.equal(item.status, "done");
    const answer = (item.result_jsonb as Record<string, Record<string, unknown>>).human_answer;
    assert.equal(answer.text, "El presupuesto real es 4.5M");
    assert.equal(answer.answered_by, ADVISOR_2, "the actor, not the Case owner the rows are keyed to");
    assert.equal(answer.answered_by_role, "advisor");
    const [attempt] = fake.tables.work_item_attempts;
    assert.equal(attempt.executor_kind, "human");
    assert.equal(attempt.status, "succeeded");
    assert.deepEqual(fake.tables.work_item_events.map((e) => e.event_type), ["ready", "claimed", "done"]);
    assert.equal(fake.tables.operational_cases[0].version, 3, "the Case row is untouched");
  });

  await t("…and then the need exits the projection", async () => {
    const fake = createFakeDb({ tables: actionTables() });
    // An active member's own-JWT view of this Organization reads the same rows.
    const user = createFakeDb({ tables: fake.tables });
    const attentionNow = async () => {
      const result = await loadWorkPortfolio({ serviceDb: fake.client, userDb: user.client, actorUserId: ADVISOR, organizationId: ORG, now: NOW });
      assert.equal(result.status, "ok");
      return result.status === "ok" ? result.portfolio.organizationWork.entries[0].attention : [];
    };
    assert.deepEqual((await attentionNow()).map((a) => a.predicate), ["blocked_on_human"], "the ask is live before");
    await completePortfolioWork({
      serviceDb: fake.client, actorUserId: ADVISOR, organizationId: ORG, caseId: CASE_ID,
      workItemId: "work-ask", answer: "Sí, confirmado", now: NOW,
    });
    assert.deepEqual(await attentionNow(), [], "and exits after, with no Portfolio-only state involved");
  });

  await t("refused: an outsider, another Organization's Case, Work that awaits no human, and an empty answer", async () => {
    const attempt = async (overrides: { actor?: string; caseId?: string; workItemId?: string; answer?: string; tables?: ReturnType<typeof actionTables> }) => {
      const fake = createFakeDb({ tables: overrides.tables ?? actionTables() });
      const result = await completePortfolioWork({
        serviceDb: fake.client,
        actorUserId: overrides.actor ?? ADVISOR,
        organizationId: ORG,
        caseId: overrides.caseId ?? CASE_ID,
        workItemId: overrides.workItemId ?? "work-ask",
        answer: overrides.answer ?? "respuesta",
        now: NOW,
      });
      return { result, writes: fake.writes };
    };
    const outsider = await attempt({ actor: OUTSIDER });
    assert.deepEqual(outsider.result, { status: "refused", reason: "no_active_membership" });
    assert.deepEqual(outsider.writes, []);

    const foreign = actionTables();
    foreign.operational_cases = [caseRow({ organization_id: OTHER_ORG })];
    assert.deepEqual((await attempt({ tables: foreign })).result, { status: "refused", reason: "case_not_in_organization" });

    const agentWork = actionTables();
    (agentWork.operational_case_events[1].payload_jsonb as Record<string, unknown>).yield_posture = "work_underway";
    const notAwaiting = await attempt({ tables: agentWork });
    assert.deepEqual(notAwaiting.result, { status: "refused", reason: "work_not_awaiting_human" });
    assert.deepEqual(notAwaiting.writes, []);

    assert.deepEqual((await attempt({ answer: "   " })).result, { status: "refused", reason: "answer_required" });
  });

  await t("a Work Item in review is completed through the CURRENT review→done path, attributed to the actor", async () => {
    const tables = actionTables();
    tables.work_items[0].status = "review";
    const fake = createFakeDb({ tables });
    const result = await completePortfolioWork({
      serviceDb: fake.client, actorUserId: ADMIN, organizationId: ORG, caseId: CASE_ID,
      workItemId: "work-ask", answer: "Revisado", now: NOW,
    });
    assert.equal(result.status, "done");
    const [item] = fake.tables.work_items;
    assert.equal(item.status, "done");
    const resolution = (item.result_jsonb as Record<string, Record<string, unknown>>).review_resolution;
    assert.equal(resolution.resolved_by, ADMIN);
    assert.equal(resolution.source, "work_portfolio");
  });

  await t("review Work that is a DOMAIN DECISION is not closable here — it closes through its own decision", async () => {
    // The CURRENT operator view already refuses a manual close of such Work
    // (`workReviewActionPresentation`); the Portfolio must not become the way
    // around the decision and its authorization.
    const tables = actionTables();
    tables.work_items[0].status = "review";
    tables.work_items[0].work_type = "verify_valuation";
    const fake = createFakeDb({ tables });
    const result = await completePortfolioWork({
      serviceDb: fake.client, actorUserId: OWNER, organizationId: ORG, caseId: CASE_ID,
      workItemId: "work-ask", answer: "cerrar", now: NOW,
    });
    assert.deepEqual(result, { status: "refused", reason: "work_resolved_by_domain_decision" });
    assert.deepEqual(fake.writes, []);
    assert.equal(fake.tables.work_items[0].status, "review");
  });

  await t("flags off ⇒ both business actions and presentation writes are inert", async () => {
    const off = actionTables();
    off.organization_feature_flags = [];
    const fake = createFakeDb({ tables: off });
    const user = createFakeDb({ tables: {} });
    const work = await completePortfolioWork({ serviceDb: fake.client, actorUserId: ADVISOR, organizationId: ORG, caseId: CASE_ID, workItemId: "work-ask", answer: "x", now: NOW });
    const approval = await decidePortfolioApproval({ serviceDb: fake.client, actorUserId: OWNER, organizationId: ORG, caseId: CASE_ID, requestId: "request-1", decision: "approved", rationale: null, requests: fixtureSource, now: NOW });
    const presentation = await writePortfolioPresentation({ serviceDb: fake.client, userDb: user.client, actorUserId: ADVISOR, organizationId: ORG, caseId: CASE_ID, change: { kind: "hide" }, now: NOW });
    for (const result of [work, approval, presentation]) {
      assert.deepEqual(result, { status: "inert", reason: "relationship_ops_disabled" });
    }
    assert.deepEqual([...fake.writes, ...user.writes], []);
  });

  await t("SA-7.6 a presentation write touches portfolio_presentation_state and nothing else", async () => {
    const fake = createFakeDb({ tables: actionTables() });
    const user = createFakeDb({ tables: { portfolio_presentation_state: [] } });
    for (const change of [
      { kind: "snooze" as const, days: 3 },
      { kind: "hide" as const },
      { kind: "pin" as const },
      { kind: "seen" as const },
      { kind: "unhide" as const },
    ]) {
      const result = await writePortfolioPresentation({ serviceDb: fake.client, userDb: user.client, actorUserId: ADVISOR, organizationId: ORG, caseId: CASE_ID, change, now: NOW });
      assert.equal(result.status, "done", change.kind);
    }
    assert.deepEqual(fake.writes, [], "no service-role write at all");
    assert.deepEqual([...new Set(user.writes)], ["portfolio_presentation_state"]);
    assert.equal(user.tables.portfolio_presentation_state.length, 1, "one row per person per Case");
    const [row] = user.tables.portfolio_presentation_state;
    assert.equal(row.user_id, ADVISOR);
    assert.equal(row.hidden_at, null, "unhide cleared it");
    assert.equal(row.pinned, true);
  });
}

async function main(): Promise<void> {
  console.log("Work Portfolio v1 selftest (R1 SL-7)\n");
  await testPresentationCannotSuppressMustSurface();
  await testSnoozeCap();
  await testPendingApproval();
  await testBlockedOnHuman();
  await testDueCommitment();
  await testRuleOnlyExceptions();
  await testStalled();
  await testNeverInvented();
  await testExitSemantics();
  await testPosture();
  await testProjection();
  await testLoader();
  await testActions();
  console.log(`\nWork Portfolio selftest ok — ${passed} checks passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
