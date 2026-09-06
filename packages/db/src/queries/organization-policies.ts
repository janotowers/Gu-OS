import type {
  OrganizationPolicy,
  OrganizationPolicyType,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * Versioned Organization policy (ADR-108 / Technical Plan TD-2).
 *
 * One rule shapes this whole module: **only a published row is runtime
 * authority** (AC-5, authoring plane ≠ runtime plane). There is deliberately no
 * "get the latest policy" helper, because the latest row is frequently a draft
 * and a caller reaching for it would silently make unpublished authoring intent
 * govern real decisions. `getPublishedPolicy` is the only read a runtime path
 * should use.
 *
 * The database enforces the rest: at most one published row per (Organization,
 * policy_type), and published rows are immutable and delete-protected, so a
 * disposition that attributed "version n" keeps meaning what it meant.
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

export async function getPolicyVersion(
  db: DbClient,
  params: {
    organizationId: string;
    policyType: OrganizationPolicyType;
    version: number;
  }
): Promise<OrganizationPolicy | null> {
  const { data, error } = await db
    .from("organization_policies")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("policy_type", params.policyType)
    .eq("version", params.version)
    .maybeSingle();
  if (error) throw error;
  return (data as OrganizationPolicy) ?? null;
}

/** Every version, newest first. Authoring/inspection surfaces, never runtime. */
export async function listPolicyVersions(
  db: DbClient,
  organizationId: string,
  policyType: OrganizationPolicyType
): Promise<OrganizationPolicy[]> {
  const { data, error } = await db
    .from("organization_policies")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("policy_type", policyType)
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as OrganizationPolicy[];
}

export async function createPolicyDraft(
  db: DbClient,
  params: {
    organizationId: string;
    policyType: OrganizationPolicyType;
    version: number;
    policy: Record<string, unknown>;
    nlIntentSource?: string | null;
  }
): Promise<OrganizationPolicy> {
  const { data, error } = await db
    .from("organization_policies")
    .insert({
      organization_id: params.organizationId,
      policy_type: params.policyType,
      version: params.version,
      status: "draft",
      policy_jsonb: params.policy,
      nl_intent_source: params.nlIntentSource ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OrganizationPolicy;
}

/**
 * Moves a draft or validated row to published, archiving whatever was published
 * before.
 *
 * The archive happens FIRST because the database holds a partial unique index
 * on (organization_id, policy_type) where status = 'published'. That ordering is
 * not an optimization: it is what makes "exactly one effective policy" true at
 * every instant rather than usually.
 *
 * Publication is an authoring-plane operation. It carries no admission
 * authority of its own — the resolver still decides what a published policy
 * means, and platform hard bounds still outrank it (S1 §8.4.5).
 */
export async function publishPolicyVersion(
  db: DbClient,
  params: {
    organizationId: string;
    policyType: OrganizationPolicyType;
    version: number;
    publishedByUserId?: string | null;
  }
): Promise<OrganizationPolicy> {
  const current = await getPublishedPolicy(
    db,
    params.organizationId,
    params.policyType
  );
  if (current && current.version !== params.version) {
    const { error: archiveError } = await db
      .from("organization_policies")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", current.id);
    if (archiveError) throw archiveError;
  }

  const { data, error } = await db
    .from("organization_policies")
    .update({
      status: "published",
      published_by: params.publishedByUserId ?? null,
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", params.organizationId)
    .eq("policy_type", params.policyType)
    .eq("version", params.version)
    .select("*")
    .single();
  if (error) throw error;
  return data as OrganizationPolicy;
}
