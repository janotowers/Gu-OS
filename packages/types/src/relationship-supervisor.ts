/**
 * Case Supervisor vocabulary for Relationship Operations (S2 / Technical Plan
 * TD-8, R1 SL-4 — shadow).
 *
 * S2's thesis is that a wake-up is *reconsideration, not action*: a timer or an
 * event must never mechanically imply a message or any other external effect
 * (§8.1 invariant 1). Everything in this module exists to make that
 * reconsideration's **result** durable and inspectable, so a later reader — or
 * a replay — can reconstruct what Gu concluded, why, and where it left durable
 * responsibility, without any session, transcript or model memory (§8.22).
 *
 * The two taxonomies below are deliberately separate, because S2 keeps them
 * separate and they answer different questions:
 *
 *   SupervisorPosture       — §8.2  "what work did this reconsideration choose?"
 *   SupervisorYieldPosture  — §8.21 "where was durable responsibility left?"
 *
 * A reconsideration that chooses NO-OP still has to land responsibility
 * somewhere coherent, and "no useful work exists now" is a different fact from
 * "waiting for the prospect". Collapsing them would lose exactly the
 * distinction §8.21's stopping conditions are written around.
 */

// ============================================================
// Wake reason
// ============================================================

/**
 * Why this reconsideration ran.
 *
 * S2 §6.2 lists fourteen triggering situations at product level. This registry
 * carries only the ones a **shadow SL-4 supervisor can actually observe**:
 * scheduled reconsideration and the SL-2 `source_events` inbox, plus commitment
 * due dates and prior Work settlement, which are its own durable state.
 * Declaring the rest now would be vocabulary nothing writes — signed legacy
 * event forwarding is SL-5/C1, observable takeover and authority change are
 * SL-6/C2, and appointment and visit-outcome signals are SL-8.
 *
 * S2 §6.3 is the other half of the contract and is enforced deterministically
 * rather than typed: none of these values, on its own, licenses a
 * prospect-facing action.
 */
export type SupervisorWakeReason =
  /** A scheduled reconsideration point came due (`next_action_at`). */
  | "scheduled_reconsideration"
  /** A commitment's own due moment arrived (§8.13). */
  | "commitment_due"
  /** An inbound source event was admitted into the Case (SL-2 inbox). */
  | "source_event"
  /** Prior Work completed or failed and its result may change the plan (§8.18). */
  | "prior_work_settled"
  /** An operator asked for a reconsideration — hosted verification and replay. */
  | "manual";

export const SUPERVISOR_WAKE_REASONS: readonly SupervisorWakeReason[] = [
  "scheduled_reconsideration",
  "commitment_due",
  "source_event",
  "prior_work_settled",
  "manual",
] as const;

// ============================================================
// Chosen posture — S2 §8.2
// ============================================================

/**
 * The posture a reconsideration chose. Mirrors S2 §8.2's "choose one posture"
 * block one-for-one, including the ones a shadow Slice can never reach — the
 * vocabulary is the Spec's, not this Slice's, and truncating it here would make
 * SL-9's postures look like new product behavior when they are already
 * approved.
 *
 * Which of these SL-4 may actually record is a separate, deterministic
 * question: see `SHADOW_REACHABLE_POSTURES`.
 */
export type SupervisorPosture =
  /** No useful, allowed work exists now (§8.1 invariant 8, AC-01, EC-20). */
  | "no_op"
  /** Waiting is the chosen strategy, with a real re-entry path (§8.19, EC-39). */
  | "wait"
  /** Gather, research or reconcile — work that improves the next decision (§8.5, §8.6). */
  | "gather_research_reconcile"
  /** Create or continue durable Work Items (§8.16, AC-28). */
  | "work"
  /** Execute an authorized external effect. */
  | "act"
  /** Execute and inform a human of what was done. */
  | "act_and_inform"
  /** Ask the smallest human question that materially helps (§8.1 invariant 13, AC-12). */
  | "targeted_human_input"
  /** Prepare a protected commitment and route it to approval (§8.1 invariant 14, AC-11). */
  | "prepare_and_approval"
  /** A human performs the effect Gu cannot (bounded degradation). */
  | "human_as_executor"
  /** A human takes conversational leadership (§8.10, §8.11, AC-13). */
  | "human_takeover_support";

