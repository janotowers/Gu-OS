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
 * Four rules shape it:
 *
 *  1. **The insert is the dedup check.** `UNIQUE (organization_id, dedup_key)`
 *     rejects a redelivery, so there is no read-then-write race to lose.
 *  2. **A claim is conditional.** Every transition is an UPDATE with the
 *     expected prior state in its WHERE clause, so two racing workers produce
 *     one winner and one no-op rather than two processings.
 *  3. **A claim is fenced.** Taking a claim bumps `claim_epoch`, and every write
 *     a claim owner makes carries the epoch it was handed. A worker that stalls
 *     past its lease cannot write anything once someone else has reclaimed: its
 *     UPDATE matches zero rows. Ownership is a durable condition, never an
 *     in-memory belief — the same compare-and-swap shape as
 *     `operational_cases.version`.
 *  4. **Only `completed` carries a settled decision.** An unsettled row means
 *     "not decided yet" — never "decided not to admit".
 *
 * Every fenced write returns whether it actually applied, because "the row was
 * not mine any more" and "the write succeeded" must never look alike to a
 * caller: a silent no-op reported as success is how a stale worker convinces
 * itself it finished.
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
      // Explicit rather than relying on the column defaults: `pending` at epoch
      // 0 is the first state of the processing machine, and the state machine
      // should be legible at the point that starts it.
      status: "pending",
      claim_epoch: 0,
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

/**
 * A held claim, carrying the epoch every subsequent write must present.
 *
 * The epoch — not the worker name — is the fence. Two attempts by the same
 * worker id are still distinct owners, which matters because a caller may pass
 * a stable `workerId` to make its claims attributable.
 */
export interface SourceEventClaim {
  event: SourceEvent;
  epoch: number;
}

function claimPatch(
  claimedBy: string,
  leaseSeconds: number,
  nextEpoch: number
): Record<string, unknown> {
  const now = new Date();
  return {
    status: "processing",
    claim_epoch: nextEpoch,
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
 * Conditional on the row still being `pending` AND on the epoch the caller
 * observed, so two workers racing from the same observation produce one winner
 * and one `null` rather than two processings.
 */
export async function claimSourceEvent(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    claimedBy: string;
    observedEpoch: number;
    leaseSeconds?: number;
  }
): Promise<SourceEventClaim | null> {
  const nextEpoch = params.observedEpoch + 1;
  const { data, error } = await db
    .from("source_events")
    .update(
      claimPatch(
        params.claimedBy,
        params.leaseSeconds ?? SOURCE_EVENT_LEASE_SECONDS,
        nextEpoch
      )
    )
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    .eq("status", "pending")
    .eq("claim_epoch", params.observedEpoch)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? { event: data as SourceEvent, epoch: nextEpoch } : null;
}

/**
 * Takes over an abandoned event: a `processing` row whose lease expired, or a
 * `failed` one.
 *
 * Mirrors the work-plane stale-claim recovery (00069). A dead worker must not
 * poison a `dedup_key` forever, and reclaiming is how a retry becomes possible
 * without ever bypassing the single-owner rule — each UPDATE carries the
 * expected prior state and the observed epoch, so exactly one reclaimer wins
 * and the previous owner is fenced out by the bump.
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
    observedEpoch: number;
    leaseSeconds?: number;
  }
): Promise<SourceEventClaim | null> {
  const leaseSeconds = params.leaseSeconds ?? SOURCE_EVENT_LEASE_SECONDS;
  const nextEpoch = params.observedEpoch + 1;
  const nowIso = new Date().toISOString();
  const patch = claimPatch(params.claimedBy, leaseSeconds, nextEpoch);

  // (a) A processing row whose lease has run out.
  const expired = await db
    .from("source_events")
    .update(patch)
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    .eq("status", "processing")
    .eq("claim_epoch", params.observedEpoch)
    .lte("claim_expires_at", nowIso)
    .select("*")
    .maybeSingle();
  if (expired.error) throw expired.error;
  if (expired.data) {
    return { event: expired.data as SourceEvent, epoch: nextEpoch };
  }

  // (b) A previously failed attempt.
  const failed = await db
    .from("source_events")
    .update(patch)
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    .eq("status", "failed")
    .eq("claim_epoch", params.observedEpoch)
    .select("*")
    .maybeSingle();
  if (failed.error) throw failed.error;
  return failed.data
    ? { event: failed.data as SourceEvent, epoch: nextEpoch }
    : null;
}

/** Common shape of every fenced write: did I still own the claim? */
async function fencedUpdate(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    epoch: number;
    patch: Record<string, unknown>;
  }
): Promise<boolean> {
  const { data, error } = await db
    .from("source_events")
    .update(params.patch)
    .eq("id", params.sourceEventId)
    .eq("organization_id", params.organizationId)
    // `processing` as well as the epoch: a settled event must not be revertible
    // by anyone, and an epoch alone would still allow a completed row to be
    // rewritten by whoever last held the claim.
    .eq("status", "processing")
    .eq("claim_epoch", params.epoch)
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/**
 * Records the decision BEFORE any irreversible materialisation.
 *
 * This ordering is what keeps the effective policy version attributable
 * (ADR-108, SA-2.1). If the Case were created first and the decision recorded
 * afterwards, a crash in between would leave an Opportunity whose governing
 * policy version is unrecoverable, and a retry could only guess it or
 * substitute whatever policy is effective at recovery time — rewriting the
 * historical authority context of a consequential decision.
 *
 * Written while the row is still `processing`: it is a decision, not a
 * settlement. Settling additionally requires that everything the decision owes
 * has actually been written.
 */
export async function recordSourceEventDecision(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    epoch: number;
    decision: Record<string, unknown>;
  }
): Promise<boolean> {
  return fencedUpdate(db, {
    organizationId: params.organizationId,
    sourceEventId: params.sourceEventId,
    epoch: params.epoch,
    patch: { decision_jsonb: params.decision },
  });
}

