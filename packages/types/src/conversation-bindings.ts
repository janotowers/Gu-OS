/**
 * External conversation bindings (Technical Plan TD-4 / TD-3, R1 SL-6).
 *
 * Distinct from `operational_case_conversation_bindings` (00044), which is the
 * internal web/telegram routing table. This type is the Organization-scoped
 * binding to an opaque Traditional Gu conversation.
 *
 * Two rules this module exists to keep:
 *   * the external ref is OPAQUE — stored and compared whole, never parsed.
 *     Legacy `lead_id` is a reference, never the Gu OS conversation identity;
 *   * `advisor_wa` rows are evidence-only. Conversation-authority fields are
 *     valid only on `thread_kind: "gu"`. An advisor-thread observation cannot
 *     mint authority.
 */

export type ConversationProvider = "whatsapp_business";

export type ConversationThreadKind = "gu" | "advisor_wa";

/** TD-3 conversation authority. Not runtime decision authority (`legacy | gu_os`). */
export type ConversationAuthority = "gu" | "human_active";

export type ConversationBindingStatus = "active" | "ended";

/** Persisted row shape (snake_case, mirrors `external_conversation_bindings`). */
export interface ExternalConversationBinding {
  id: string;
  organization_id: string;
  case_id: string;
  contact_id: string;
  provider: ConversationProvider;
  /** Opaque. Composite legacy identities are stored and compared whole. */
  external_conversation_ref: string;
  gu_channel_identity_binding_id: string | null;
  thread_kind: ConversationThreadKind;
  conversation_authority: ConversationAuthority | null;
  last_human_activity_at: string | null;
  authority_source: string | null;
  status: ConversationBindingStatus;
  ended_at: string | null;
  provenance_jsonb: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