export const SUPERVISOR_POSTURES: readonly SupervisorPosture[] = [
  "no_op",
  "wait",
  "gather_research_reconcile",
  "work",
  "act",
  "act_and_inform",
  "targeted_human_input",
  "prepare_and_approval",
  "human_as_executor",
  "human_takeover_support",
] as const;

/**
 * The postures reachable while the pilot is in the **shadow** stage
 * (Technical Plan §5: SL-0…SL-8b, no prospect-facing effects).
 *
 * The four excluded ones are excluded for a reason the Slice contract states,
 * not for convenience: `act` / `act_and_inform` are prospect-facing effects
 * (SL-9, SL-10, gated on C3/C6/C7); `prepare_and_approval` gates such an
 * effect and has nothing to gate yet; `human_as_executor` is the C7 degraded
 * effect path; and `human_takeover_support` is runtime-authority transfer
 * (SL-6 advisory, SL-11 enforcing, gated on C2).
 *
 * `targeted_human_input` **is** reachable — it is an internal ask, not an
 * external effect — but in SL-4 it is a recorded posture plus `agent_proposed`
 * Work, never a delivered request: the advisor-facing surface is S4/SL-7.
 *
 * SA-4.8 asserts this negatively rather than assuming it: no prospect-facing
 * effect may be reachable from this Slice at all.
 */
export const SHADOW_REACHABLE_POSTURES: readonly SupervisorPosture[] = [
  "no_op",
  "wait",
  "gather_research_reconcile",
  "work",
  "targeted_human_input",
] as const;

export function isShadowReachablePosture(posture: SupervisorPosture): boolean {
  return SHADOW_REACHABLE_POSTURES.includes(posture);
}

/**
 * Postures that count as a deliberate absence of action for the SA-4.9
 * no-op-rate observation.
 *
 * `wait` is included with `no_op` because S2 treats both as legitimate,
 * intentional outcomes rather than failures (§8.19: "waiting as a strategy";
 * EC-20, EC-40). **No target ratio is asserted anywhere in this codebase** —
 * the approved Definition-of-Done evidence says the ratio must be
 * *observable*, and no governing artifact approves a number. Inventing one
 * would manufacture a product threshold the Slice does not own.
 */
export const NO_ACTION_POSTURES: readonly SupervisorPosture[] = ["no_op", "wait"] as const;

// ============================================================
// Yield posture — S2 §8.21
// ============================================================

/**
 * Where the reconsideration left durable responsibility. S2 §8.21: a
 * reconsideration may complete only when responsibility sits coherently in one
 * of these, and "yielding is safe only after durable responsibility has
 * somewhere coherent to go next".
 *
 * This is the vocabulary the SA-4.11 safe-yield check is written against, so it
 * is a deterministic gate rather than a descriptive label.
 */
export type SupervisorYieldPosture =
  | "work_underway"
  | "waiting_for_prospect"
  | "waiting_for_human_input"
  | "waiting_for_approval"
  | "human_leads_conversation"
  | "waiting_for_external_signal"
  | "reconciliation_established"
  | "waiting_until_time"
  | "no_useful_work_now"
  | "lifecycle_reassessment_needed"
  | "coordinate_with_other_case";

export const SUPERVISOR_YIELD_POSTURES: readonly SupervisorYieldPosture[] = [
  "work_underway",
  "waiting_for_prospect",
  "waiting_for_human_input",
  "waiting_for_approval",
  "human_leads_conversation",
  "waiting_for_external_signal",
  "reconciliation_established",
  "waiting_until_time",
  "no_useful_work_now",
  "lifecycle_reassessment_needed",
  "coordinate_with_other_case",
] as const;

