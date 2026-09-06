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
 * This module owns the processing state machine that makes S1 AC-05 hold under
 * at-least-once delivery, concurrency and crashes — not just on the happy path:
 *
 *     pending ──claim──► processing ──settle──► completed
 *                            │  └──fail──► failed
 *                            └──lease expires──► reclaimable
 *
 * Three rules shape it:
 *
 *  1. **The insert is the dedup check.** `UNIQUE (organization_id, dedup_key)`
 *     rejects a redelivery, so there is no read-then-write race to lose.
 *  2. **A claim is conditional.** Every transition is an UPDATE with the
 *     expected prior state in its WHERE clause, so two racing workers produce
 *     one winner and one no-op rather than two processings.
 *  3. **Only `completed` carries a decision.** An unsettled row means "not
 *     decided yet" — never "decided not to admit". Nothing here invents an
 *     outcome for a row that has not settled.
 */

/** Postgres unique-violation. A duplicate is an expected outcome here, not an error. */
const UNIQUE_VIOLATION = "23505";

/** Default claim lease. Long enough for a model call, short enough to recover. */
export const SOURCE_EVENT_LEASE_SECONDS = 300;

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
      // Explicit rather than relying on the column default: `pending` is the
      // first state of the processing machine, and the state machine should be
      // legible at the point that starts it.
      status: "pending",
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

export async function getSourceEventById(
  db: DbClient,
  organizationId: string,
  sourceEventId: string
): Promise<SourceEvent | null> {
  const { data, error } = await db
    .from("source_events")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", sourceEventId)
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

/** True when a `processing` row's lease has run out and it may be reclaimed. */
export function isClaimExpired(
  event: SourceEvent,
  now: Date = new Date()
): boolean {
  if (event.status !== "processing") return false;
  if (!event.claim_expires_at) return true;
  return new Date(event.claim_expires_at).getTime() <= now.getTime();
}

type ClaimPatch = Record<string, unknown>;

function claimPatch(claimedBy: string, leaseSeconds: number): ClaimPatch {
  const now = new Date();
  return {
    status: "processing",
    claimed_at: now.toISOString(),
    claimed_by: claimedBy,
    claim_expires_at: new Date(
      now.getTime() + leaseSeconds * 1000
    ).toISOString(),
    processing_error: null,
  };
}

/**
 * Takes the lease on a `pending` event.
 *
 * Conditional on the row still being `pending`, so two workers racing for the
 * same event produce one winner and one `null` rather than two processings.
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
  const { data, error } = await db
    .from("source_events")
    .update(
      claimPatch(params.claimedBy, params.leaseSeconds ?? SOURCE_EVENT_LEASE_SECONDS)
    )
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as SourceEvent) ?? null;
}

/**
 * Takes over an abandoned event: a `processing` row whose lease expired, or a
 * `failed` one.
 *
 * Mirrors the work-plane stale-claim recovery (00069). A dead worker must not
 * poison a `dedup_key` forever, and reclaiming is how a retry becomes possible
 * without ever bypassing the single-owner rule — each UPDATE still carries the
 * expected prior state, so exactly one reclaimer wins.
 *
 * Two narrow conditional updates rather than one disjunction: each is a plain
 * equality/comparison filter, which keeps the behaviour identical on PostgREST
 * and legible in the suite that proves it.
 *
 * Returns null when the row is not reclaimable — including the case that
 * someone else reclaimed it first.
 */
export async function reclaimSourceEvent(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    claimedBy: string;
    leaseSeconds?: number;
  }
): Promise<SourceEvent | null> {
  const leaseSeconds = params.leaseSeconds ?? SOURCE_EVENT_LEASE_SECONDS;
  const nowIso = new Date().toISOString();

  // (a) A processing row whose lease has run out.
  const expired = await db
    .from("source_events")
    .update(claimPatch(params.claimedBy, leaseSeconds))
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    .eq("status", "processing")
    .lte("claim_expires_at", nowIso)
    .select("*")
    .maybeSingle();
  if (expired.error) throw expired.error;
  if (expired.data) return expired.data as SourceEvent;

  // (b) A previously failed attempt.
  const failed = await db
    .from("source_events")
    .update(claimPatch(params.claimedBy, leaseSeconds))
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    .eq("status", "failed")
    .select("*")
    .maybeSingle();
  if (failed.error) throw failed.error;
  return (failed.data as SourceEvent) ?? null;
}

/**
 * Records that this event materialised a Case, BEFORE the event is settled.
 *
 * The ordering is the recovery guarantee: a process that dies between Case
 * creation and settlement leaves a durable pointer, so the retry reconciles to
 * the existing Case rather than creating a second Opportunity (S1 §8.16).
 */
export async function linkAdmittedCase(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    caseId: string;
  }
): Promise<void> {
  const { error } = await db
    .from("source_events")
    .update({ admitted_case_id: params.caseId })
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
    admittedCaseId?: string | null;
  }
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: "completed",
    completed_at: new Date().toISOString(),
    processing_error: null,
    decision_jsonb: params.decision,
    claim_expires_at: null,
  };
  if (params.admittedCaseId !== undefined) {
    patch.admitted_case_id = params.admittedCaseId;
  }
  const { error } = await db
    .from("source_events")
    .update(patch)
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
      claim_expires_at: null,
    })
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId);
  if (error) throw error;
}

/**
 * Finds a Case this source event already materialised.
 *
 * `admitted_case_id` covers everything after it is written; this covers the
 * narrow window between the `operational_cases` INSERT and that write, because
 * the executor stamps the source event id into the Case context. Two
 * independent ways to find an existing Case is what makes "never create a
 * second Opportunity" hold across an arbitrary crash point.
 */
export async function findCaseMaterialisedBySourceEvent(
  db: DbClient,
  params: { organizationId: string; sourceEventId: string }
): Promise<string | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("context_jsonb->>source_event_id", params.sourceEventId)
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
