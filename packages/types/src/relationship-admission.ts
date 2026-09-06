/**
 * Relationship Operations admission vocabulary (S1 / Technical Plan TD-8).
 *
 * SL-2 scope: shadow admission only. Everything here describes *whether Gu
 * takes durable responsibility* for a lead. It grants no runtime authority, no
 * conversation authority and no prospect-facing capability (ADR-107).
 */

import type { EffectivePolicyAttribution } from "./organization-policies";

/**
 * The recorded outcome of evaluating one inbound lead record.
 *
 * `deferred_clarification` is a first-class result, not a failure: S1 AC-02 and
 * EC-01 require an ambiguous opener to leave no Opportunity Case while
 * remaining eligible for clarification.
 */
export type AdmissionDisposition =
  | "admitted"
  | "not_admitted"
  | "deferred_clarification";

export const ADMISSION_DISPOSITIONS: readonly AdmissionDisposition[] = [
  "admitted",
  "not_admitted",
  "deferred_clarification",
] as const;

/**
 * Why a disposition came out the way it did. Distinct from the disposition so
 * "not admitted because a hard bound forbade it" and "not admitted because the
 * organization excludes this category" stay separable in evidence.
 */
export type AdmissionReason =
  /** A clear, actionable buy/rent objective was present and allowed. */
  | "clear_objective"
  /** The source itself is trusted as sufficient under the effective policy (S1 §8.4.4). */
  | "trusted_source"
  /** No discernible objective yet; clarification is still open (AC-02, EC-01). */
  | "ambiguous_objective"
  /** A platform hard bound forbade it, whatever policy or judgment said (AC-06, EC-02). */
  | "platform_hard_bound"
  /** Organization policy excludes this objective category from auto-admission (EC-03). */
  | "policy_excluded_category"
  /** Policy requires a human to confirm before durable responsibility begins (S1 §8.4.4). */
  | "manual_admission_required"
  /**
   * A published Organization policy exists but could not be resolved into a
   * valid structured policy. Fails closed to no auto-admission (SA-2.7): the
   * platform baseline is NOT applied, because the Organization's published
   * intent was to narrow, and substituting the baseline would broaden.
   */
  | "policy_unavailable"
  /** An equivalent source event was already processed (AC-05). */
  | "duplicate_source_event";

export const ADMISSION_REASONS: readonly AdmissionReason[] = [
  "clear_objective",
  "trusted_source",
  "ambiguous_objective",
  "platform_hard_bound",
  "policy_excluded_category",
  "manual_admission_required",
  "policy_unavailable",
  "duplicate_source_event",
] as const;

/**
 * Fact keys this Slice writes (TD-8 fact-key namespace).
 *
 * TD-8 carried these as a TENTATIVE draft to be settled in SL-2; this module is
 * where SL-2 settles them. Two rules hold:
 *
 *  - no entity id inside a `fact_key` — subject-scoped facts carry the subject
 *    separately (TD-14), so keys stay enumerable without string parsing;
 *  - keys are stable business vocabulary, not implementation names.
 */
export const ADMISSION_FACT_KEYS = {
  /** What the prospect is trying to achieve, as interpreted at admission. */
  objective: "opportunity.objective",
  /** Whether the objective is plausibly alive (S1 §8.7 commercial viability). */
  viability: "opportunity.viability",
  /** The recorded admission disposition, with its policy attribution. */
  disposition: "admission.disposition",
  /** Where the admitted record came from, for provenance. */
  source: "admission.source",
} as const;

export type AdmissionFactKey =
  (typeof ADMISSION_FACT_KEYS)[keyof typeof ADMISSION_FACT_KEYS];

export const ADMISSION_FACT_KEY_LIST: readonly AdmissionFactKey[] =
  Object.values(ADMISSION_FACT_KEYS);

/**
 * The Case type this Slice admits into (TD-8). Registered in the migration
 * alongside a minimal published definition with a single durable state:
 * progression lives in facts, not in a workflow stage (architecture AC-7).
 */
export const LEAD_OPPORTUNITY_CASE_TYPE = "lead_opportunity" as const;

/**
 * Structured output of the semantic interpreter — the *proposal*, never the
 * decision. The deterministic executor consumes this and applies policy, hard
 * bounds, idempotency and tenancy before anything is written.
 *
 * Deliberately narrow: the interpreter says what it understood and how sure it
 * is. It does not get a field for "admit", because that is not its call.
 */
export interface AdmissionProposal {
  /** Whether an actionable buy/rent objective is present at all. */
  has_actionable_objective: boolean;
  /** Free-form objective summary when one is present; null when ambiguous. */
  objective: string | null;
  /** Coarse category used only for policy exclusion matching (EC-03). */
  objective_category: string | null;
  /**
   * The interpreter's own confidence, used to distinguish "clearly ambiguous"
   * from "probably an objective but unclear". It is an input to the executor,
   * never an override of a deterministic gate.
   */
  confidence: "high" | "medium" | "low";
  /** Why the interpreter reached this reading — for eval and audit, not authority. */
  rationale: string;
}

/** The executor's decision, ready to be recorded. */
export interface AdmissionDecision {
  disposition: AdmissionDisposition;
  reason: AdmissionReason;
  policy: EffectivePolicyAttribution;
  /** Present only when a platform hard bound decided the outcome. */
  hard_bound: string | null;
  /** The proposal this decision was made from, retained for provenance. */
  proposal: AdmissionProposal | null;
}

/**
 * The full recorded result of one admission evaluation.
 *
 * `case_id` is non-null only for `admitted` — SA-2.2 and EC-01 both turn on an
 * unadmitted lead leaving no Opportunity Case behind, so the two are carried in
 * one value rather than as separate things a reader has to correlate.
 */
export interface AdmissionOutcome {
  decision: AdmissionDecision;
  /** The Opportunity Case created, or null when nothing was admitted. */
  case_id: string | null;
  /** The inbox row this evaluation consumed, when it came from one. */
  source_event_id: string | null;
  /**
   * True when this call found the work already done — a duplicate source event
   * whose original outcome is being returned unchanged (AC-05).
   */
  deduplicated: boolean;
}