/**
 * Why a reconsideration produced no grounded judgment.
 *
 * SA-4.11's subject. When model execution fails or the available evidence is
 * insufficient, the Supervisor must **not** manufacture certainty, unsupported
 * work or a consequential effect — it preserves the uncertainty and leaves a
 * legitimate re-entry path (S2 invariants 36, 45, 46; §8.21, §8.22). These
 * values name what was preserved, so "we could not judge" never has to be
 * inferred from the absence of a posture.
 */
export type SupervisorUncertaintyKind =
  /** The model seam returned no judgment at all (unavailable, invalid output). */
  | "no_judgment_available"
  /** A judgment was returned but the evidence behind it was insufficient. */
  | "insufficient_evidence"
  /** A required capability does not exist (S2 invariant 36, EC-25, AC-37). */
  | "capability_gap";

export const SUPERVISOR_UNCERTAINTY_KINDS: readonly SupervisorUncertaintyKind[] = [
  "no_judgment_available",
  "insufficient_evidence",
  "capability_gap",
] as const;

// ============================================================
// The durable record of one reconsideration
// ============================================================

/**
 * `payload.kind` discriminator for the reconsideration event, following TD-11:
 * use CURRENT event types with a payload discriminator rather than migrating a
 * CHECK constraint.
 *
 * The **ordered posture history of an Opportunity is this event stream** — the
 * timeline is append-only and per-Case, which is precisely what SA-4.2 ("result
 * and rationale, inspectable per Case") and SA-4.3 ("coherent and ordered
 * across multiple days") require, and it is where Technical Plan §7 already
 * assigns "supervisor posture/no-op ratios". No new fact key and no new table
 * is introduced to hold it.
 */
export const SUPERVISOR_RECONSIDERED_EVENT_KIND = "supervisor_reconsidered" as const;

/**
 * `payload.kind` of the settlement that closes one reconsideration.
 *
 * A reconsideration is **two durable writes, not one**, for the same reason
 * SL-3's canonicalization was: the first claims the wake under the
 * M-WAKE-IDENTITY unique index, so a duplicate delivery conflicts *before* it
 * can create Work or commitments; the second records what that reconsideration
 * actually produced. The timeline is append-only, so the outcome cannot be
 * folded back into the claim by editing it.
 *
 * A reconsideration with no settlement is therefore a **recoverable
 * interrupted run**, not a corrupt one: the wake is claimed, nothing durable
 * was silently half-created, and the gap is visible rather than inferred.
 */
export const SUPERVISOR_SETTLED_EVENT_KIND =
  "supervisor_reconsideration_settled" as const;

/** What one reconsideration produced. Written after the wake is claimed. */
export interface SupervisorReconsiderationSettlement {
  kind: typeof SUPERVISOR_SETTLED_EVENT_KIND;
  v: 1;
  wake_key: string;
  yield_posture: SupervisorYieldPosture;
  proposed_work_ids: readonly string[];
  commitment_subject_ids: readonly string[];
}

/**
 * One reconsideration, as it lands on the Case timeline.
 *
 * Everything needed to reconstruct the decision is here, and nothing that would
 * make reconstruction depend on a session: no transcript, no message ids, no
 * model context. `rationale` is the human- and rubric-readable explanation S2
 * §15 requires for next-work semantic choice.
 */
