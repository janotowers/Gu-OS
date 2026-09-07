/**
 * Business closure of an Opportunity — the canonical `opportunity.closure`
 * representation and its controlled reason registry.
 *
 * Ownership (Technical Plan §11, TD-8; human ownership decision 2026-09-06):
 * TD-8's fact-key namespace is settled incrementally by the Slice that first
 * needs each part. SL-2 settled the admission-relevant keys; **SL-3 settles
 * this one**, because SA-3.1 and SA-3.11 require a durable `duplicate` /
 * `superseded` closure carrying reason, evidence and provenance, and no
 * earlier Slice needed it. SL-8 CONSUMES this vocabulary and may extend the
 * reason registry where its own approved behavior requires — it must never
 * define a second or parallel closure representation.
 *
 * What this module deliberately does NOT do:
 *
 *  - **invent product semantics.** S1 §8.10 owns the closure-outcome taxonomy
 *    and it is reproduced here unchanged. This module adds the *representation*
 *    and the minimum controlled reasons SL-3's two flows need to be expressed
 *    truthfully — not a final taxonomy of every closure reason Gu will ever
 *    record;
 *  - **assert a runtime transition.** S1 §8.7 keeps business closure and
 *    runtime status separate. Recording a closure states the business result
 *    and nothing about `operational_cases.status`;
 *  - **close anything by itself.** ADR-109 §4 forbids a relationship mutation
 *    from touching either Case row, so canonicalization is deliberately TWO
 *    governed operations: the lineage edge, and this closure fact. Neither
 *    half is the other, and a half-completed pair is never a resolution.
 */
import type { CaseRelationshipActorKind } from "./case-relationships";

/**
 * S1 §8.10, verbatim in substance. The approved product-level taxonomy — a
 * "stable business result category", as distinct from the more specific
 * reason and from the supporting evidence.
 *
 * All five are approved product truth. SL-3 only *produces* `duplicate` and
 * `superseded`; the rest are here because the representation is shared and a
 * consumer must be able to read a closure this Slice did not write.
 */
export const OPPORTUNITY_CLOSURE_OUTCOMES = [
  /** The intended commercial objective was fulfilled through an attributable path. */
  "objective_achieved",
  /** Valid, but ended without the brokerage achieving the intended result. */
  "lost",
  /** Should not have represented a valid Opportunity — spam, test, erroneous admission. */
  "invalid",
  /** The same objective is represented by another canonical Opportunity. */
  "duplicate",
  /** Responsibility was intentionally replaced by another durable structure. */
  "superseded",
] as const;

export type OpportunityClosureOutcome =
  (typeof OPPORTUNITY_CLOSURE_OUTCOMES)[number];

/**
 * The controlled reason registry — the canonical seam later Slices consume.
 *
 * S1 §8.10 defines `closure_reason` as the "more specific explanation" and
 * illustrates it with examples rather than enumerating it, precisely because
 * the full set is not knowable in advance. So this is a *registry*, not a
 * closed product taxonomy: each entry binds one reason to the single outcome
 * it may explain, and a Slice adds entries only for closures its own approved
 * behavior actually produces.
 *
 * SL-3 registers exactly two, one per flow it delivers. Neither is a trigger:
 * SL-3 contracts what must be true *after* a governed determination and
 * explicitly does not invent a rule for when Gu should decide one Opportunity
 * supersedes another (ADR-109 §7 leaves survivor/reconciliation algorithms
 * downstream).
 */
export const OPPORTUNITY_CLOSURE_REASONS = {
  /**
   * Two Opportunities were determined to represent the same underlying
   * objective, and this one is not the canonical survivor (S1 §8.6, AC-15).
   *
   * Entity-level canonicalization. NOT event-level idempotency: SL-2's
   * `dedup_key` prevents one inbound event producing two Cases, which is a
   * different guarantee, and conflating the two in either direction would be
   * wrong.
   */
  same_objective_canonicalized: "duplicate",
  /**
   * An authorized/governed determination replaced this durable responsibility
   * with a successor Opportunity, for a reason other than duplicate
   * correction (S1 §8.10 `superseded`).
   *
   * Deliberately not registered for a Transaction successor: ADR-109 keeps
   * `transaction_association` non-destructive — recognizing a Transaction
   * boundary leaves the Opportunity open alongside it and supersedes nothing.
   */
  replaced_by_successor_opportunity: "superseded",
} as const satisfies Record<string, OpportunityClosureOutcome>;

export type OpportunityClosureReason = keyof typeof OPPORTUNITY_CLOSURE_REASONS;

