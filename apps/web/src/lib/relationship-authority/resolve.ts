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
  LegacyConversationAuthority,
  LegacyReadResult,
  RuntimeAuthority,
} from "@agents/types";
import {
  listConversationBindingsForCase,
  type DbClient,
} from "@agents/db";
import type { GatewayCallerContext, GatewayEnv } from "../legacy-gateway/authorization";
import { isLegacyReadRefusal } from "../legacy-gateway/errors";
import { readLegacyConversationAuthority } from "../legacy-gateway";

export type ReadCurrentConversationAuthority = (
  legacyLeadId: string
) => Promise<LegacyReadResult<LegacyConversationAuthority>>;

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
    runtimeAuthority: null,
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

async function readRuntimeAuthority(params: {
  db: DbClient;
  organizationId: string;
  caseId: string;
}): Promise<RuntimeAuthority | null> {
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
  return row?.runtime_authority ?? null;
}

function defaultReadCurrent(
  ctx: GatewayCallerContext
): ReadCurrentConversationAuthority {
  return (legacyLeadId) => readLegacyConversationAuthority(ctx, legacyLeadId);
}

export async function resolveInteractionAuthority(
  input: ResolveInteractionAuthorityInput
): Promise<InteractionAuthorityResolution> {
  const organizationId = requireOrganizationId(input.ctx.organizationId);
  const advisorWaIgnored = input.refs.threadKind === "advisor_wa";
  const suppliedLeadId = opaqueLeadId(input.refs.legacyLeadId);
  const caseId = opaqueLeadId(input.refs.caseId);

  let runtimeAuthority: RuntimeAuthority | null = null;
  let resolvedLeadId = suppliedLeadId;

  if (caseId) {
    try {
      runtimeAuthority = await readRuntimeAuthority({
        db: input.ctx.db,
        organizationId,
        caseId,
      });

      const bindings = await listConversationBindingsForCase(input.ctx.db, {
        organizationId,
        caseId,
      });
      const guBindings = bindings.filter((row) => row.thread_kind === "gu");
      const guRefs = [
        ...new Set(guBindings.map((row) => row.external_conversation_ref)),
      ];

      if (suppliedLeadId) {
        if (guRefs.length > 0 && !guRefs.includes(suppliedLeadId)) {
          return emptyResolution(organizationId, {
            runtimeAuthority,
            conversationAuthority: "conflicting",
            advisorWaIgnored,
            failSafeReason: "lead_ref_does_not_match_gu_binding",
          });
        }
      } else if (guRefs.length > 1) {
        return emptyResolution(organizationId, {
          runtimeAuthority,
          conversationAuthority: "conflicting",
          advisorWaIgnored,
          failSafeReason: "multiple_gu_conversation_refs",
        });
      } else if (guRefs.length === 1) {
        resolvedLeadId = guRefs[0] ?? null;
      }
    } catch {
      if (!suppliedLeadId) {
        return emptyResolution(organizationId, {
          advisorWaIgnored,
          failSafeReason: "case_read_failure",
        });
      }
    }
  }

  if (!resolvedLeadId) {
    return emptyResolution(organizationId, {
      runtimeAuthority,
      conversationAuthority: "unknown",
      advisorWaIgnored,
      failSafeReason: advisorWaIgnored
        ? "advisor_wa_cannot_mint_authority"
        : "no_legacy_lead_id",
    });
  }

  const readCurrent = input.readCurrent ?? defaultReadCurrent(input.ctx);

  try {
    const current = await readCurrent(resolvedLeadId);
    const conversationAuthority = verdictFromTakeover(
      current.value.leadTakeoverActive
    );
    return {
      organizationId,
      runtimeAuthority,
      conversationAuthority,
      humanActive: humanActiveOf(conversationAuthority),
      leadTakeoverActive: current.value.leadTakeoverActive,
      lastOwnerInteractionAt: current.value.lastOwnerInteractionAt,
      numberKillSwitchActive: current.value.numberKillSwitchActive,
      guNumberRef: current.value.guNumberRef,
      advisorWaIgnored,
      answeredFrom: "legacy_conversation_authority_get",
      provenance: current.provenance,
      failSafeReason:
        conversationAuthority === "unknown"
          ? "lead_takeover_not_boolean"
          : null,
    };
  } catch (error) {
    if (isLegacyReadRefusal(error)) {
      const conflicting = error.reason === "pairing_ambiguous";
      return emptyResolution(organizationId, {
        runtimeAuthority,
        conversationAuthority: conflicting ? "conflicting" : "unknown",
        advisorWaIgnored,
        failSafeReason: error.reason,
      });
    }
    return emptyResolution(organizationId, {
      runtimeAuthority,
      conversationAuthority: "unknown",
      advisorWaIgnored,
      failSafeReason: "read_failure",
    });
  }
}
