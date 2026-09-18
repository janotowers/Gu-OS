import type {
  ConversationAuthority,
  ConversationProvider,
  ConversationThreadKind,
  ExternalConversationBinding,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * External conversation bindings (TD-4 / SL-6).
 *
 * Three invariants this module keeps:
 *   * the external ref is OPAQUE — trimmed and compared whole, never parsed
 *     into a lead_id component or a provider thread id;
 *   * `advisor_wa` rows cannot carry conversation-authority fields, matching
 *     the table CHECK. The helper refuses before the constraint does so a
 *     caller gets a programming error rather than a SQLSTATE;
 *   * this module never writes `operational_cases.runtime_authority`. SL-6
 *     answers who holds the conversation; it does not move decision authority.
 */

const UNIQUE_VIOLATION = "23505";

export interface AttachConversationBindingInput {
  organizationId: string;
  caseId: string;
  contactId: string;
  provider: ConversationProvider;
  externalConversationRef: string;
  threadKind: ConversationThreadKind;
  guChannelIdentityBindingId?: string | null;
  conversationAuthority?: ConversationAuthority | null;
  lastHumanActivityAt?: string | null;
  authoritySource?: string | null;
  provenance?: Record<string, unknown>;
}

function requireOpaqueRef(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label}: external conversation ref is required`);
  }
  return trimmed;
}

function assertAdvisorWaHasNoAuthority(input: {
  threadKind: ConversationThreadKind;
  conversationAuthority?: ConversationAuthority | null;
  lastHumanActivityAt?: string | null;
  authoritySource?: string | null;
}): void {
  if (input.threadKind !== "advisor_wa") return;
  if (
    input.conversationAuthority != null ||
    input.lastHumanActivityAt != null ||
    input.authoritySource != null
  ) {
    throw new Error(
      "attachExternalConversationBinding: advisor_wa rows cannot carry conversation authority"
    );
  }
}

/**
 * Idempotent attach: re-binding the same active (case, provider, ref) is a
 * no-op that returns the existing row. A second *active* binding for that
 * triple is structurally impossible (partial unique index). Cross-tenant
 * Case/contact/channel pointers are impossible by composite FK.
 */
export async function attachExternalConversationBinding(
  db: DbClient,
  input: AttachConversationBindingInput
): Promise<ExternalConversationBinding> {
  if (!input.organizationId?.trim()) {
    throw new Error("attachExternalConversationBinding: organizationId is required");
  }
  if (!input.caseId?.trim()) {
    throw new Error("attachExternalConversationBinding: caseId is required");
  }
  if (!input.contactId?.trim()) {
    throw new Error("attachExternalConversationBinding: contactId is required");
  }
  const externalConversationRef = requireOpaqueRef(
    input.externalConversationRef,
    "attachExternalConversationBinding"
  );
  assertAdvisorWaHasNoAuthority(input);

  const existing = await findActiveConversationBinding(db, {
    organizationId: input.organizationId,
    caseId: input.caseId,
    provider: input.provider,
    externalConversationRef,
  });
  if (existing) return existing;

  const { data, error } = await db
    .from("external_conversation_bindings")
    .insert({
      organization_id: input.organizationId,
      case_id: input.caseId,
      contact_id: input.contactId,
      provider: input.provider,
      external_conversation_ref: externalConversationRef,
      thread_kind: input.threadKind,
      gu_channel_identity_binding_id: input.guChannelIdentityBindingId ?? null,
      conversation_authority: input.conversationAuthority ?? null,
      last_human_activity_at: input.lastHumanActivityAt ?? null,
      authority_source: input.authoritySource ?? null,
      provenance_jsonb: input.provenance ?? {},
    })
    .select("*")
    .single();

  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const raced = await findActiveConversationBinding(db, {
        organizationId: input.organizationId,
        caseId: input.caseId,
        provider: input.provider,
        externalConversationRef,
      });
      if (raced) return raced;
    }
    throw error;
  }
  return data as ExternalConversationBinding;
}

export async function findActiveConversationBinding(
  db: DbClient,
  params: {
    organizationId: string;
    provider: ConversationProvider;
    externalConversationRef: string;
    caseId?: string;
  }
): Promise<ExternalConversationBinding | null> {
  const externalConversationRef = requireOpaqueRef(
    params.externalConversationRef,
    "findActiveConversationBinding"
  );
  let query = db
    .from("external_conversation_bindings")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("provider", params.provider)
    .eq("external_conversation_ref", externalConversationRef)
    .eq("status", "active");
  if (params.caseId) query = query.eq("case_id", params.caseId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as ExternalConversationBinding) ?? null;
}

export async function listConversationBindingsForCase(
  db: DbClient,
  params: {
    organizationId: string;
    caseId: string;
    includeEnded?: boolean;
  }
): Promise<ExternalConversationBinding[]> {
  let query = db
    .from("external_conversation_bindings")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("case_id", params.caseId);
  if (!params.includeEnded) query = query.eq("status", "active");
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ExternalConversationBinding[];
}

/**
 * Ends a binding instead of deleting it, so the fact that a Case once bound
 * this conversation remains reconstructible. Frees the partial unique so a
 * later active binding of the same triple can be attached.
 */
export async function endConversationBinding(
  db: DbClient,
  params: {
    organizationId: string;
    bindingId: string;
  }
): Promise<ExternalConversationBinding> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("external_conversation_bindings")
    .update({
      status: "ended",
      ended_at: now,
      updated_at: now,
    })
    .eq("organization_id", params.organizationId)
    .eq("id", params.bindingId)
    .eq("status", "active")
    .select("*")
    .single();
  if (error) throw error;
  return data as ExternalConversationBinding;
}

/**
 * Writes conversation-authority fields on a `gu` thread. Refuses `advisor_wa`
 * so the CHECK is not the first line of defence. Does not write
 * `runtime_authority` on the Case.
 */
export async function updateConversationAuthority(
  db: DbClient,
  params: {
    organizationId: string;
    bindingId: string;
    conversationAuthority: ConversationAuthority | null;
    lastHumanActivityAt?: string | null;
    authoritySource?: string | null;
  }
): Promise<ExternalConversationBinding> {
  const current = await db
    .from("external_conversation_bindings")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("id", params.bindingId)
    .maybeSingle();
  if (current.error) throw current.error;
  const row = current.data as ExternalConversationBinding | null;
  if (!row) {
    throw new Error("updateConversationAuthority: binding not found in organization");
  }
  if (row.thread_kind === "advisor_wa") {
    throw new Error(
      "updateConversationAuthority: advisor_wa rows cannot carry conversation authority"
    );
  }

  const { data, error } = await db
    .from("external_conversation_bindings")
    .update({
      conversation_authority: params.conversationAuthority,
      last_human_activity_at: params.lastHumanActivityAt ?? row.last_human_activity_at,
      authority_source: params.authoritySource ?? row.authority_source,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", params.organizationId)
    .eq("id", params.bindingId)
    .eq("thread_kind", "gu")
    .select("*")
    .single();
  if (error) throw error;
  return data as ExternalConversationBinding;
}
