/**
 * The governed must-surface predicates — R1 SL-7, Slice Plan SA-7.4
 * (Technical Plan TD-9 v1; S4 §6.3; AC-9 §14.3).
 *
 * Six pure rules over one `PortfolioCaseSnapshot`. Each admits an item only
 * from current truth, authority or domain semantics — never from elapsed time
 * alone, never from a score, and never from a model: there is no model
 * anywhere in SL-7, and a need for model judgment would stop the work (SL-12).
 *
 * The rules are the human decisions of 2026-09-13, recorded before
 * implementation, transcribed rather than re-interpreted:
 *
 *   D4  pending approval and unknown-outcome effects remain rules over typed
 *       inputs with no Organization-Case producer yet. Authority conflict is
 *       now live from SL-6 `authority_resolutions` (see snapshot.ts);
 *   D5  due commitment: open + advisor + a full ISO-8601 instant ≤ t; a
 *       `due_expression` is never due; a malformed `due_at` never fires;
 *   D7  stalled: Organization-owned lead Opportunity, live status, no closure,
 *       `runtime_authority = 'gu_os'`, and no valid re-entry path.
 *
 * This module reads nothing but the snapshot, and the snapshot has no field
 * for a person's view of the Portfolio — so no rule here can be influenced by
 * what anyone snoozed or hid (TD-9 hard guard; asserted by the selftest).
 */
import {
  interactionIdFor,
  type AttentionClause,
  type AttentionProjection,
  type DurableRef,
  type HumanInteractionPayload,
  type MustSurfacePredicate,
} from "@agents/types";
import type {
  PortfolioCaseSnapshot,
  PortfolioCommitment,
  PortfolioFact,
  PortfolioReconsideration,
  PortfolioWork,
} from "./snapshot";

/** D7 condition 1: the live runtime statuses SL-7 covers. */
const LIVE_RUNTIME_STATUSES = new Set(["active", "waiting_internal", "waiting_external"]);

/** D7: pending executable Work is a valid re-entry path. */
const PENDING_EXECUTABLE = new Set(["todo", "ready", "running"]);

/**
 * The statuses in which the Work a human ask proposed is still unanswered.
 *
 * `done` and `cancelled` close it. `blocked` is deliberately absent: a
 * technical block (`max_attempts_exhausted`) is never "blocked on a human"
 * (S4 §7.7, D4), and recovering technically blocked Work is SL-4's open
 * carry-forward finding, not a human ask.
 */
const ASK_OPEN = new Set(["todo", "ready", "running", "review"]);

const LEAD_OPPORTUNITY = "lead_opportunity";

// ============================================================
// Shared readings of durable truth
// ============================================================

/** The latest reconsideration that has a settlement; an interrupted run has none. */
export function latestSettledReconsideration(
  snapshot: PortfolioCaseSnapshot
): PortfolioReconsideration | null {
  for (let i = snapshot.reconsiderations.length - 1; i >= 0; i -= 1) {
    if (snapshot.reconsiderations[i].settlement) return snapshot.reconsiderations[i];
  }
  return null;
}

/** The Work a settlement proposed that is still open for a human answer. */
export function openAskWork(
  snapshot: PortfolioCaseSnapshot,
  reconsideration: PortfolioReconsideration
): PortfolioWork[] {
  const proposed = new Set(reconsideration.settlement?.proposed_work_ids ?? []);
  return snapshot.work.filter((w) => proposed.has(w.id) && ASK_OPEN.has(w.status));
}

/**
 * The supervisor's open question to a human, if there is one (D4, "blocked on
 * a human"): the latest settled reconsideration left responsibility
 * `waiting_for_human_input`, and the Work it proposed is still open.
 *
 * A settlement that proposed NO Work carries no answerable ask: the recorded
 * rule defines "unanswered" as its proposed Work being open, and the Portfolio
 * answers a question only through that Work. Such a settlement still has the
 * re-entry path it scheduled (`next_action_at`), which the supervisor sets on
 * every settlement.
 */
export function awaitedHumanAsk(
  snapshot: PortfolioCaseSnapshot
): { reconsideration: PortfolioReconsideration; openWork: PortfolioWork[] } | null {
  const latest = latestSettledReconsideration(snapshot);
  if (!latest || latest.settlement?.yield_posture !== "waiting_for_human_input") return null;
  const openWork = openAskWork(snapshot, latest);
  return openWork.length > 0 ? { reconsideration: latest, openWork } : null;
}

