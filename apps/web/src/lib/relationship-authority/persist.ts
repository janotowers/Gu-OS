/**
 * Persist fail-safe authority resolutions (SA-6.7) and close them when a
 * later confident observation resolves the incident (review finding 3).
 *
 * Logging is not persistence. Confident `gu` / `human_active` answers are
 * not incidents and are not inserted. A retry of one C2 logical request
 * (same Organization + provider_message_id) does not insert a second row.
 * This function never writes `runtime_authority`.
 */
import {
  closeUnresolvedAuthorityResolutions,
  insertAuthorityResolution,
  type DbClient,
} from "@agents/db";
import type {
  AuthorityResolution,
  InteractionAuthorityResolution,
} from "@agents/types";

export async function persistFailSafeAuthorityResolution(params: {
  db: DbClient;
  resolution: InteractionAuthorityResolution;
  caseId?: string | null;
  legacyLeadId?: string | null;
  detectedAt?: string;
  providerMessageId?: string | null;
}): Promise<AuthorityResolution | null> {
  const { resolution } = params;
  if (
    resolution.conversationAuthority !== "unknown" &&
    resolution.conversationAuthority !== "conflicting"
  ) {
    return null;
  }

  return insertAuthorityResolution(params.db, {
    organizationId: resolution.organizationId,
    caseId: params.caseId ?? resolution.caseId ?? null,
    externalConversationRef: params.legacyLeadId ?? null,
    state: resolution.conversationAuthority,
    detectedAt: params.detectedAt ?? new Date().toISOString(),
    failSafeReason: resolution.failSafeReason,
    provenance: {
      answeredFrom: resolution.answeredFrom,
      advisorWaIgnored: resolution.advisorWaIgnored,
      leadTakeoverActive: resolution.leadTakeoverActive,
      numberKillSwitchActive: resolution.numberKillSwitchActive,
      gateway: resolution.provenance,
    },
    runtimeAuthorityObserved: resolution.runtimeAuthority,
    providerMessageId: params.providerMessageId ?? null,
  });
}

export async function recordAuthorityResolutionObservation(params: {
  db: DbClient;
  resolution: InteractionAuthorityResolution;
  caseId?: string | null;
  legacyLeadId?: string | null;
  detectedAt?: string;
  providerMessageId?: string | null;
}): Promise<AuthorityResolution | null> {
  const { resolution } = params;
  const caseId = params.caseId ?? resolution.caseId ?? null;
  const detectedAt = params.detectedAt ?? new Date().toISOString();

  if (
    resolution.conversationAuthority === "gu" ||
    resolution.conversationAuthority === "human_active"
  ) {
    await closeUnresolvedAuthorityResolutions(params.db, {
      organizationId: resolution.organizationId,
      caseId,
      externalConversationRef: params.legacyLeadId ?? null,
      resolvedAt: detectedAt,
      resolvedAs: resolution.conversationAuthority,
    });
    return null;
  }

  return persistFailSafeAuthorityResolution({
    ...params,
    caseId,
    detectedAt,
  });
}
