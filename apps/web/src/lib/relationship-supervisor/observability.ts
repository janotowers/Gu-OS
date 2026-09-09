/**
 * Posture and no-op observability — R1 SL-4, SA-4.9.
 *
 * Technical Plan §7 assigns "supervisor posture/no-op ratios" to the case-event
 * taxonomy, which is where the reconsideration record already lives, so this is
 * an aggregation over durable rows rather than a new counter to keep in sync.
 *
 * **NO THRESHOLD IS ASSERTED HERE, AND THAT IS DELIBERATE.** The approved
 * Definition-of-Done evidence says the no-op ratio must be *observable*; S2 §13
 * requires the reconsideration result to be recorded; and no governing artifact
 * approves a numeric target. SA-4.9 therefore contracts observability, and a
 * number invented in this file would be a product threshold the Slice does not
 * own — manufactured under the appearance of engineering. The distribution is
 * reported; judging it is somebody else's job, with somebody else's authority.
 */
import type { DbClient } from "@agents/db";
import {
  NO_ACTION_POSTURES,
  SUPERVISOR_RECONSIDERED_EVENT_KIND,
  type SupervisorPosture,
  type SupervisorWakeReason,
} from "@agents/types";

export interface PostureDistribution {
  organizationId: string;
  /** Reconsiderations counted. Zero is a legitimate reading, not an error. */
  total: number;
  byPosture: Partial<Record<SupervisorPosture, number>>;
  byWakeReason: Partial<Record<SupervisorWakeReason, number>>;
  /** Reconsiderations that preserved uncertainty rather than judging (SA-4.11). */
  uncertain: number;
  /** `no_op` + `wait`. The numerator of the ratio, reported without a target. */
  noAction: number;
  /**
   * `noAction / total`, or null when nothing has been observed.
   *
   * Null rather than 0, because "no reconsiderations happened" and "no
   * reconsideration was quiet" are different facts and a zero would let the
   * first be read as the second.
   */
  noActionRatio: number | null;
  /** Distinct UTC days the observed reconsiderations span (SA-4.3). */
  distinctDays: number;
}

interface EventRow {
  case_id: string;
  created_at: string;
  payload_jsonb: Record<string, unknown>;
}

/**
 * Aggregates one Organization's reconsiderations.
 *
 * Organization-scoped by joining through the Cases that belong to it, which is
 * the authorization order Technical Plan §6 requires — resolve the tenant
 * first, then read. The event rows themselves carry no Organization column,
 * because Case children derive tenancy from the parent (TD-14, ADR-106).
 */
export async function summarizePostureDistribution(params: {
  db: DbClient;
  organizationId: string;
  /** Only reconsiderations at or after this instant. */
  since?: Date;
  limit?: number;
}): Promise<PostureDistribution> {
  const { db, organizationId } = params;

  const { data: caseRows, error: caseError } = await db
    .from("operational_cases")
    .select("id")
    .eq("organization_id", organizationId)
    .limit(1000);
  if (caseError) throw caseError;
  const caseIds = ((caseRows ?? []) as Array<{ id: string }>).map((r) => r.id);

  const empty: PostureDistribution = {
    organizationId,
    total: 0,
    byPosture: {},
    byWakeReason: {},
    uncertain: 0,
    noAction: 0,
    noActionRatio: null,
    distinctDays: 0,
  };
  if (caseIds.length === 0) return empty;

  let query = db
    .from("operational_case_events")
    .select("case_id, created_at, payload_jsonb")
    .in("case_id", caseIds)
    .eq("payload_jsonb->>kind", SUPERVISOR_RECONSIDERED_EVENT_KIND)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 1000);
  if (params.since) query = query.gte("created_at", params.since.toISOString());

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as EventRow[];
  if (rows.length === 0) return empty;

  const byPosture: Partial<Record<SupervisorPosture, number>> = {};
  const byWakeReason: Partial<Record<SupervisorWakeReason, number>> = {};
  const days = new Set<string>();
  let uncertain = 0;
  let noAction = 0;

  for (const row of rows) {
    const posture = row.payload_jsonb.posture as SupervisorPosture | undefined;
    const wakeReason = row.payload_jsonb.wake_reason as
      | SupervisorWakeReason
      | undefined;
    if (posture) {
      byPosture[posture] = (byPosture[posture] ?? 0) + 1;
      if (NO_ACTION_POSTURES.includes(posture)) noAction += 1;
    }
    if (wakeReason) {
      byWakeReason[wakeReason] = (byWakeReason[wakeReason] ?? 0) + 1;
    }
    if (row.payload_jsonb.uncertainty) uncertain += 1;
    days.add(row.created_at.slice(0, 10));
  }

  return {
    organizationId,
    total: rows.length,
    byPosture,
    byWakeReason,
    uncertain,
    noAction,
    noActionRatio: noAction / rows.length,
    distinctDays: days.size,
  };
}
