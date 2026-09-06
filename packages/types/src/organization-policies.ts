/**
 * Versioned Organization policy (ADR-108 / Technical Plan TD-2).
 *
 * Cross-domain on purpose: the policy primitive is shared-kernel, and the
 * *purpose* is typed. R1 lands the first purpose, `relationship_admission`.
 *
 * Two rules this module exists to make structural rather than remembered:
 *
 *  1. **Authoring plane is not the runtime plane** (AC-5). Only a `published`
 *     row is runtime authority. A `draft` or `validated` row never resolves.
 *  2. **Missing or invalid policy never widens authority** (ADR-108). With no
 *     published Organization policy, resolution falls back to the versioned
 *     platform Recommended baseline below, which is deliberately conservative.
 *     It does not fall back to "no policy, so allow".
 */

/** Typed policy purposes. R1 ships the first; TD-2 names `relationship_engagement` next. */
export type OrganizationPolicyType = "relationship_admission";

export const ORGANIZATION_POLICY_TYPES: readonly OrganizationPolicyType[] = [
  "relationship_admission",
] as const;

/**
 * Authoring lifecycle. Mirrors the CHECK constraint in the migration and the
 * `workflow_definitions` precedent: published rows are immutable and
 * delete-protected.
 */
export type OrganizationPolicyStatus =
  | "draft"
  | "validated"
  | "published"
  | "archived";

export const ORGANIZATION_POLICY_STATUSES: readonly OrganizationPolicyStatus[] = [
  "draft",
  "validated",
  "published",
  "archived",
] as const;

/**
 * The only status that carries runtime authority. Exported as a function rather
 * than a bare constant so call sites read as a check, not a comparison.
 */
export function isRuntimeAuthoritative(
  status: OrganizationPolicyStatus,
): boolean {
  return status === "published";
}

/**
 * A structured admission policy. Deliberately small: R1 ships one Recommended
 * baseline plus a `Customize` path (S1 §8.4.3), not a rules engine and not a
 * blank canvas. Each field maps to one of the configurable choices S1 §8.4.4
 * approves; nothing here can *widen* platform hard bounds (§8.4.5).
 */
export interface RelationshipAdmissionPolicy {
  /**
   * Objective categories the organization will not admit automatically,
   * however confident the semantic judgment (S1 EC-03). Per EC-03 the expected
   * behavior is "do not admit automatically; follow the configured/human path"
   * — not a permanent prohibition, which is what a platform hard bound is.
   */
  excluded_categories: readonly string[];
  /**
   * Whether a sufficiently clear commercial objective may be admitted without
   * a human confirming first (S1 §8.4.4, "whether certain categories require
   * human confirmation before durable responsibility begins").
   *
   * Ambiguity never auto-admits regardless of this value (S1 AC-02): this
   * governs the *clear* case only.
   */
  auto_admit_clear_objectives: boolean;
  /**
   * Sources whose event alone establishes eligibility, without semantic intent
   * evidence in the message itself (S1 §8.4.4, "whether a source event itself
   * is sufficient or Gu must first confirm intent"; AC-01's trusted contextual
   * source).
   *
   * Empty is the conservative value and is what the baseline ships: no source
   * is pre-trusted as sufficient *by itself*. It does not disable admission —
   * S1 §8.4.3 admits on sufficiently clear commercial intent independently of
   * this list, so an empty list narrows the *routes* to eligibility rather
   * than zeroing admission.
   */
  trusted_sources: readonly string[];
}

/**
 * Versioned platform Recommended baseline (TD-2).
 *
 * Ships as a code constant, not a database row, so an Organization with no
 * published policy still resolves against something explicit and attributable.
 * The identifier is what gets recorded on the disposition as the effective
 * policy version when no Organization policy applies.
 *
 * Bump the version whenever the baseline's *content* changes; the attribution
 * on historical dispositions must keep meaning what it meant when recorded.
 */
export const PLATFORM_DEFAULT_ADMISSION_POLICY_VERSION = 1 as const;

export const PLATFORM_DEFAULT_POLICY_ID =
  `platform-default@${PLATFORM_DEFAULT_ADMISSION_POLICY_VERSION}` as const;

export const PLATFORM_DEFAULT_ADMISSION_POLICY: RelationshipAdmissionPolicy = {
  excluded_categories: [],
  auto_admit_clear_objectives: true,
  trusted_sources: [],
};

/**
 * Platform hard bounds. These are **not** policy: no Organization policy, and
 * no model judgment however confident, may relax them (S1 AC-06, EC-02).
 *
 * Kept as an explicit list so the resolver can name which bound blocked a
 * disposition rather than returning an opaque refusal.
 */
export type PlatformHardBound =
  /** The prospect is blocked at platform level; nothing may create responsibility for them. */
  | "prospect_blocked"
  /** The record is not a genuine prospect record (test, spam, internal). */
  | "non_prospect_record"
  /** The Organization is not authorized for Relationship Operations at all. */
  | "organization_not_authorized";

export const PLATFORM_HARD_BOUNDS: readonly PlatformHardBound[] = [
  "prospect_blocked",
  "non_prospect_record",
  "organization_not_authorized",
] as const;

/**
 * How a policy decision was reached, carried onto the disposition so a reader
 * can tell an Organization decision from a baseline fallback from a hard bound.
 */
export type PolicySourceKind =
  /** A published Organization policy row resolved. */
  | "organization_published"
  /** No published Organization policy existed; the platform baseline applied. */
  | "platform_default"
  /** A platform hard bound decided the outcome before policy was consulted. */
  | "platform_hard_bound";

/**
 * Effective policy attribution recorded on every disposition (ADR-108:
 * decision-level effective policy-version attribution).
 *
 * `policy_id` is either the Organization policy row id or
 * `PLATFORM_DEFAULT_POLICY_ID`. `version` is the row version or the baseline
 * version. Both are recorded so attribution survives later policy publication.
 */
export interface EffectivePolicyAttribution {
  source: PolicySourceKind;
  policy_id: string;
  version: number;
  /** Which rule path decided it — for eval, debugging and audit, never authority. */
  matched_rule: string;
}

/** Persisted row shape (snake_case, mirrors `organization_policies`). */
export interface OrganizationPolicy {
  id: string;
  organization_id: string;
  policy_type: OrganizationPolicyType;
  version: number;
  status: OrganizationPolicyStatus;
  policy_jsonb: Record<string, unknown>;
  nl_intent_source: string | null;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}