/**
 * D7's third re-entry path: a human response currently awaited through the
 * governed human-interaction state — a Work Item in `review`, or a latest
 * settlement of `waiting_for_human_input` or `waiting_for_approval` that has
 * not been answered.
 */
function awaitingHumanResponse(snapshot: PortfolioCaseSnapshot): boolean {
  if (snapshot.work.some((w) => w.status === "review")) return true;
  const latest = latestSettledReconsideration(snapshot);
  const yieldPosture = latest?.settlement?.yield_posture;
  if (!latest || (yieldPosture !== "waiting_for_human_input" && yieldPosture !== "waiting_for_approval")) {
    return false;
  }
  return openAskWork(snapshot, latest).length > 0;
}

/**
 * D7: at least one of — `next_action_at` set, past OR future (there is no
 * timeout anywhere in the rule); pending `todo` / `ready` / `running` Work; or
 * an awaited human response.
 */
export function hasValidReentryPath(snapshot: PortfolioCaseSnapshot): boolean {
  return (
    snapshot.case.next_action_at !== null ||
    snapshot.work.some((w) => PENDING_EXECUTABLE.has(w.status)) ||
    awaitingHumanResponse(snapshot)
  );
}

// ============================================================
// D5 — the due-commitment value contract, read strictly
// ============================================================

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):?(\d{2}))$/i;

/**
 * True only for a full ISO-8601 datetime with an explicit offset or `Z` that
 * names a real instant (D5; Technical Plan TD-14's `commitment.due` contract).
 *
 * The same shape the SL-4 producer writes `due_at` from; the selftest
 * cross-checks the two so the consumer can never accept what the producer
 * would have refused. `Date.parse` alone is not a validator — it rolls
 * `2026-02-30` forward and reads bare numbers as dates.
 */
export function isValidDueInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_INSTANT.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s = "00", , offH = "00", offM = "00"] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    Number(h) <= 23 &&
    Number(mi) <= 59 &&
    Number(s) <= 59 &&
    Number(offH) <= 23 &&
    Number(offM) <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

export type CommitmentDueState = "instant" | "expression" | "contract_violation" | "none";

/**
 * What a commitment's timing is, without ever converting it (D5). A
 * `due_expression` is stated-but-unresolved timing and is shown verbatim; a
 * `due_at` that is not a full instant is a contract violation — never read as
 * a date.
 */
export function commitmentDueState(commitment: PortfolioCommitment): CommitmentDueState {
  if (!commitment.due) return "none";
  const value = commitment.due.value;
  if (!value || typeof value !== "object") return "contract_violation";
  const due = value as { due_at?: unknown; due_expression?: unknown };
  const dueAt = due.due_at ?? null;
  const expression = due.due_expression ?? null;
  if (dueAt !== null) return isValidDueInstant(dueAt) && expression === null ? "instant" : "contract_violation";
  return typeof expression === "string" && expression.trim() !== "" ? "expression" : "contract_violation";
}

function factField(fact: PortfolioFact | null, field: string): unknown {
  if (!fact || !fact.value || typeof fact.value !== "object") return undefined;
  return (fact.value as Record<string, unknown>)[field];
}

function isDueAdvisorCommitment(commitment: PortfolioCommitment, now: Date): boolean {
  if (factField(commitment.status, "status") !== "open") return false;
  if (factField(commitment.actor, "actor") !== "advisor") return false;
  if (commitmentDueState(commitment) !== "instant") return false;
  const dueAt = factField(commitment.due, "due_at") as string;
  return Date.parse(dueAt) <= now.getTime();
}

// ============================================================
// Refs and item assembly
// ============================================================

const caseRef = (snapshot: PortfolioCaseSnapshot): DurableRef => ({ kind: "case", id: snapshot.case.id });
const workRef = (work: PortfolioWork): DurableRef => ({ kind: "work_item", id: work.id });
const factRef = (fact: PortfolioFact): DurableRef => ({ kind: "case_fact", id: fact.id, fact_key: fact.fact_key });
const eventRef = (id: string, eventKind: string): DurableRef => ({ kind: "case_event", id, event_kind: eventKind });

