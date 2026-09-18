/**
 * Persist fail-safe authority resolutions (SA-6.7).
 *
 * Logging is not persistence. Confident `gu` / `human_active` answers are
 * not incidents and are not written. This function never writes
 * `runtime_authority`.
 */
import { insertAuthorityResolution, type DbClient } from "@agents/db";
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
    caseId: params.caseId ?? null,
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
  });
}
