/**
 * `resolveInteractionAuthority` (R1 SL-6 / TD-3 / ADR-107).
 *
 * Advisory. The answer pauses nothing: it does not write
 * `runtime_authority`, does not pause a Case, does not move durable
 * responsibility, and does not suppress a legacy reply.
 *
 * Current conversation authority comes from
 * `legacy_conversation_authority_get`. A binding row is an identity
 * pointer (the opaque ref) and, on `advisor_wa`, evidence only. Its
 * stored `conversation_authority` is never the answer — that would be
 * the silent stale-projection fallback Q17 forbids.
 *
 * Resume-window interpretation is the oracle's job (SA-6.14), not this
 * function's.
 */
import type {
  InteractionAuthorityRefs,
  InteractionAuthorityResolution,
  InteractionConversationVerdict,
  LegacyConversationAuthorityRead,
  RuntimeAuthority,
} from "@agents/types";
import {
  listActiveGuConversationBindingsByRef,
  listConversationBindingsForCase,
  type DbClient,
} from "@agents/db";
import type { GatewayCallerContext, GatewayEnv } from "../legacy-gateway/authorization";
import { isLegacyReadRefusal } from "../legacy-gateway/errors";
import { readLegacyConversationAuthority } from "../legacy-gateway";

export type ReadCurrentConversationAuthority = (
  legacyLeadId: string
) => Promise<LegacyConversationAuthorityRead>;

export interface ResolveInteractionAuthorityInput {
  ctx: GatewayCallerContext;
  refs: InteractionAuthorityRefs;
  env?: GatewayEnv;
  /**
   * Test seam. Production reads through the gateway entry point.
   * Injecting a stale-projection fallback here would be a contract defect.
   */
  readCurrent?: ReadCurrentConversationAuthority;
}

function requireOrganizationId(organizationId: string): string {
  const trimmed = organizationId?.trim();
  if (!trimmed) {
    throw new Error(
      "resolveInteractionAuthority: organizationId is required (never inferred)"
    );
  }
  return trimmed;
}

function opaqueLeadId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function verdictFromTakeover(
  leadTakeoverActive: boolean | null
): InteractionConversationVerdict {
  if (leadTakeoverActive === true) return "human_active";
  if (leadTakeoverActive === false) return "gu";
  return "unknown";
}

function humanActiveOf(
  verdict: InteractionConversationVerdict
): boolean | null {
  if (verdict === "human_active") return true;
  if (verdict === "gu") return false;
  return null;
}

function emptyResolution(
  organizationId: string,
  extras: Partial<InteractionAuthorityResolution>
): InteractionAuthorityResolution {
  return {
    organizationId,
    caseId: null,
    externalConversationRef: null,
    runtimeAuthority: null,
    runtimeAuthorityReadFailed: false,
    bindingReadFailed: false,
    observedOwnerRef: null,
    conversationAuthority: "unknown",
    humanActive: null,
    leadTakeoverActive: null,
    lastOwnerInteractionAt: null,
    numberKillSwitchActive: null,
    guNumberRef: null,
    advisorWaIgnored: false,
    answeredFrom: "none",
    provenance: null,
    failSafeReason: null,
    ...extras,
  };
}

async function readCaseRuntime(params: {
  db: DbClient;
  organizationId: string;
  caseId: string;
}): Promise<{ found: boolean; runtimeAuthority: RuntimeAuthority | null }> {
  const { data, error } = await params.db
    .from("operational_cases")
    .select("id, organization_id, runtime_authority")
    .eq("id", params.caseId)
    .eq("organization_id", params.organizationId)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    runtime_authority?: RuntimeAuthority | null;
  } | null;
  if (!row) return { found: false, runtimeAuthority: null };
  return { found: true, runtimeAuthority: row.runtime_authority ?? null };
}

async function observeCurrentOwner(
  readCurrent: ReadCurrentConversationAuthority,
  legacyLeadId: string
): Promise<{
  observedOwnerRef: string | null;
  provenance: InteractionAuthorityResolution["provenance"];
}> {
  try {
    const current = await readCurrent(legacyLeadId);
    return {
      observedOwnerRef: current.observedOwnerRef ?? null,
      provenance: current.provenance,
    };
  } catch {
    return { observedOwnerRef: null, provenance: null };
  }
}