function clause(code: string, refs: DurableRef[], values: Record<string, string | null> = {}): AttentionClause {
  return { code, refs, values };
}

function item(params: {
  snapshot: PortfolioCaseSnapshot;
  predicate: MustSurfacePredicate;
  interaction: HumanInteractionPayload;
  why: AttentionClause;
  what: AttentionClause;
  whyNow: AttentionClause;
  since: string | null;
}): AttentionProjection {
  return {
    v: 1,
    id: `${params.predicate}:${params.interaction.interaction_id}`,
    case_id: params.snapshot.case.id,
    predicate: params.predicate,
    must_surface: true,
    why: params.why,
    what_gu_needs: params.what,
    why_now: params.whyNow,
    interaction: params.interaction,
    since: params.since,
  };
}

// ============================================================
// The six rules
// ============================================================

/**
 * Pending approval / protected decision — rule only until SL-9 (D4).
 *
 * Exits when decided from ANY surface: a recorded decision on the same basis
 * (approval kind + pinned evidence hash) answers the request, wherever it was
 * taken. That is S4 §13's "resolved in Telegram ⇒ the web must not ask again",
 * and invariant 22's "no duplicate effect from a second ask". A mechanical
 * `suspended` is not a human decision and answers nothing.
 */
function pendingApproval(snapshot: PortfolioCaseSnapshot): AttentionProjection[] {
  return snapshot.approval_requests
    .filter((request) => request.withdrawn_at === null && request.superseded_by === null)
    .filter(
      (request) =>
        !snapshot.approval_decisions.some(
          (decision) =>
            decision.approval_kind === request.approval_kind &&
            decision.evidence_hash === request.evidence_hash &&
            decision.decision !== "suspended" &&
            Date.parse(decision.decided_at) >= Date.parse(request.requested_at)
        )
    )
    .map((request) => {
      const ref: DurableRef = { kind: "approval_request", id: request.request_id };
      return item({
        snapshot,
        predicate: "pending_approval",
        interaction: {
          v: 1,
          interaction: "approval_request",
          interaction_id: interactionIdFor(ref),
          case_id: snapshot.case.id,
          organization_id: snapshot.case.organization_id,
          requested_by: request.requested_by_work_item_id
            ? { kind: "agent", ref: { kind: "work_item", id: request.requested_by_work_item_id } }
            : { kind: "system", ref: null },
          requested_at: request.requested_at,
          evidence_refs: [ref],
          approval_kind: request.approval_kind,
          decision_subject: request.decision_subject,
          consequence: request.consequence,
          evidence_hash: request.evidence_hash,
          evidence_snapshot: request.evidence_snapshot,
          recommendation: null,
        },
        why: clause("approval_pending", [ref], { approval_kind: request.approval_kind }),
        what: clause("decide_protected_decision", [ref], { decision_subject: request.decision_subject }),
        whyNow: clause("protected_decision_blocks_progress", [ref], {
          requested_at: request.requested_at,
          consequence: request.consequence,
        }),
        since: request.requested_at,
      });
    });
}

/**
 * Blocked on a human — live (D4): the supervisor's open question, answered
 * through the Work it proposed; or any Work Item in `review`. Each open Work
 * Item is one item, because each is answered separately.
 */
