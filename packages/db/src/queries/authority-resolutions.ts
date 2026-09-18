/**
 * Durable fail-safe authority resolutions (R1 SL-6 / SA-6.7).
 *
 * Inserts are the only write. This module never touches
 * `operational_cases.runtime_authority`.
 */
import type { AuthorityResolution, AuthorityResolutionState } from "@agents/types";
import type { DbClient } from "../client";

export interface InsertAuthorityResolutionInput {
  organizationId: string;
  caseId?: string | null;
  externalConversationRef?: string | null;
  state: AuthorityResolutionState;
  detectedAt: string;
  failSafeReason?: string | null;
  provenance?: Record<string, unknown>;
  runtimeAuthorityObserved?: "legacy" | "gu_os" | null;
}

function requireOpaque(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function insertAuthorityResolution(
  db: DbClient,
  input: InsertAuthorityResolutionInput
): Promise<AuthorityResolution> {
  if (!input.organizationId?.trim()) {
    throw new Error("insertAuthorityResolution: organizationId is required");
  }
  if (input.state !== "unknown" && input.state !== "conflicting") {
    throw new Error(
      "insertAuthorityResolution: only unknown and conflicting are persistable"
    );
  }

  const { data, error } = await db
    .from("authority_resolutions")
    .insert({
      organization_id: input.organizationId,
      case_id: input.caseId?.trim() || null,
      external_conversation_ref: requireOpaque(input.externalConversationRef),
      state: input.state,
      detected_at: input.detectedAt,
      fail_safe_reason: input.failSafeReason ?? null,
      provenance_jsonb: input.provenance ?? {},
      runtime_authority_observed: input.runtimeAuthorityObserved ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as AuthorityResolution;
}

export async function listAuthorityResolutionsForCases(
  db: DbClient,
  params: { organizationId: string; caseIds: readonly string[] }
): Promise<AuthorityResolution[]> {
  if (params.caseIds.length === 0) return [];
  const { data, error } = await db
    .from("authority_resolutions")
    .select("*")
    .eq("organization_id", params.organizationId)
    .in("case_id", [...params.caseIds])
    .order("detected_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AuthorityResolution[];
}