/**
 * Records that this event materialised a Case, before the event is settled.
 *
 * Fenced: a worker that lost its lease cannot repoint a link the new owner
 * already established.
 */
export async function linkAdmittedCase(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    epoch: number;
    caseId: string;
  }
): Promise<boolean> {
  return fencedUpdate(db, {
    organizationId: params.organizationId,
    sourceEventId: params.sourceEventId,
    epoch: params.epoch,
    patch: { admitted_case_id: params.caseId },
  });
}

/**
 * Marks the event settled — the answer every future duplicate receives.
 *
 * Fenced and `processing`-only, so a completed event can never be re-settled
 * and only the current owner may settle at all.
 */
export async function settleSourceEvent(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    epoch: number;
    decision: Record<string, unknown>;
    admittedCaseId?: string | null;
  }
): Promise<boolean> {
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
  return fencedUpdate(db, {
    organizationId: params.organizationId,
    sourceEventId: params.sourceEventId,
    epoch: params.epoch,
    patch,
  });
}

/**
 * Releases a failed attempt so it can be reclaimed.
 *
 * Fenced and `processing`-only, which is the point: a stale worker whose lease
 * expired must not be able to mark the NEW owner's row failed, and a completed
 * event must not be revertible to failed at all.
 */
export async function failSourceEvent(
  db: DbClient,
  params: {
    organizationId: string;
    sourceEventId: string;
    epoch: number;
    error: string;
  }
): Promise<boolean> {
  return fencedUpdate(db, {
    organizationId: params.organizationId,
    sourceEventId: params.sourceEventId,
    epoch: params.epoch,
    patch: {
      status: "failed",
      processing_error: params.error.slice(0, 500),
      claim_expires_at: null,
    },
  });
}

/**
 * Finds the Case this source event materialised.
 *
 * `admitted_case_id` covers everything after the link lands; this covers the
 * window between the `operational_cases` INSERT and that write, and is also how
 * a worker that loses the materialisation race — its INSERT rejected by the
 * unique index — finds the winner's Case.
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
