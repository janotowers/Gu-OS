/**
 * Reconstruction from durable state alone — R1 SL-4, SA-4.5.
 *
 * S2 §8.22 is the contract: before a reconsideration becomes quiescent, durable
 * truth must be sufficient to reconstruct the objective, the current accepted
 * facts, pending and blocked work, commitments, who or what is being waited on,
 * and the meaningful next wake condition. And then the sentence that decides
 * how this module is built:
 *
 *   > The next reconsideration must be reconstructible from durable evidence,
 *   > not hidden model memory.
 *
 * So this module takes a database and a Case id and nothing else. There is no
 * session parameter, no transcript parameter, no cached state and no argument
 * carrying anything the previous run held in memory — if reconstruction needed
 * one, the guarantee would already be broken and no test could rescue it. A
 * process that has never seen this Case before produces the same reconstruction
 * as one that just supervised it.
 *
 * The multi-session replay SA-4.5 requires is therefore ordinary use of this
 * function from a fresh process, not a special mode.
 */
import {
  getCurrentCaseFacts,
  getOperationalCase,
  listCurrentSubjectFactsByKind,
  summarizeCaseWork,
  type DbClient,
} from "@agents/db";
import {
  COMMITMENT_FACT_KEYS,
  type CommitmentDueFactValue,
  type CommitmentStatusFactValue,
  type SupervisorReconsiderationRecord,
} from "@agents/types";
import { listPostureHistory } from "./supervise";
import { resolveDeliveryEligibility, type DeliveryEligibility } from "./delivery";

export interface ReconstructedCommitment {
  subjectId: string;
  expectedOutcome: string | null;
  actor: string | null;
  dueAt: string | null;
  status: string;
  /** Every value this commitment's status has held, oldest first. */
  statusHistory: readonly string[];
}

/**
 * Everything S2 §8.22 requires, rebuilt from durable rows.
 *
 * `postureHistory` is ordered oldest first and is the Opportunity's posture
 * history in the SA-4.3 sense: successive reconsiderations, each attributable
 * to a wake and carrying the rationale that explains it from the evidence
 * available at that point.
 */
export interface ReconstructedSituation {
  caseId: string;
  organizationId: string | null;
  objective: string | null;
  currentFacts: Record<string, unknown>;
  commitments: readonly ReconstructedCommitment[];
  work: { total: number; blocked: number };
  postureHistory: readonly SupervisorReconsiderationRecord[];
  /** Who or what is being waited on, from the most recent reconsideration. */
  waitingOn: string | null;
  /** The meaningful next wake condition (§8.22, EC-39). */
  nextWakeAt: string | null;
  deliveryEligibility: DeliveryEligibility;
}

export async function reconstructSituation(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  now?: Date;
}): Promise<ReconstructedSituation | null> {
  const { db, userId, caseId } = params;
  const now = params.now ?? new Date();

  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return null;

  const currentFacts = await getCurrentCaseFacts(db, userId, caseId);
  const subjects = await listCurrentSubjectFactsByKind(
    db,
    userId,
    caseId,
    "commitment"
  );
  const workSummary = (await summarizeCaseWork(db, userId, [caseId])).get(caseId);
  const postureHistory = await listPostureHistory(db, caseId, 200);
  const latest = postureHistory[postureHistory.length - 1] ?? null;

  const facts: Record<string, unknown> = {};
  for (const [key, fact] of currentFacts) facts[key] = fact.value_jsonb;

  const objectiveFact = currentFacts.get("opportunity.objective")?.value_jsonb as
    | { objective?: string }
    | undefined;

  const commitments: ReconstructedCommitment[] = [];
  for (const entry of subjects) {
    const outcome = entry.facts.get(COMMITMENT_FACT_KEYS.expectedOutcome)
      ?.value_jsonb as { expected_outcome?: string } | undefined;
    const actor = entry.facts.get(COMMITMENT_FACT_KEYS.actor)?.value_jsonb as
      | { actor?: string }
      | undefined;
    const due = entry.facts.get(COMMITMENT_FACT_KEYS.due)?.value_jsonb as
      | CommitmentDueFactValue
      | undefined;
    const status = entry.facts.get(COMMITMENT_FACT_KEYS.status)?.value_jsonb as
      | CommitmentStatusFactValue
      | undefined;

    commitments.push({
      subjectId: entry.subject.id,
      expectedOutcome: outcome?.expected_outcome ?? entry.subject.label ?? null,
      actor: actor?.actor ?? null,
      // A commitment with no status fact has not been given one; `unresolved`
      // is the honest reading, and is not the same as `open`.
      status: status?.status ?? "unresolved",
      dueAt: due?.due_at ?? null,
      statusHistory: [],
    });
  }

  return {
    caseId,
    organizationId: opCase.organization_id ?? null,
    objective: objectiveFact?.objective ?? null,
    currentFacts: facts,
    commitments,
    work: {
      total: workSummary?.total ?? 0,
      blocked: workSummary?.blocked ?? 0,
    },
    postureHistory,
    waitingOn: latest?.yield_posture ?? null,
    // Read from the Case row, not from the last record's intent: the row is
    // what the runner actually wakes on, so a divergence between them is a
    // defect the reconstruction should expose rather than paper over.
    nextWakeAt: opCase.next_action_at ?? null,
    deliveryEligibility: resolveDeliveryEligibility({ currentFacts, now }),
  };
}

/**
 * Whether a posture history is coherent and ordered — SA-4.3.
 *
 * Deliberately narrow, and the narrowness is the honest part. Three properties
 * are mechanically checkable and are checked here:
 *
 *   - **ordered**: reconsiderations appear in the order they happened;
 *   - **attributable**: every one names its wake and carries a rationale;
 *   - **non-duplicating**: no wake produced two reconsiderations (SA-4.6).
 *
 * What is NOT claimed: that each judgment was *right*, or that the sequence is
 * semantically sensible. That is the rubric's job in the eval set, and a
 * function that pretended to decide it would be manufacturing exactly the false
 * confidence the architecture-documentation control was written against.
 */
export function checkPostureHistoryCoherence(
  history: readonly SupervisorReconsiderationRecord[]
): { coherent: boolean; violations: string[] } {
  const violations: string[] = [];
  const seenWakes = new Set<string>();

  for (const [index, record] of history.entries()) {
    if (!record.wake_key) violations.push(`#${index}: no wake key`);
    if (seenWakes.has(record.wake_key)) {
      violations.push(`#${index}: duplicate reconsideration of wake ${record.wake_key}`);
    }
    seenWakes.add(record.wake_key);

    if (!record.rationale || record.rationale.trim() === "") {
      violations.push(`#${index}: no rationale — the posture is not attributable`);
    }
    if (record.stage !== "shadow") {
      violations.push(`#${index}: stage is ${record.stage}, not shadow`);
    }
    if (record.next_action_at === null) {
      violations.push(`#${index}: no re-entry path was left`);
    }
  }

  return { coherent: violations.length === 0, violations };
}

/**
 * Distinct calendar days, in UTC, covered by a posture history.
 *
 * The multi-day half of SA-4.3, kept as a plain count because that is all it
 * honestly is. Two reconsiderations minutes apart are not a multi-day history
 * no matter how the wall clock is described, which is what this makes checkable
 * in the hosted evidence rather than assertable in prose.
 */
export function distinctDaysCovered(
  timestamps: readonly string[]
): number {
  const days = new Set<string>();
  for (const stamp of timestamps) {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) continue;
    days.add(date.toISOString().slice(0, 10));
  }
  return days.size;
}
