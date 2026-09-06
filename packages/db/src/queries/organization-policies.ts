import type {
  OrganizationPolicy,
  OrganizationPolicyType,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * Versioned Organization policy — **runtime retrieval only** (ADR-108 / TD-2).
 *
 * One rule shapes this module: **only a published row is runtime authority**
 * (AC-5, authoring plane ≠ runtime plane). There is deliberately no "get the
 * latest policy" helper, because the latest row is frequently a draft and a
 * caller reaching for it would silently make unpublished authoring intent
 * govern real decisions.
 *
 * **There are no mutation helpers here, and that is deliberate.** TD-2 places
 * conversational policy authoring — draft creation, interpretation, review and
 * publication — in a later Slice. SL-2 consumes policy; it does not author it.
 * Shipping an authority-bearing publication API now, merely because the table
 * exists, would put a governed write path into production ahead of the
 * authorization, atomicity and review design that Slice owns. When authoring
 * lands, it brings its own contract: an atomic replacement that cannot leave an
 * Organization momentarily unpublished (which would silently swap a restrictive
 * Organization policy for the broader platform baseline), and the
 * `authorizeOrgAction` path every server-route mutation goes through.
 *
 * The database already enforces what SL-2 depends on: at most one published row
 * per (Organization, policy_type), and published rows immutable and
 * delete-protected.
 */

export async function getPublishedPolicy(
  db: DbClient,
  organizationId: string,
  policyType: OrganizationPolicyType
): Promise<OrganizationPolicy | null> {
  const { data, error } = await db
    .from("organization_policies")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("policy_type", policyType)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw error;
  return (data as OrganizationPolicy) ?? null;
}
