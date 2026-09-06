/**
 * Inbound source-event inbox (Technical Plan symbolic unit M-SOURCE-EVENTS).
 *
 * One inbox, two writers over time. Today an interim polling adapter inside the
 * SL-1 gateway writes rows; when cross-repo contract C1 ships, legacy-side
 * forwarding writes the same rows through the same contract. Keeping the
 * ingestion shape stable across that change is the point of the table.
 *
 * The `dedup_key` is the load-bearing part. It is what makes "the same event
 * delivered twice yields one effective admission outcome" (S1 AC-05) a
 * structural guarantee: the UNIQUE index rejects the second write, so no code
 * path has to remember to check.
 */

/** Where the event came from. Opaque to Gu OS beyond routing. */
export type SourceSystem = "traditional_gu";

/** The four first-class kinds named in Technical Plan §3. */
export type SourceEventKind =
  | "inbound_prospect_message"
  | "advisor_activity"
  | "appointment_change"
  | "assignment_change";

export const SOURCE_EVENT_KINDS: readonly SourceEventKind[] = [
  "inbound_prospect_message",
  "advisor_activity",
  "appointment_change",
  "assignment_change",
] as const;

/**
 * Processing lifecycle. `pending` and `processing` are both "not yet settled";
 * a claim moves a row between them and `claim_expires_at` bounds how long a
 * dead worker can hold one.
 */
export type SourceEventStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

/** Persisted row shape (snake_case, mirrors `source_events`). */
export interface SourceEvent {
  id: string;
  organization_id: string;
  source_system: SourceSystem;
  event_kind: SourceEventKind;
  external_ref: string | null;
  external_lead_ref: string | null;
  dedup_key: string;
  payload_jsonb: Record<string, unknown>;
  provenance_jsonb: Record<string, unknown>;
  status: SourceEventStatus;
  /**
   * Fencing token. Bumped by every successful claim or reclaim; every write a
   * claim owner makes is conditional on the epoch it was handed, so a worker
   * that stalls past its lease is locked out the moment someone reclaims.
   */
  claim_epoch: number;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  completed_at: string | null;
  processing_error: string | null;
  /**
   * The settled admission disposition, when this event has been evaluated.
   * Typed as `AdmissionDecision` by the consumer; kept opaque here so the inbox
   * does not depend on the admission vocabulary it merely carries.
   */
  decision_jsonb: Record<string, unknown> | null;
  /**
   * The Opportunity Case this event admitted, written BEFORE settlement so a
   * crash between materialisation and settlement stays recoverable.
   */
  admitted_case_id: string | null;
  received_at: string;
}

/**
 * Builds the stable identity of a logical source event.
 *
 * Deliberately a pure function in the shared types package rather than a
 * convention each caller reimplements: the polling adapter and the future C1
 * webhook must derive the *same* key for the same event, or duplicate
 * suppression silently stops working at the exact moment ingestion changes.
 *
 * External ids are opaque — joined, never parsed.
 */
export function buildSourceEventDedupKey(parts: {
  sourceSystem: SourceSystem;
  eventKind: SourceEventKind;
  /** The external identity the event is about (lead id, deal id, ...). */
  externalRef: string;
  /**
   * What distinguishes this event from the next one about the same subject —
   * a provider message id, a status-change id, a source timestamp. Required,
   * because without it every event about one lead would collapse into one row.
   */
  discriminator: string;
}): string {
  return [
    parts.sourceSystem,
    parts.eventKind,
    parts.externalRef.trim(),
    parts.discriminator.trim(),
  ].join(":");
}
