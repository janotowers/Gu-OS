/**
 * LegacyServiceAuth v1 (ADR-111 / TD-13).
 *
 * Wire contract types for the Gu OS verifier. The interoperability source of
 * truth is the ADR plus the ratified fixture — this module does not invent
 * purposes, header names or status codes.
 */

export const LEGACY_SERVICE_AUTH_PURPOSES = [
  "events-ingest",
  "authority-read",
  "delivery-callback",
  "legacy-read",
] as const;

export type LegacyServiceAuthPurpose =
  (typeof LEGACY_SERVICE_AUTH_PURPOSES)[number];

export const LEGACY_SERVICE_AUTH_FRESHNESS_SECONDS = 300;

/** Declared C2 caller. Not taken from the payload. */
export const LEGACY_SERVICE_AUTH_C2_SERVICE = "traditional_gu";
/** Declared C2 source system. Not taken from the payload. */
export const LEGACY_SERVICE_AUTH_C2_SOURCE_SYSTEM = "traditional_gu";

/** Same JSON body for every 401. Unknown key is indistinguishable from bad HMAC. */
export const LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY = {
  error: "unauthorized",
  reason: "authentication_failed",
} as const;

export interface LegacyServiceAuthKey {
  keyId: string;
  secret: string;
  service: string;
  purpose: LegacyServiceAuthPurpose;
  /** Gu OS Organization bound to this key. Never taken from a payload claim. */
  organizationId: string;
  legacySourceScope: {
    sourceSystem: string;
    /** Empty means no owner is in scope (fail closed), not "any owner". */
    ownerRefs: readonly string[];
  };
  /** Unix epoch seconds. Null means unbounded on that side. */
  notBefore: number | null;
  notAfter: number | null;
  revoked: boolean;
}

export type ConversationThreadKindWire = "gu" | "advisor_wa";

/**
 * C2 advisory request. Opaque refs only. `organization_id` is a consistency
 * check against the key, never an authorization input.
 */
export interface LegacyAuthorityRequestBody {
  legacy_lead_id?: string;
  case_id?: string;
  thread_kind?: ConversationThreadKindWire;
  organization_id?: string;
  legacy_owner_ref?: string;
  /**
   * Logical C2 request identity. The provider message id available at the
   * Traditional Gu pre-agent seam after its dedup guard (Technical Plan
   * Appendix D.3). Opaque; compared whole. Required to persist a fail-safe
   * incident so a retry cannot insert a duplicate.
   */
  provider_message_id?: string;
}

/** Advisory answer. Nothing here is an instruction to suppress a reply. */
export interface LegacyAuthorityResponseBody {
  advisory: true;
  organization_id: string;
  runtime_authority: "legacy" | "gu_os" | null;
  conversation_authority: "gu" | "human_active" | "unknown" | "conflicting";
  human_active: boolean | null;
  lead_takeover_active: boolean | null;
  last_owner_interaction_at: string | null;
  number_kill_switch_active: boolean | null;
  gu_number_ref: string | null;
  advisor_wa_ignored: boolean;
  answered_from: "legacy_conversation_authority_get" | "none";
  fail_safe_reason: string | null;
}
