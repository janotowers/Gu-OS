import type { ExternalConversationBinding, OperationalCase } from "@agents/types";
import type { DbClient } from "../client";
import { attachExternalConversationBinding } from "./external-conversation-bindings";
import { getOperationalCase } from "./operational-cases";
import { getSourceEventById } from "./source-events";

/**
 * R1 SL-15 / Q18 — Contact / opaque `legacy_lead` identity seam.
 *
 * Delegates to the SQL function rather than doing select-then-insert here:
 * supabase-js has no transaction API, so only the database can create the
 * Contact and the typed identity binding atomically. A crash leaves either
 * nothing or a complete record. Re-runs and concurrent runs converge.
 *
 * The opaque lead id is trimmed and compared whole. Nothing here parses it
 * into person, phone, owner, conversation identity or cross-lead equivalence.
 * Two different lead ids are never merged. An incompatible, ambiguous or
 * cross-Organization existing binding fails closed.
 *
 * Service-role only — the function's EXECUTE privilege is restricted.
 */

export const RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC =
  "resolve_or_create_contact_for_legacy_lead";

const RPC_PREFIX = "resolve_or_create_contact_for_legacy_lead:";

export const RESERVED_LEGACY_LEAD_PROVENANCE_KEYS = [
  "source",
  "source_system",
  "binding_kind",
  "opaque_legacy_lead_ref",
  "organization_id",
] as const;

export type LegacyLeadIdentityProvenanceBasis =
  | "admission"
  | "historical_backfill";

export type LegacyLeadContactFailureCode =
  | "missing_organization"
  | "missing_legacy_lead_id"
  | "missing_provenance"
  | "ambiguous_binding"
  | "incompatible_binding"
  | "cross_organization_binding"
  | "ambiguous_case_mapping"
  | "missing_case"
  | "organization_mismatch"
  | "not_governed_admission";

export class LegacyLeadContactError extends Error {
  readonly code: LegacyLeadContactFailureCode;

  constructor(code: LegacyLeadContactFailureCode, message?: string) {
    super(message ?? `${RPC_PREFIX} ${code}`);
    this.name = "LegacyLeadContactError";
    this.code = code;
  }
}

/**
 * Trim only. The value is compared whole; no component is parsed out.
 * Parsing would invent person / phone / owner / conversation identity.
 */
export function requireOpaqueLegacyLeadId(
  value: string | null | undefined,
  label: string
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new LegacyLeadContactError(
      "missing_legacy_lead_id",
      `${label}: opaque legacy lead id is required`
    );
  }
  return trimmed;
}

function opaqueEquals(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  return a.length > 0 && a === b;
}

function opaqueIdFromContext(
  context: Record<string, unknown>,
  key: string
): string | null {
  const raw = context[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * SA-15.5 create-path contract, shared by the TypeScript wrapper and the
 * in-memory RPC fakes. Reserved keys are stripped so caller content cannot
 * override source / source-system / kind / opaque-ref / Organization.
 * Reuse in SQL never calls this — it returns the existing binding as-is.
 */
export function requireCreateIdentityProvenance(
  value: unknown,
  label = "resolveOrCreateContactForLegacyLead"
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyLeadContactError(
      "missing_provenance",
      `${label}: provenance must be an object with the SA-15.5 evidence basis`
    );
  }
  const sanitized: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const key of RESERVED_LEGACY_LEAD_PROVENANCE_KEYS) {
    delete sanitized[key];
  }
  if (
    sanitized.basis !== "admission" &&
    sanitized.basis !== "historical_backfill"
  ) {
    throw new LegacyLeadContactError(
      "missing_provenance",
      `${label}: provenance.basis must be admission or historical_backfill`
    );
  }
  if (
    typeof sanitized.source_event_id !== "string" ||
    !sanitized.source_event_id.trim()
  ) {
    throw new LegacyLeadContactError(
      "missing_provenance",
      `${label}: provenance.source_event_id is required`
    );
  }
  if (typeof sanitized.case_id !== "string" || !sanitized.case_id.trim()) {
    throw new LegacyLeadContactError(
      "missing_provenance",
      `${label}: provenance.case_id is required`
    );
  }
  if (sanitized.provisional_materialization !== true) {
    throw new LegacyLeadContactError(
      "missing_provenance",
      `${label}: provenance.provisional_materialization must be true`
    );
  }
  sanitized.source_event_id = sanitized.source_event_id.trim();
  sanitized.case_id = sanitized.case_id.trim();
  return sanitized;
}

