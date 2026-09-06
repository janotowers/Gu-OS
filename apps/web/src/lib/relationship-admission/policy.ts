/**
 * Deterministic effective-policy resolution (R1 SL-2 / TD-2 / ADR-108).
 *
 * This module is pure policy arithmetic. No model runs here, and nothing a model
 * produced can reach it: the interpreter's proposal is applied *after* an
 * effective policy has already been resolved, by `admit.ts`.
 *
 * Three rules it exists to make structural:
 *
 *  1. **Only a published row is runtime authority** (AC-5). Draft and validated
 *     rows are authoring state and never resolve.
 *  2. **No published policy means the versioned platform Recommended baseline
 *     applies — not zero admission** (S1 §8.4.3, SA-2.7).
 *  3. **An invalid published policy fails closed** (SA-2.7). It does NOT fall
 *     back to the baseline: the Organization published an intent to narrow, and
 *     substituting the platform default would silently broaden authority beyond
 *     what that Organization allowed.
 */
import {
  getPublishedPolicy,
  type DbClient,
} from "@agents/db";
import {
  PLATFORM_DEFAULT_ADMISSION_POLICY,
  PLATFORM_DEFAULT_ADMISSION_POLICY_VERSION,
  PLATFORM_DEFAULT_POLICY_ID,
  type EffectivePolicyAttribution,
  type RelationshipAdmissionPolicy,
} from "@agents/types";

/**
 * A resolved policy, or an explicit refusal to resolve one.
 *
 * `unavailable` is a distinct outcome rather than a null policy, because the
 * two must not be handled the same way: a missing policy admits under the
 * baseline, an unreadable one admits nothing.
 */
export type EffectiveAdmissionPolicy =
  | {
      status: "resolved";
      policy: RelationshipAdmissionPolicy;
      attribution: EffectivePolicyAttribution;
    }
  | {
      status: "unavailable";
      attribution: EffectivePolicyAttribution;
      detail: string;
    };

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Parses a stored policy document into the structured contract.
 *
 * Strict on purpose. A stored policy is authored through a governed publication
 * path, so a shape that does not validate means something is wrong with the
 * governance chain — not that the caller should improvise a default.
 */
export function parseAdmissionPolicy(
  value: unknown
): RelationshipAdmissionPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isStringArray(raw.excluded_categories)) return null;
  if (typeof raw.auto_admit_clear_objectives !== "boolean") return null;
  if (!isStringArray(raw.trusted_sources)) return null;
  return {
    excluded_categories: raw.excluded_categories,
    auto_admit_clear_objectives: raw.auto_admit_clear_objectives,
    trusted_sources: raw.trusted_sources,
  };
}

const PLATFORM_DEFAULT_ATTRIBUTION: EffectivePolicyAttribution = {
  source: "platform_default",
  policy_id: PLATFORM_DEFAULT_POLICY_ID,
  version: PLATFORM_DEFAULT_ADMISSION_POLICY_VERSION,
  matched_rule: "no_published_organization_policy",
};

export async function resolveEffectiveAdmissionPolicy(
  db: DbClient,
  organizationId: string
): Promise<EffectiveAdmissionPolicy> {
  const published = await getPublishedPolicy(
    db,
    organizationId,
    "relationship_admission"
  );

  if (!published) {
    return {
      status: "resolved",
      policy: PLATFORM_DEFAULT_ADMISSION_POLICY,
      attribution: PLATFORM_DEFAULT_ATTRIBUTION,
    };
  }

  const parsed = parseAdmissionPolicy(published.policy_jsonb);
  if (!parsed) {
    return {
      status: "unavailable",
      attribution: {
        source: "organization_published",
        policy_id: published.id,
        version: published.version,
        matched_rule: "invalid_published_policy_fail_closed",
      },
      detail:
        "published organization policy does not satisfy the structured contract",
    };
  }

  return {
    status: "resolved",
    policy: parsed,
    attribution: {
      source: "organization_published",
      policy_id: published.id,
      version: published.version,
      matched_rule: "organization_published_policy",
    },
  };
}
