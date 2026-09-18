import type {
  ConversationProvider,
  ConversationThreadKind,
  ExternalConversationBinding,
  OperationalCase,
} from "@agents/types";
import type { DbClient } from "../client";
import { attachExternalConversationBinding } from "./external-conversation-bindings";
import { getOperationalCase } from "./operational-cases";

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

export type LegacyLeadContactFailureCode =
  | "missing_organization"
  | "missing_legacy_lead_id"
  | "ambiguous_binding"
  | "incompatible_binding"
  | "cross_organization_binding"
  | "ambiguous_case_mapping"
  | "missing_case"
  | "organization_mismatch"
  | "missing_opaque_conversation_ref";

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

function requireOpaqueConversationRef(
  value: string | null | undefined,
  label: string
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new LegacyLeadContactError(
      "missing_opaque_conversation_ref",
      `${label}: opaque external conversation ref is required`
    );
  }
  return trimmed;
}

function failureCodeFromMessage(
  message: string
): LegacyLeadContactFailureCode | null {
  if (message.includes("missing_organization")) return "missing_organization";
  if (message.includes("missing_legacy_lead_id")) return "missing_legacy_lead_id";
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
    provenance?: Record<string, unknown>;
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

  const { data, error } = await db.rpc(
    RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC,
    {
      p_organization_id: organizationId,
      p_legacy_lead_id: legacyLeadId,
      p_provenance: params.provenance ?? {},
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

function opaqueLeadIdFromCaseContext(
  context: Record<string, unknown>
): string | null {
  const raw = context.legacy_lead_id;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * Historical / pilot repair for one already-admitted real Case.
 *
 * Uses the SAME resolve-or-create primitive as future admission, then
 * `attachExternalConversationBinding`. No ad-hoc SQL. Fails closed if the
 * opaque lead id maps to more than one `lead_opportunity` Case in the
 * Organization, or if Case Organization does not match.
 *
 * The conversation ref is a required opaque argument: this helper does not
 * promote `legacy_lead_id` into conversation identity. The caller supplies
 * the conversation ref they already have (compared whole, never parsed).
 */
export async function backfillAdmittedLegacyLeadIdentity(
  db: DbClient,
  params: {
    organizationId: string;
    caseId: string;
    externalConversationRef: string;
    provider?: ConversationProvider;
    threadKind?: ConversationThreadKind;
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
  const externalConversationRef = requireOpaqueConversationRef(
    params.externalConversationRef,
    "backfillAdmittedLegacyLeadIdentity"
  );

  const opportunity = await getOperationalCase(db, caseId);
  if (!opportunity) {
    throw new LegacyLeadContactError(
      "missing_case",
      "backfillAdmittedLegacyLeadIdentity: case not found"
    );
  }
  if (opportunity.organization_id !== organizationId) {
    throw new LegacyLeadContactError(
      "organization_mismatch",
      "backfillAdmittedLegacyLeadIdentity: case Organization does not match"
    );
  }
  if (opportunity.case_type !== "lead_opportunity") {
    throw new LegacyLeadContactError(
      "organization_mismatch",
      "backfillAdmittedLegacyLeadIdentity: case is not a lead_opportunity"
    );
  }

  const legacyLeadId = opaqueLeadIdFromCaseContext(opportunity.context_jsonb);
  if (!legacyLeadId) {
    throw new LegacyLeadContactError(
      "missing_legacy_lead_id",
      "backfillAdmittedLegacyLeadIdentity: case context has no opaque legacy_lead_id"
    );
  }

  const siblings = await listLeadOpportunityCasesForOpaqueLegacyLead(db, {
    organizationId,
    legacyLeadId,
  });
  if (siblings.length > 1) {
    throw new LegacyLeadContactError(
      "ambiguous_case_mapping",
      "backfillAdmittedLegacyLeadIdentity: opaque legacy lead id maps to more than one admitted Case"
    );
  }

  const contactId = await resolveOrCreateContactForLegacyLead(db, {
    organizationId,
    legacyLeadId,
    provenance: {
      basis: "historical_backfill",
      case_id: caseId,
      provisional_materialization: true,
    },
  });

  const conversationBinding = await attachExternalConversationBinding(db, {
    organizationId,
    caseId,
    contactId,
    provider: params.provider ?? "whatsapp_business",
    externalConversationRef,
    threadKind: params.threadKind ?? "gu",
    provenance: {
      source: "backfillAdmittedLegacyLeadIdentity",
      basis: "historical_backfill",
      opaque_legacy_lead_ref: legacyLeadId,
    },
  });

  return { contactId, conversationBinding };
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