function blockedOnHuman(snapshot: PortfolioCaseSnapshot): AttentionProjection[] {
  const items: AttentionProjection[] = [];
  const covered = new Set<string>();

  const ask = awaitedHumanAsk(snapshot);
  if (ask) {
    const settlement = ask.reconsideration.settlement!;
    const settledRef = eventRef(settlement.event_id, "supervisor_reconsideration_settled");
    const claimRef = eventRef(ask.reconsideration.claim_event_id, "supervisor_reconsidered");
    for (const work of ask.openWork) {
      covered.add(work.id);
      const question = work.purpose ?? work.work_type;
      items.push(
        item({
          snapshot,
          predicate: "blocked_on_human",
          interaction: {
            v: 1,
            interaction: "information_request",
            interaction_id: interactionIdFor(workRef(work)),
            case_id: snapshot.case.id,
            organization_id: snapshot.case.organization_id,
            requested_by: { kind: "agent", ref: claimRef },
            requested_at: settlement.settled_at,
            evidence_refs: [settledRef, workRef(work)],
            question,
            work_item_id: work.id,
          },
          why: clause("supervisor_awaits_human_input", [settledRef, claimRef], {
            rationale: ask.reconsideration.rationale || null,
            diagnosis: ask.reconsideration.diagnosis,
          }),
          what: clause("answer_targeted_question", [workRef(work)], {
            question,
            work_type: work.work_type,
          }),
          whyNow: clause("ask_unanswered", [settledRef, workRef(work)], {
            since: settlement.settled_at,
            work_status: work.status,
          }),
          since: settlement.settled_at,
        })
      );
    }
  }

  for (const work of snapshot.work) {
    if (work.status !== "review" || covered.has(work.id)) continue;
    const expected = work.purpose ?? work.work_type;
    items.push(
      item({
        snapshot,
        predicate: "blocked_on_human",
        interaction: {
          v: 1,
          interaction: "human_work_request",
          interaction_id: interactionIdFor(workRef(work)),
          case_id: snapshot.case.id,
          organization_id: snapshot.case.organization_id,
          requested_by: { kind: "system", ref: workRef(work) },
          requested_at: work.updated_at,
          evidence_refs: [workRef(work)],
          expected,
          work_item_id: work.id,
          commitment_subject_id: null,
        },
        why: clause("work_awaits_human_review", [workRef(work)], { work_type: work.work_type }),
        what: clause("complete_human_review", [workRef(work)], { expected }),
        whyNow: clause("work_cannot_finish_without_human", [workRef(work)], {
          work_status: work.status,
          since: work.updated_at,
        }),
        since: work.updated_at,
      })
    );
  }
  return items;
}

/** Due commitment — live, exactly D5. */
function dueCommitment(snapshot: PortfolioCaseSnapshot, now: Date): AttentionProjection[] {
  return snapshot.commitments
    .filter((commitment) => isDueAdvisorCommitment(commitment, now))
    .map((commitment) => {
      const subjectRef: DurableRef = {
        kind: "case_subject",
        id: commitment.subject_id,
        subject_kind: "commitment",
      };
      const dueFact = commitment.due!;
      const dueAt = factField(dueFact, "due_at") as string;
      const expected =
        (factField(commitment.expected_outcome, "expected_outcome") as string | undefined) ??
        commitment.label ??
        "";
      return item({
        snapshot,
        predicate: "due_commitment",
        interaction: {
          v: 1,
          interaction: "human_work_request",
          interaction_id: interactionIdFor(subjectRef),
          case_id: snapshot.case.id,
          organization_id: snapshot.case.organization_id,
          requested_by: { kind: "agent", ref: subjectRef },
          requested_at: dueAt,
          evidence_refs: [subjectRef, factRef(dueFact)],
          expected,
          work_item_id: null,
          commitment_subject_id: commitment.subject_id,
        },
        why: clause("advisor_commitment_due", [subjectRef, factRef(commitment.actor!), factRef(commitment.status!)], {
          actor: "advisor",
          status: "open",
        }),
        what: clause(
          "fulfil_commitment",
          [commitment.expected_outcome ? factRef(commitment.expected_outcome) : subjectRef],
          { expected_outcome: expected }
        ),
        whyNow: clause("due_instant_reached", [factRef(dueFact)], { due_at: dueAt }),
        since: dueAt,
      });
    });
}

/** Authority conflict — live from SL-6 `authority_resolutions`. The uncertainty is literal. */
function authorityConflict(snapshot: PortfolioCaseSnapshot): AttentionProjection[] {
  const conflict = snapshot.authority_conflict;
  if (!conflict) return [];
  const ref: DurableRef = { kind: "authority_resolution", id: conflict.resolution_id };
  return [
    item({
      snapshot,
      predicate: "authority_conflict",
      interaction: {
        v: 1,
        interaction: "exception_review",
        exception: "authority_conflict",
        authority_state: conflict.state,
        interaction_id: interactionIdFor(ref),
        case_id: snapshot.case.id,
        organization_id: snapshot.case.organization_id,
        requested_by: { kind: "system", ref },
        requested_at: conflict.detected_at,
        evidence_refs: [ref],
      },
      why: clause("authority_unresolved", [ref], { authority_state: conflict.state }),
      what: clause("review_interaction_authority", [ref]),
      whyNow: clause("effects_suppressed_until_resolved", [ref], { detected_at: conflict.detected_at }),
      since: conflict.detected_at,
    }),
  ];
}