function defaultReadCurrent(
  ctx: GatewayCallerContext
): ReadCurrentConversationAuthority {
  return (legacyLeadId) => readLegacyConversationAuthority(ctx, legacyLeadId);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export async function resolveInteractionAuthority(
  input: ResolveInteractionAuthorityInput
): Promise<InteractionAuthorityResolution> {
  const organizationId = requireOrganizationId(input.ctx.organizationId);
  const advisorWaIgnored = input.refs.threadKind === "advisor_wa";
  const suppliedLeadId = opaqueLeadId(input.refs.legacyLeadId);
  const suppliedCaseId = opaqueLeadId(input.refs.caseId);
  const readCurrent = input.readCurrent ?? defaultReadCurrent(input.ctx);

  let runtimeAuthority: RuntimeAuthority | null = null;
  let runtimeAuthorityReadFailed = false;
  let suppliedCaseFound = false;
  let resolvedLeadId = suppliedLeadId;
  let resolvedCaseId: string | null = null;
  let mappingConflict: { reason: string; caseId: string | null } | null = null;

  if (suppliedCaseId) {
    try {
      const read = await readCaseRuntime({
        db: input.ctx.db,
        organizationId,
        caseId: suppliedCaseId,
      });
      suppliedCaseFound = read.found;
      runtimeAuthority = read.runtimeAuthority;
    } catch {
      runtimeAuthorityReadFailed = true;
    }
  }

  try {
    if (suppliedLeadId) {
      const guBindings = await listActiveGuConversationBindingsByRef(input.ctx.db, {
        organizationId,
        externalConversationRef: suppliedLeadId,
        provider: "whatsapp_business",
      });
      const caseIds = unique(guBindings.map((row) => row.case_id));
      if (caseIds.length > 1) {
        mappingConflict = { reason: "multiple_active_gu_bindings", caseId: null };
      } else if (caseIds.length === 1) {
        const mappedCaseId = caseIds[0] ?? null;
        if (suppliedCaseId && mappedCaseId && suppliedCaseId !== mappedCaseId) {
          mappingConflict = {
            reason: "case_id_does_not_match_gu_binding",
            caseId: mappedCaseId,
          };
        } else {
          resolvedCaseId = mappedCaseId;
          if (resolvedCaseId && !suppliedCaseId && !runtimeAuthorityReadFailed) {
            try {
              const read = await readCaseRuntime({
                db: input.ctx.db,
                organizationId,
                caseId: resolvedCaseId,
              });
              runtimeAuthority = read.runtimeAuthority;
            } catch {
              runtimeAuthorityReadFailed = true;
            }
          }
        }
      } else if (suppliedCaseId && suppliedCaseFound) {
        mappingConflict = {
          reason: "case_id_does_not_match_gu_binding",
          caseId: null,
        };
      }
    } else if (suppliedCaseId) {
      const bindings = await listConversationBindingsForCase(input.ctx.db, {
        organizationId,
        caseId: suppliedCaseId,
      });
      const guRefs = unique(
        bindings
          .filter((row) => row.thread_kind === "gu")
          .map((row) => row.external_conversation_ref)
      );
      if (guRefs.length > 1) {
        mappingConflict = {
          reason: "multiple_gu_conversation_refs",
          caseId: suppliedCaseId,
        };
      } else if (guRefs.length === 1) {
        resolvedLeadId = guRefs[0] ?? null;
        resolvedCaseId = suppliedCaseId;
      }
    }
  } catch {
    const observed = suppliedLeadId
      ? await observeCurrentOwner(readCurrent, suppliedLeadId)
      : { observedOwnerRef: null, provenance: null };
    return emptyResolution(organizationId, {
      externalConversationRef: suppliedLeadId,
      runtimeAuthority,
      runtimeAuthorityReadFailed,
      bindingReadFailed: true,
      observedOwnerRef: observed.observedOwnerRef,
      provenance: observed.provenance,
      advisorWaIgnored,
      failSafeReason: "binding_read_failure",
    });
  }

  if (mappingConflict) {
    const leadForOwner = suppliedLeadId ?? resolvedLeadId;
    const observed = leadForOwner
      ? await observeCurrentOwner(readCurrent, leadForOwner)
      : { observedOwnerRef: null, provenance: null };
    return emptyResolution(organizationId, {
      caseId: mappingConflict.caseId,
      externalConversationRef: leadForOwner,
      runtimeAuthority,
      runtimeAuthorityReadFailed,
      observedOwnerRef: observed.observedOwnerRef,
      provenance: observed.provenance,
      conversationAuthority: "conflicting",
      advisorWaIgnored,
      failSafeReason: mappingConflict.reason,
    });
  }

  if (!resolvedLeadId) {
    return emptyResolution(organizationId, {
      caseId: resolvedCaseId,
      externalConversationRef: resolvedLeadId ?? suppliedLeadId,
      runtimeAuthority,
      runtimeAuthorityReadFailed,
      conversationAuthority: "unknown",
      advisorWaIgnored,
      failSafeReason: advisorWaIgnored
        ? "advisor_wa_cannot_mint_authority"
        : resolvedCaseId
          ? "unmapped_conversation"
          : "no_legacy_lead_id",
    });
  }

  try {
    const current = await readCurrent(resolvedLeadId);
    const conversationAuthority = verdictFromTakeover(
      current.value.leadTakeoverActive
    );
    const failSafeReason =
      conversationAuthority === "unknown"
        ? "lead_takeover_not_boolean"
        : runtimeAuthorityReadFailed
          ? "case_runtime_authority_read_failure"
          : null;
    return {
      organizationId,
      caseId: resolvedCaseId,
      externalConversationRef: resolvedLeadId,
      runtimeAuthority,
      runtimeAuthorityReadFailed,
      bindingReadFailed: false,
      observedOwnerRef: current.observedOwnerRef ?? null,
      conversationAuthority,
      humanActive: humanActiveOf(conversationAuthority),
      leadTakeoverActive: current.value.leadTakeoverActive,
      lastOwnerInteractionAt: current.value.lastOwnerInteractionAt,
      numberKillSwitchActive: current.value.numberKillSwitchActive,
      guNumberRef: current.value.guNumberRef,
      advisorWaIgnored,
      answeredFrom: "legacy_conversation_authority_get",
      provenance: current.provenance,
      failSafeReason,
    };
  } catch (error) {
    if (isLegacyReadRefusal(error)) {
      const conflicting = error.reason === "pairing_ambiguous";
      return emptyResolution(organizationId, {
        caseId: resolvedCaseId,
        externalConversationRef: resolvedLeadId,
        runtimeAuthority,
        runtimeAuthorityReadFailed,
        conversationAuthority: conflicting ? "conflicting" : "unknown",
        advisorWaIgnored,
        failSafeReason: error.reason,
      });
    }
    return emptyResolution(organizationId, {
      caseId: resolvedCaseId,
      externalConversationRef: resolvedLeadId,
      runtimeAuthority,
      runtimeAuthorityReadFailed,
      conversationAuthority: "unknown",
      advisorWaIgnored,
      failSafeReason: "read_failure",
    });
  }
}
