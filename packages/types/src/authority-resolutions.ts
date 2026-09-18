/**
 * Durable fail-safe authority resolutions (R1 SL-6 / TD-3 / SA-6.7).
 *
 * Only `unknown` and `conflicting` are stored. A confident conversation
 * verdict is not an incident. This row is what SL-7's `authority_conflict`
 * must-surface path consumes. It is not a write of `runtime_authority`.
 */

export type AuthorityResolutionState = "unknown" | "conflicting";

export type AuthorityResolutionResolvedAs = "gu" | "human_active";

export interface AuthorityResolution {
  id: string;
  organization_id: string;
  case_id: string | null;
  external_conversation_ref: string | null;
  state: AuthorityResolutionState;
  detected_at: string;
  fail_safe_reason: string | null;
  provenance_jsonb: Record<string, unknown>;
  runtime_authority_observed: "legacy" | "gu_os" | null;
  /** Opaque C2 logical request identity. Null on rows that predate the column. */
  provider_message_id: string | null;
  /** Null means the incident is still unresolved and may surface. */
  resolved_at: string | null;
  resolved_as: AuthorityResolutionResolvedAs | null;
  created_at: string;
}