export interface SupervisorReconsiderationRecord {
  kind: typeof SUPERVISOR_RECONSIDERED_EVENT_KIND;
  /** Contract version of this payload shape. */
  v: 1;
  wake_reason: SupervisorWakeReason;
  /**
   * Durable identity of the logical wake this reconsideration answers.
   * SA-4.6: repeated delivery of the same logical wake is coalesced on this,
   * so a redelivery creates no second reconsideration.
   */
  wake_key: string;
  posture: SupervisorPosture;
  yield_posture: SupervisorYieldPosture;
  /** Why this posture, in terms of the evidence available at this moment. */
  rationale: string;
  /**
   * The constraint or opportunity diagnosed before any posture was chosen
   * (S2 §8.1 invariant 3: diagnose before acting). Null when the evidence did
   * not support a diagnosis — which is itself a finding, not a blank.
   */
  diagnosis: string | null;
  /** Preserved uncertainty, when there was any (SA-4.11). Never inferred. */
  uncertainty: SupervisorUncertaintyKind | null;
  /** `work_items.id` created as `agent_proposed` by this reconsideration. */
  proposed_work_ids: readonly string[];
  /** `case_subjects.id` of commitments this reconsideration recorded or changed. */
  commitment_subject_ids: readonly string[];
  /**
   * The next wake condition left behind, in durable terms. S2 §8.22 requires a
   * *meaningful* one; EC-39 forbids leaving an open Case dependent on human
   * memory. `null` is legitimate only alongside a yield posture that names an
   * external signal to wait for.
   */
  next_action_at: string | null;
  /** Shadow-stage assertion carried in the record itself, never inferred. */
  stage: "shadow";
  /** Which model produced the judgment, when one did. Evidence has to say. */
  model_id: string | null;
  policy_version: number | null;
}

// ============================================================
// Commitments — TD-14 subject-scoped facts
// ============================================================

/**
 * The four commitment fact keys, named verbatim by TD-14.
 *
 * Clean keys with no entity id inside them (SA-4.4): the Commitment's identity
 * is the `case_subjects` row these facts are scoped to.
 */
export const COMMITMENT_FACT_KEYS = {
  expectedOutcome: "commitment.expected_outcome",
  actor: "commitment.actor",
  due: "commitment.due",
  status: "commitment.status",
} as const;

export type CommitmentFactKey =
  (typeof COMMITMENT_FACT_KEYS)[keyof typeof COMMITMENT_FACT_KEYS];

export const COMMITMENT_FACT_KEY_LIST: readonly CommitmentFactKey[] = [
  COMMITMENT_FACT_KEYS.expectedOutcome,
  COMMITMENT_FACT_KEYS.actor,
  COMMITMENT_FACT_KEYS.due,
  COMMITMENT_FACT_KEYS.status,
] as const;

/**
 * Who is reasonably expected to act. S2 §8.13: a commitment may originate from
 * Gu, an advisor/human, the prospect, or a relevant external actor/system.
 */
export type CommitmentActor = "gu" | "advisor" | "prospect" | "external";

export const COMMITMENT_ACTORS: readonly CommitmentActor[] = [
  "gu",
  "advisor",
  "prospect",
  "external",
] as const;

/**
 * S2 §8.15's lifecycle, and the reason a Commitment is a subject rather than a
 * row with a status column: every one of these is a superseding fact, so the
 * history stays reconstructible.
 *
 * `fulfilled` requires **evidence that the expected outcome occurred** — not a
 * passed deadline, not a Work Item that ran, not an API request that was
 * attempted. `unresolved` is the honest state when the outcome is unknown, and
 * an unknown outcome is never converted into a negative one.
 */
export type CommitmentStatus =
  | "open"
  | "fulfilled"
  | "changed"
  | "cancelled"
  | "superseded"
  | "unresolved";

export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = [
  "open",
  "fulfilled",
  "changed",
  "cancelled",
  "superseded",
  "unresolved",
] as const;

/** The `commitment.due` fact value. */
export interface CommitmentDueFactValue {
  /** ISO-8601 instant the expected outcome is relied upon by. */
  due_at: string;
  /** How the moment was established, for provenance. */
  basis: "stated" | "inferred_from_context";
}

/** The `commitment.status` fact value. */
export interface CommitmentStatusFactValue {
  status: CommitmentStatus;
  /**
   * Evidence supporting the status. Required for `fulfilled` by S2 §8.15 —
   * satisfaction is proven, not assumed from elapsed time.
   */
  evidence_refs: readonly string[];
  note: string | null;
}
