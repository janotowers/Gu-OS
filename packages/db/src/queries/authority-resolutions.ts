/**
 * Durable fail-safe authority resolutions (R1 SL-6 / SA-6.7).
 *
 * One logical C2 request (organization + provider_message_id) owns at
 * most one row. A later fail-safe evaluation of that same identity
 * reopens the row rather than inserting a second incident. This module
 * never touches `operational_cases.runtime_authority`.
 */
import type { AuthorityResolution, AuthorityResolutionState } from "@agents/types";
import type { DbClient } from "../client";

export class AuthorityResolutionIdentityConflict extends Error {
  readonly code = "logical_identity_conflict";
  constructor() {
    super("authority_resolution logical identity conflict");
    this.name = "AuthorityResolutionIdentityConflict";
  }
}

export interface InsertAuthorityResolutionInput {
  organizationId: string;
  caseId?: string | null;
  externalConversationRef?: string | null;
  state: AuthorityResolutionState;
  detectedAt: string;
  failSafeReason?: string | null;
  provenance?: Record<string, unknown>;
  runtimeAuthorityObserved?: "legacy" | "gu_os" | null;
  providerMessageId?: string | null;
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

  const providerMessageId = requireOpaque(input.providerMessageId);
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
      provider_message_id: providerMessageId,
      resolved_at: null,
      resolved_as: null,
    })
    .select("*")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505" && providerMessageId) {
      const existing = await findAuthorityResolutionByProviderMessageId(db, {
        organizationId: input.organizationId,
        providerMessageId,
      });
      if (existing) {
        return applyFailSafeToExisting(db, existing, input);
      }
    }
    throw error;
  }
  return data as AuthorityResolution;
}

function snapshotHistoryEntry(row: AuthorityResolution): Record<string, unknown> {
  return {
    state: row.state,
    detected_at: row.detected_at,
    fail_safe_reason: row.fail_safe_reason,
    resolved_at: row.resolved_at,
    resolved_as: row.resolved_as,
    case_id: row.case_id,
    external_conversation_ref: row.external_conversation_ref,
  };
}

function identitiesConflict(
  existing: AuthorityResolution,
  input: InsertAuthorityResolutionInput
): boolean {
  const incomingRef = requireOpaque(input.externalConversationRef);
  const incomingCase = input.caseId?.trim() || null;
  if (
    existing.external_conversation_ref &&
    incomingRef &&
    existing.external_conversation_ref !== incomingRef
  ) {
    return true;
  }
  if (existing.case_id && incomingCase && existing.case_id !== incomingCase) {
    return true;
  }
  return false;
}

async function applyFailSafeToExisting(
  db: DbClient,
  existing: AuthorityResolution,
  input: InsertAuthorityResolutionInput
): Promise<AuthorityResolution> {
  if (identitiesConflict(existing, input)) {
    throw new AuthorityResolutionIdentityConflict();
  }

  const sameOpenState =
    existing.resolved_at == null && existing.state === input.state;
  if (sameOpenState) return existing;

  const priorHistory = Array.isArray(existing.provenance_jsonb.history)
    ? (existing.provenance_jsonb.history as unknown[])
    : [];
  const { data, error } = await db
    .from("authority_resolutions")
    .update({
      state: input.state,
      detected_at: input.detectedAt,
      fail_safe_reason: input.failSafeReason ?? existing.fail_safe_reason,
      provenance_jsonb: {
        ...input.provenance,
        history: [...priorHistory, snapshotHistoryEntry(existing)],
      },
      runtime_authority_observed:
        input.runtimeAuthorityObserved ?? existing.runtime_authority_observed,
      case_id: input.caseId?.trim() || existing.case_id,
      external_conversation_ref:
        requireOpaque(input.externalConversationRef) ??
        existing.external_conversation_ref,
      resolved_at: null,
      resolved_as: null,
    })
    .eq("id", existing.id)
    .eq("organization_id", input.organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data as AuthorityResolution;
}

export async function findAuthorityResolutionByProviderMessageId(
  db: DbClient,
  params: { organizationId: string; providerMessageId: string }
): Promise<AuthorityResolution | null> {
  const providerMessageId = requireOpaque(params.providerMessageId);
  if (!providerMessageId) return null;
  const { data, error } = await db
    .from("authority_resolutions")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (error) throw error;
  return (data as AuthorityResolution | null) ?? null;
}

export async function closeUnresolvedAuthorityResolutions(
  db: DbClient,
  params: {
    organizationId: string;
    caseId?: string | null;
    externalConversationRef?: string | null;
    resolvedAt: string;
    resolvedAs: "gu" | "human_active";
  }
): Promise<number> {
  if (!params.organizationId?.trim()) {
    throw new Error("closeUnresolvedAuthorityResolutions: organizationId is required");
  }
  const caseId = params.caseId?.trim() || null;
  const externalConversationRef = requireOpaque(params.externalConversationRef);
  if (!caseId && !externalConversationRef) return 0;

  let query = db
    .from("authority_resolutions")
    .update({
      resolved_at: params.resolvedAt,
      resolved_as: params.resolvedAs,
    })
    .eq("organization_id", params.organizationId)
    .is("resolved_at", null);
  if (caseId && externalConversationRef) {
    query = query
      .eq("case_id", caseId)
      .eq("external_conversation_ref", externalConversationRef);
  } else if (caseId) {
    query = query.eq("case_id", caseId);
  } else {
    query = query.eq("external_conversation_ref", externalConversationRef);
  }

  const { data, error } = await query.select("id");
  if (error) throw error;
  return (data ?? []).length;
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
