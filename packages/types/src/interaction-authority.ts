/**
 * Interaction-authority resolution (R1 SL-6 / TD-3 / ADR-107).
 *
 * Four concepts stay distinct and are not flattened here:
 *   * the assigned advisor;
 *   * an organization member;
 *   * a same-thread human takeover;
 *   * off-thread advisor evidence (`advisor_wa`).
 *
 * `advisor_wa` cannot mint conversation authority. The per-lead takeover
 * flag is never the per-number kill switch. Case existence is not runtime
 * authority. This shape reports; it does not enforce and it does not
 * interpret a resume window.
 */

import type { LegacyReadProvenance } from "./legacy-gateway";
import type { RuntimeAuthority } from "./organizations";
import type { ConversationThreadKind } from "./conversation-bindings";

/**
 * Conversation-authority *answer*, including the fail-safe states.
 * Distinct from the stored TD-4 column (`gu | human_active` only).
 */
export type InteractionConversationVerdict =
  | "gu"
  | "human_active"
  | "unknown"
  | "conflicting";

/**
 * Opaque refs the resolver maps. The Organization is never taken from
 * these — it arrives on the caller context (later: the ADR-111 key).
 */
export interface InteractionAuthorityRefs {
  /** Opaque composite key. Compared whole, never parsed. */
  legacyLeadId?: string;
  /** Organization-scoped Case. Used to *read* runtime_authority, never to write it. */
  caseId?: string;
  /**
   * Observation kind. `advisor_wa` is evidence and cannot mint conversation
   * authority through any path.
   */
  threadKind?: ConversationThreadKind;
}

export type InteractionAuthorityAnsweredFrom =
  | "legacy_conversation_authority_get"
  | "none";

export interface InteractionAuthorityResolution {
  organizationId: string;
  /** Read from the Case when one is in-org. Never written by the resolver. */
  runtimeAuthority: RuntimeAuthority | null;
  conversationAuthority: InteractionConversationVerdict;
  /**
   * Confident same-thread takeover only. Null when the conversation
   * verdict is unknown or conflicting — a fail-safe is not "Gu holds it".
   */
  humanActive: boolean | null;
  leadTakeoverActive: boolean | null;
  lastOwnerInteractionAt: string | null;
  /** Distinct per-number kill switch. Never folded into `humanActive`. */
  numberKillSwitchActive: boolean | null;
  guNumberRef: string | null;
  advisorWaIgnored: boolean;
  answeredFrom: InteractionAuthorityAnsweredFrom;
  provenance: LegacyReadProvenance | null;
  failSafeReason: string | null;
}