export const OPPORTUNITY_CLOSURE_REASON_LIST: readonly OpportunityClosureReason[] =
  Object.keys(OPPORTUNITY_CLOSURE_REASONS) as OpportunityClosureReason[];

/** The outcome a registered reason may explain, or `null` if unregistered. */
export function outcomeForClosureReason(
  reason: string
): OpportunityClosureOutcome | null {
  return (
    (OPPORTUNITY_CLOSURE_REASONS as Record<string, OpportunityClosureOutcome>)[
      reason
    ] ?? null
  );
}

/**
 * Whether this reason is registered as an explanation of this outcome.
 *
 * The pairing is the guarantee the registry exists for: an
 * `objective_achieved` closure explained by `same_objective_canonicalized`
 * would be a coherent-looking record of something that never happened.
 */
export function closureReasonExplains(
  outcome: OpportunityClosureOutcome,
  reason: string
): reason is OpportunityClosureReason {
  return outcomeForClosureReason(reason) === outcome;
}

/**
 * TD-8 fact key. One key for the closure, following the two rules SL-2 settled
 * for this namespace: no entity id inside a `fact_key`, and keys are stable
 * business vocabulary rather than implementation names.
 *
 * The counterpart Case travels in the value, not the key — which is what keeps
 * the namespace enumerable without string parsing.
 */
export const OPPORTUNITY_CLOSURE_FACT_KEY = "opportunity.closure" as const;

/**
 * The canonical `opportunity.closure` fact value.
 *
 * S1 §8.10's three parts map exactly: `outcome` is the stable category,
 * `reason` the specific explanation, and `evidence_refs` + `determination`
 * carry why the brokerage can assert it. Actor travels with the closure
 * because ADR-109 §8 requires lineage mutations to carry authority and
 * evidence, and S1 §8.16 requires closing to leave auditability — a closure
 * whose actor is unrecoverable satisfies neither.
 *
 * Provenance beyond this value is the `case_facts` row's own: `source_kind`,
 * `source_ref` and `recorded_at`, plus append-only supersession history. This
 * shape deliberately does not restate them.
 */
export interface OpportunityClosureFactValue {
  outcome: OpportunityClosureOutcome;
  reason: OpportunityClosureReason;
  /**
   * The Case that carries the surviving responsibility — the canonical
   * Opportunity for `duplicate`, the successor for `superseded`.
   *
   * Not optional for the reasons SL-3 registers: "this one is the duplicate"
   * is not a complete business result without saying *of what*. A future
   * registered reason that genuinely has no counterpart may carry `null`.
   */
  counterpart_case_id: string | null;
  /** Who determined it. Mirrors the lineage edge's actor, by construction. */
  actor_kind: CaseRelationshipActorKind;
  actor_user_id: string | null;
  /**
   * Structured evidence references, the same shape the lineage edge carries in
   * `evidence_refs_jsonb`, so both halves of a resolution can be explained
   * from either side without a join through free text.
   */
  evidence_refs: Record<string, unknown>;
  /**
   * The determining actor's own explanation, when one was supplied. Free text
   * on purpose and never load-bearing: it explains, the controlled `reason`
   * classifies. Nothing branches on this string.
   */
  determination: string | null;
}

/**
 * Structural validation of a closure value before it is written.
 *
 * Deterministic guarantee, not model judgment (Methodology §13): whether two
 * Opportunities represent one objective is semantic and belongs to the model;
 * whether the resulting record is internally coherent is not, and is enforced
 * here. Returns the problems rather than throwing so a caller can decide
 * whether an incoherent determination is a fault or a refusal.
 */
export function validateOpportunityClosure(
  value: OpportunityClosureFactValue
): string[] {
  const problems: string[] = [];

  if (!OPPORTUNITY_CLOSURE_OUTCOMES.includes(value.outcome)) {
    problems.push(`unknown closure outcome: ${String(value.outcome)}`);
  }
  const registeredOutcome = outcomeForClosureReason(value.reason);
  if (registeredOutcome === null) {
    problems.push(`unregistered closure reason: ${String(value.reason)}`);
  } else if (registeredOutcome !== value.outcome) {
    problems.push(
      `closure reason '${value.reason}' explains '${registeredOutcome}', not '${value.outcome}'`
    );
  }
  if (
    (value.reason === "same_objective_canonicalized" ||
      value.reason === "replaced_by_successor_opportunity") &&
    !value.counterpart_case_id
  ) {
    problems.push(`closure reason '${value.reason}' requires a counterpart Case`);
  }
  if (value.actor_kind === "human" && !value.actor_user_id) {
    problems.push("a human closure determination must name the deciding user");
  }

  return problems;
}
