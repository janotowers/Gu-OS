import type {
  SourceEvent,
  SourceEventKind,
  SourceEventStatus,
  SourceSystem,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * Inbound source-event inbox (Technical Plan symbolic unit M-SOURCE-EVENTS).
 *
 * `recordSourceEvent` is the only write a producer needs, and it is idempotent
 * by construction: the UNIQUE (organization_id, dedup_key) index rejects a
 * redelivery, and this module reports that as `created: false` plus the row
 * that already existed, rather than raising. That is what makes S1 AC-05 a
 * property of the schema instead of a rule every caller has to remember.
 *
 * The claim helpers exist because ingestion runs on more than one application
 * instance. They are intentionally boring: claim, complete, fail.
 */

/** Postgres unique-violation. A duplicate is an expected outcome here, not an error. */
const UNIQUE_VIOLATION = "23505";

export interface RecordSourceEventInput {
  organizationId: string;
  sourceSystem: SourceSystem;
  eventKind: SourceEventKind;
  dedupKey: string;
  externalRef?: string | null;
  externalLeadRef?: string | null;
  payload?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface RecordSourceEventResult {
  event: SourceEvent;
  /** False when an equivalent event was already recorded (AC-05). */
  created: boolean;
}

export async function recordSourceEvent(
  db: DbClient,
  input: RecordSourceEventInput
): Promise<RecordSourceEventResult> {
  if (!input.organizationId?.trim()) {
    throw new Error("recordSourceEvent: organizationId is required");
  }
  if (!input.dedupKey?.trim()) {
    throw new Error("recordSourceEvent: dedupKey is required");
  }

  const { data, error } = await db
    .from("source_events")
    .insert({
      organization_id: input.organizationId,
      source_system: input.sourceSystem,
      event_kind: input.eventKind,
      dedup_key: input.dedupKey,
      external_ref: input.externalRef ?? null,
      external_lead_ref: input.externalLeadRef ?? null,
      payload_jsonb: input.payload ?? {},
      provenance_jsonb: input.provenance ?? {},
    })
    .select("*")
    .single();

  if (!error) return { event: data as SourceEvent, created: true };
  if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;

  const existing = await getSourceEventByDedupKey(
    db,
    input.organizationId,
    input.dedupKey
  );
  if (!existing) {
    // The insert lost to a concurrent writer and the row is now unreadable —
    // a genuine fault, not a duplicate. Surfacing it beats returning a fake.
    throw error;
  }
  return { event: existing, created: false };
}

export async function getSourceEventByDedupKey(
  db: DbClient,
  organizationId: string,
  dedupKey: string
): Promise<SourceEvent | null> {
  const { data, error } = await db
    .from("source_events")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("dedup_key", dedupKey)
    .maybeSingle();
  if (error) throw error;
  return (data as SourceEvent) ?? null;
}

export async function listSourceEvents(
  db: DbClient,
  params: {
    organizationId: string;
    status?: SourceEventStatus;
    limit?: number;
  }
): Promise<SourceEvent[]> {
  let query = db
    .from("source_events")
    .select("*")
    .eq("organization_id", params.organizationId);
  if (params.status) query = query.eq("status", params.status);
  const { data, error } = await query
    .order("received_at", { ascending: true })
    .limit(params.limit ?? 50);
  if (error) throw error;
  return (data ?? []) as SourceEvent[];
}

/**
 * Takes a lease on a pending event.
 *
 * Conditional on the row still being `pending`, so two instances racing for the
 * same event produce one winner and one no-op rather than two processings.
 */
export async function claimSourceEvent(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    claimedBy: string;
    leaseSeconds?: number;
  }
): Promise<SourceEvent | null> {
  const now = new Date();
  const expires = new Date(now.getTime() + (params.leaseSeconds ?? 300) * 1000);
  const { data, error } = await db
    .from("source_events")
    .update({
      status: "processing",
      claimed_at: now.toISOString(),
      claimed_by: params.claimedBy,
      claim_expires_at: expires.toISOString(),
    })
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as SourceEvent) ?? null;
}

export async function completeSourceEvent(
  db: DbClient,
  params: { organizationId: string; sourceEventId: string }
): Promise<void> {
  const { error } = await db
    .from("source_events")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      processing_error: null,
    })
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId);
  if (error) throw error;
}

/**
 * Records the settled disposition on the inbox row and marks it complete.
 *
 * One statement, so an event can never be `completed` without the decision that
 * a redelivery will be answered with (AC-05).
 */
export async function settleSourceEvent(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    decision: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await db
    .from("source_events")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      processing_error: null,
      decision_jsonb: params.decision,
    })
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId);
  if (error) throw error;
}

export async function failSourceEvent(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    error: string;
  }
): Promise<void> {
  const { error } = await db
    .from("source_events")
    .update({
      status: "failed",
      processing_error: params.error.slice(0, 500),
    })
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId);
  if (error) throw error;
}