function failureCodeFromMessage(
  message: string
): LegacyLeadContactFailureCode | null {
  if (message.includes("missing_organization")) return "missing_organization";
  if (message.includes("missing_legacy_lead_id")) return "missing_legacy_lead_id";
  if (message.includes("missing_provenance")) return "missing_provenance";
  if (message.includes("ambiguous_binding")) return "ambiguous_binding";
  if (message.includes("incompatible_binding")) return "incompatible_binding";
  if (message.includes("cross_organization_binding")) {
    return "cross_organization_binding";
  }
  return null;
}

function throwRpcError(error: unknown): never {
  const shaped = error as { code?: string; message?: string };
  const message =
    typeof shaped.message === "string"
      ? shaped.message
      : "resolve_or_create_contact_for_legacy_lead failed";
  const code = failureCodeFromMessage(message);
  if (code) throw new LegacyLeadContactError(code, message);
  const wrapped = new Error(message);
  if (typeof shaped.code === "string") {
    (wrapped as { code?: string }).code = shaped.code;
  }
  throw wrapped;
}

export async function resolveOrCreateContactForLegacyLead(
  db: DbClient,
  params: {
    organizationId: string;
    legacyLeadId: string;
    provenance: Record<string, unknown>;
  }
): Promise<string> {
  const organizationId = params.organizationId?.trim();
  if (!organizationId) {
    throw new LegacyLeadContactError(
      "missing_organization",
      "resolveOrCreateContactForLegacyLead: organizationId is required"
    );
  }
  const legacyLeadId = requireOpaqueLegacyLeadId(
    params.legacyLeadId,
    "resolveOrCreateContactForLegacyLead"
  );
  const provenance = requireCreateIdentityProvenance(params.provenance);

  const { data, error } = await db.rpc(
    RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC,
    {
      p_organization_id: organizationId,
      p_legacy_lead_id: legacyLeadId,
      p_provenance: provenance,
    }
  );
  if (error) throwRpcError(error);
  if (typeof data !== "string" || !data) {
    throw new Error(
      "resolveOrCreateContactForLegacyLead: function returned no contact id"
    );
  }
  return data;
}

type GovernedAdmittedLeadOpportunity = {
  opportunity: OperationalCase;
  sourceEventId: string;
  legacyLeadId: string;
};

/**
 * Q18 / SL-15 historical-backfill gate. Case + Organization +
 * `context.legacy_lead_id` is not enough. The Case must be the result of
 * the governed admission path, proven from canonical source_events evidence.
 */
async function requireGovernedAdmittedLeadOpportunity(
  db: DbClient,
  params: { organizationId: string; caseId: string }
): Promise<GovernedAdmittedLeadOpportunity> {
  const opportunity = await getOperationalCase(db, params.caseId);
  if (!opportunity) {
    throw new LegacyLeadContactError(
      "missing_case",
      "backfillAdmittedLegacyLeadIdentity: case not found"
    );
  }
  if (opportunity.organization_id !== params.organizationId) {
    throw new LegacyLeadContactError(
      "organization_mismatch",
      "backfillAdmittedLegacyLeadIdentity: case Organization does not match"
    );
  }
  if (opportunity.case_type !== "lead_opportunity") {
    throw new LegacyLeadContactError(
      "not_governed_admission",
      "backfillAdmittedLegacyLeadIdentity: case is not a lead_opportunity"
    );
  }

  const legacyLeadId = opaqueIdFromContext(
    opportunity.context_jsonb,
    "legacy_lead_id"
  );
  const sourceEventId = opaqueIdFromContext(
    opportunity.context_jsonb,
    "source_event_id"
  );
  if (!legacyLeadId || !sourceEventId) {
    throw new LegacyLeadContactError(
      "not_governed_admission",
      "backfillAdmittedLegacyLeadIdentity: case is not proven governed admission"
    );
  }

  const event = await getSourceEventById(
    db,
    params.organizationId,
    sourceEventId
  );
  if (
    !event ||
    event.source_system !== "traditional_gu" ||
    event.status !== "completed" ||
    event.decision_jsonb?.disposition !== "admitted" ||
    event.admitted_case_id !== params.caseId ||
    !opaqueEquals(event.external_lead_ref, legacyLeadId)
  ) {
    throw new LegacyLeadContactError(
      "not_governed_admission",
      "backfillAdmittedLegacyLeadIdentity: source event is not governed admitted evidence for this Case"
    );
  }

  return { opportunity, sourceEventId, legacyLeadId };
}