/** Effect with an unknown outcome — rule only until SL-9 (D4). Never success. */
function unknownOutcomeEffect(snapshot: PortfolioCaseSnapshot): AttentionProjection[] {
  return snapshot.effect_operations
    .filter((op) => op.status === "unknown_outcome")
    .map((op) => {
      const ref: DurableRef = { kind: "external_effect_operation", id: op.id };
      return item({
        snapshot,
        predicate: "unknown_outcome_effect",
        interaction: {
          v: 1,
          interaction: "exception_review",
          exception: "unknown_effect_outcome",
          capability: op.capability,
          outcome: "unknown_outcome",
          interaction_id: interactionIdFor(ref),
          case_id: snapshot.case.id,
          organization_id: snapshot.case.organization_id,
          requested_by: { kind: "system", ref },
          requested_at: op.updated_at,
          evidence_refs: [ref],
        },
        why: clause("effect_outcome_unknown", [ref], { capability: op.capability }),
        what: clause("reconcile_effect_outcome", [ref]),
        whyNow: clause("no_blind_retry", [ref], { since: op.updated_at }),
        since: op.updated_at,
      });
    });
}

/**
 * Stalled integrity — exactly D7. Under `legacy` authority the absence of a
 * Gu OS path is not a Gu OS stall (Gu OS observes that responsibility, it does
 * not own it); under `gu_os` a Case with no re-entry path is stalled at once,
 * even if Gu OS never reconsidered it. No timeout exists in this rule.
 */
function stalled(snapshot: PortfolioCaseSnapshot): AttentionProjection[] {
  const c = snapshot.case;
  if (c.case_type !== LEAD_OPPORTUNITY) return [];
  if (!LIVE_RUNTIME_STATUSES.has(c.status)) return [];
  if (snapshot.closure) return [];
  if (c.runtime_authority !== "gu_os") return [];
  if (hasValidReentryPath(snapshot)) return [];

  const ref = caseRef(snapshot);
  return [
    item({
      snapshot,
      predicate: "stalled",
      interaction: {
        v: 1,
        interaction: "exception_review",
        exception: "stalled_responsibility",
        runtime_authority: "gu_os",
        interaction_id: interactionIdFor(ref),
        case_id: c.id,
        organization_id: c.organization_id,
        requested_by: { kind: "system", ref },
        requested_at: null,
        evidence_refs: [ref],
      },
      why: clause("gu_os_owns_responsibility", [ref], { runtime_authority: "gu_os", status: c.status }),
      what: clause("establish_reentry_path", [ref]),
      whyNow: clause("no_reentry_path", [ref], { next_action_at: null }),
      since: null,
    }),
  ];
}

/**
 * Every governed must-surface item of one Case, in a deterministic, neutral
 * order: the need that has waited longest first, then the predicate list order
 * for ties, then identity. Must-surface is eligibility, not priority (S4
 * §6.5), so this order claims nothing about consequence; contextual ranking is
 * SL-12's, behind its own eval.
 */
export function evaluateMustSurface(
  snapshot: PortfolioCaseSnapshot,
  now: Date
): AttentionProjection[] {
  const all = [
    ...pendingApproval(snapshot),
    ...blockedOnHuman(snapshot),
    ...dueCommitment(snapshot, now),
    ...authorityConflict(snapshot),
    ...unknownOutcomeEffect(snapshot),
    ...stalled(snapshot),
  ];
  return all.sort(compareAttention);
}

const PREDICATE_ORDER: Record<MustSurfacePredicate, number> = {
  pending_approval: 0,
  blocked_on_human: 1,
  due_commitment: 2,
  authority_conflict: 3,
  unknown_outcome_effect: 4,
  stalled: 5,
};

export function compareAttention(a: AttentionProjection, b: AttentionProjection): number {
  // Instants, not strings: PostgREST's `+00:00` and a producer's `Z` spell the
  // same moment differently, and do not sort the same lexically.
  const left = a.since === null ? null : Date.parse(a.since);
  const right = b.since === null ? null : Date.parse(b.since);
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  }
  const byPredicate = PREDICATE_ORDER[a.predicate] - PREDICATE_ORDER[b.predicate];
  return byPredicate !== 0 ? byPredicate : a.id.localeCompare(b.id);
}