/**
 * Historical / pilot repair for one already-admitted real Case.
 *
 * Uses the SAME resolve-or-create primitive as future admission, then
 * `attachExternalConversationBinding`. No ad-hoc SQL.
 *
 * Q18 authorizes provisional Contact materialization only for a real Legacy
 * Lead that has passed governed admission. Absent, inconsistent or ambiguous
 * evidence fails closed and writes nothing.
 *
 * The GU-thread conversation ref is the verified opaque `legacyLeadId`
 * (TD-4 permits that as an external source ref). It is never parsed and
 * never taken from a caller-supplied WAMID. Provider / message ids may be
 * attached later by the governed C1 path when such source evidence exists.
 */
export async function backfillAdmittedLegacyLeadIdentity(
  db: DbClient,
  params: {
    organizationId: string;
    caseId: string;
  }
): Promise<{
  contactId: string;
  conversationBinding: ExternalConversationBinding;
}> {
  const organizationId = params.organizationId?.trim();
  if (!organizationId) {
    throw new LegacyLeadContactError(
      "missing_organization",
      "backfillAdmittedLegacyLeadIdentity: organizationId is required"
    );
  }
  const caseId = params.caseId?.trim();
  if (!caseId) {
    throw new LegacyLeadContactError(
      "missing_case",
      "backfillAdmittedLegacyLeadIdentity: caseId is required"
    );
  }

  const proved = await requireGovernedAdmittedLeadOpportunity(db, {
    organizationId,
    caseId,
  });

  const otherAdmitted = await listOtherGovernedAdmittedCasesForOpaqueLegacyLead(
    db,
    {
      organizationId,
      caseId,
      legacyLeadId: proved.legacyLeadId,
    }
  );
  if (otherAdmitted.length > 0) {
    throw new LegacyLeadContactError(
      "ambiguous_case_mapping",
      "backfillAdmittedLegacyLeadIdentity: opaque legacy lead id maps to more than one admitted Case"
    );
  }

  const contactId = await resolveOrCreateContactForLegacyLead(db, {
    organizationId,
    legacyLeadId: proved.legacyLeadId,
    provenance: {
      basis: "historical_backfill",
      source_event_id: proved.sourceEventId,
      case_id: caseId,
      provisional_materialization: true,
    },
  });

  const conversationBinding = await attachExternalConversationBinding(db, {
    organizationId,
    caseId,
    contactId,
    provider: "whatsapp_business",
    externalConversationRef: proved.legacyLeadId,
    threadKind: "gu",
    provenance: {
      source: "backfillAdmittedLegacyLeadIdentity",
      basis: "historical_backfill",
      opaque_legacy_lead_ref: proved.legacyLeadId,
    },
  });

  return { contactId, conversationBinding };
}

async function listOtherGovernedAdmittedCasesForOpaqueLegacyLead(
  db: DbClient,
  params: { organizationId: string; caseId: string; legacyLeadId: string }
): Promise<string[]> {
  const candidates = await listLeadOpportunityCasesForOpaqueLegacyLead(db, {
    organizationId: params.organizationId,
    legacyLeadId: params.legacyLeadId,
  });
  const admitted: string[] = [];
  for (const row of candidates) {
    if (row.id === params.caseId) continue;
    try {
      await requireGovernedAdmittedLeadOpportunity(db, {
        organizationId: params.organizationId,
        caseId: row.id,
      });
      admitted.push(row.id);
    } catch (error) {
      if (
        error instanceof LegacyLeadContactError &&
        (error.code === "not_governed_admission" ||
          error.code === "missing_case" ||
          error.code === "organization_mismatch")
      ) {
        continue;
      }
      throw error;
    }
  }
  return admitted;
}

async function listLeadOpportunityCasesForOpaqueLegacyLead(
  db: DbClient,
  params: { organizationId: string; legacyLeadId: string }
): Promise<Pick<OperationalCase, "id">[]> {
  const { data, error } = await db
    .from("operational_cases")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("case_type", "lead_opportunity")
    .eq("context_jsonb->>legacy_lead_id", params.legacyLeadId);
  if (error) throw error;
  return (data ?? []) as Pick<OperationalCase, "id">[];
}
