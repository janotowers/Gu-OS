/**
 * The Case Supervisor — R1 SL-4, shadow.
 *
 * One reconsideration of one Lead Opportunity. TD-8's per-wake sequence, with
 * every deterministic guarantee on this side of the line and exactly one
 * semantic judgment delegated to the model seam:
 *
 *   flags → tenancy → lease → compile context → delivery eligibility →
 *   JUDGE → claim the wake → record posture → durable work + commitments →
 *   safe yield with a re-entry path
 *
 * THE ORDER IS LOAD-BEARING, in three places.
 *
 * 1. **Delivery eligibility is resolved before the judgment and enforced after
 *    it.** S2 §8.1 invariant 19 makes contact restrictions non-overridable, so
 *    they are never something a model is asked to respect.
 *
 * 2. **The wake is claimed before anything durable is created.** The
 *    reconsideration event carries a `wake_key` under the M-WAKE-IDENTITY
 *    unique index, so a duplicate delivery conflicts there — before a single
 *    Work Item or commitment subject exists — and then converges by reading
 *    back the reconsideration that already happened (SA-4.6). A
 *    read-then-write guard would prove nothing under concurrency, which is the
 *    lesson SL-2 paid for.
 *
 * 3. **Yielding happens last, and only after the safe-yield check passes.** S2
 *    §8.21: "yielding is safe only after durable responsibility has somewhere
 *    coherent to go next."
 *
 * WHAT THIS MODULE CANNOT DO, STRUCTURALLY
 *
 * There is no send path, no effect path, no approval path and no authority
 * mutation in this file or anything it imports. SA-4.8 asserts that negatively
 * rather than assuming it, and the posture the model may propose is a subset
 * that has no way to express an external effect. Shadow is not a runtime check
 * here; it is the absence of the code that would be needed.
 *
 * Server-only: the executor reaches service-role tables.
 */
import {
  createWorkItemsFromTemplates,
  getCurrentCaseFacts,
  getOperationalCase,
  getRelationshipAdmissionMode,
  insertOperationalCaseEvent,
  isRelationshipOpsEnabled,
  listCurrentSubjectFactsByKind,
  markCaseProcessing,
  summarizeCaseWork,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type {
  OperationalCase,
  RelationshipAdmissionMode,
  SupervisorPosture,
  SupervisorReconsiderationRecord,
  SupervisorReconsiderationSettlement,
  SupervisorUncertaintyKind,
  SupervisorWakeReason,
  SupervisorYieldPosture,
} from "@agents/types";
import {
  NO_ACTION_POSTURES,
  SUPERVISOR_RECONSIDERED_EVENT_KIND,
  SUPERVISOR_SETTLED_EVENT_KIND,
  isShadowReachablePosture,
} from "@agents/types";
import {
  recordCommitments,
  summarizeOpenCommitments,
  type RecordedCommitment,
} from "./commitments";
import {
  DELIVERY_RESTRICTION_FACT_KEY,
  resolveDeliveryEligibility,
  type DeliveryEligibility,
} from "./delivery";
import type { NextWorkJudge, NextWorkProposal } from "./next-work-judge";

/** Postgres unique-violation: this wake was already reconsidered. */
const UNIQUE_VIOLATION = "23505";

/** The case type this supervisor is bound to (TD-8, seeded by SL-2). */
const LEAD_OPPORTUNITY_CASE_TYPE = "lead_opportunity";

/**
 * How far ahead to schedule when the judgment named no reconsideration
 * interval but the Case still needs a wake path.
 *
 * An **ordinary engineering value** under Methodology §14.1, not a product
 * threshold: no governing artifact approves a cadence, nothing about accepted
 * risk depends on it, and the guarantee that actually matters — that a wake
 * path exists at all (EC-39) — is independent of the number.
 */
const DEFAULT_RECONSIDER_HOURS = 24;

/** Bounds on a model-proposed interval. Engineering values, same reasoning. */
const MIN_RECONSIDER_HOURS = 1;
const MAX_RECONSIDER_HOURS = 24 * 30;

export type SupervisorInertReason =
  | "relationship_ops_disabled"
  | "supervisor_mode_disabled";

export type SupervisorRefusalReason =
  /** The Case does not exist, or is not a lead Opportunity. */
  | "case_not_supervisable"
  /** The Case belongs to a different Organization than the caller's context. */
  | "case_not_in_organization"
  /** Another worker holds the per-Case lease right now. */
  | "case_busy";

/**
 * The result of one reconsideration.
 *
 * `refused` and `already_reconsidered` are first-class outcomes, not errors.
 * Inventing a posture for a Case we could not lease, or re-running a wake that
 * already happened, is exactly what these shapes prevent.
 */
export type SupervisorResult =
  | { status: "inert"; reason: SupervisorInertReason }
  | { status: "refused"; reason: SupervisorRefusalReason }
  | {
      status: "already_reconsidered";
      wakeKey: string;
      record: SupervisorReconsiderationRecord | null;
    }
  | {
      status: "reconsidered";
      record: SupervisorReconsiderationRecord;
      eligibility: DeliveryEligibility;
      commitments: readonly RecordedCommitment[];
    };

/** The wake being answered. Identity is the caller's to establish. */
export interface SupervisorWake {
  reason: SupervisorWakeReason;
  /**
   * Durable identity of this logical wake. Two deliveries of the same wake must
   * carry the same key — that is what SA-4.6 coalesces on. Use `buildWakeKey`.
   */
  key: string;
}

export interface SupervisorRequest {
  db: DbClient;
  organizationId: string;
  /** The advisor profile owning the Case. Facts are written under it. */
  userId: string;
  caseId: string;
  wake: SupervisorWake;
  judge: NextWorkJudge;
  /**
   * Capabilities available for internal work, by name.
   *
   * Supplied by the caller rather than discovered here, because what a
   * supervisor may reach is bounded by the caller's authority — dynamic
   * planning never widens authority (S2 invariant 9, TD-8). Empty is a valid
   * and honest answer, and the model is expected to name a capability gap
   * rather than invent a workaround.
   */
  availableCapabilities?: readonly string[];
  /**
   * Fresh operational reads for the context compile (TD-8, S2 §8.2).
   *
   * A seam, not a dependency. SL-4's acceptance contract needs no legacy read,
   * and adding one would put a Traditional Gu credential on the path of every
   * reconsideration for no evidentiary gain. SL-5 and SL-8 are the Slices whose
   * behavior actually requires fresh sources; this is where they plug in.
   */
  freshReads?: readonly string[];
  /** Recent conversation, oldest first. Supplied by the caller's channel. */
  recentMessages?: readonly string[];
  /** Instant of the last inbound prospect message, when known. */
  lastInboundAt?: string | null;
  /** Injected clock. Deterministic tests need the boundary instants exactly. */
  now?: Date;
  leaseMinutes?: number;
}

/** Stable wake identities. Same logical wake ⇒ same key, always. */
export const buildWakeKey = {
  scheduled: (firedFor: string) => `scheduled:${firedFor}`,
  sourceEvent: (sourceEventId: string) => `source_event:${sourceEventId}`,
  commitmentDue: (subjectId: string, dueAt: string) =>
    `commitment:${subjectId}:${dueAt}`,
  priorWorkSettled: (workItemId: string, attempt: number) =>
    `work:${workItemId}:${attempt}`,
  manual: (label: string) => `manual:${label}`,
};

function clampHours(hours: number | null): number {
  if (hours === null || !Number.isFinite(hours)) return DEFAULT_RECONSIDER_HOURS;
  return Math.min(MAX_RECONSIDER_HOURS, Math.max(MIN_RECONSIDER_HOURS, hours));
}

/**
 * Where the reconsideration leaves durable responsibility (S2 §8.21).
 *
 * Derived from the chosen posture and the situation rather than asked of the
 * model: the yield posture is what the safe-yield gate is written against, and
 * a model that could name it could also name one that made its own stopping
 * look legitimate.
 */
function deriveYieldPosture(params: {
  posture: SupervisorPosture;
  createdDurableWork: boolean;
  eligibility: DeliveryEligibility;
  uncertainty: SupervisorUncertaintyKind | null;
}): SupervisorYieldPosture {
  if (params.uncertainty === "capability_gap") return "waiting_for_human_input";
  if (params.uncertainty !== null) return "no_useful_work_now";
  if (params.posture === "targeted_human_input") return "waiting_for_human_input";
  if (params.createdDurableWork) return "work_underway";
  if (params.posture === "gather_research_reconcile") return "reconciliation_established";
  if (params.posture === "work") return "work_underway";
  if (params.posture === "wait") {
    // A wait that exists because the prospect was told we would not contact
    // them yet is a wait on the clock, not on the prospect.
    return params.eligibility.blockedBy === "not_before"
      ? "waiting_until_time"
      : "waiting_for_prospect";
  }
  return "no_useful_work_now";
}

/**
 * S2 §8.21's stopping conditions, as a gate rather than a description.
 *
 * A reconsideration must not yield while material durable responsibility is
 * stranded. In the shadow stage the reachable stranding is the one EC-39 names:
 * choosing to wait with no wake path. There is no event forwarding yet — that
 * is C1 and SL-5 — so the timer is the *only* re-entry path in existence, and a
 * reconsideration that leaves none has left an open Case depending on human
 * memory.
 *
 * Returns the violated condition, or null when yielding is safe.
 */
export function checkSafeYield(record: {
  posture: SupervisorPosture;
  yield_posture: SupervisorYieldPosture;
  next_action_at: string | null;
}): string | null {
  if (record.next_action_at === null) {
    return "no re-entry path: a wake time is the only wake path in the shadow stage (EC-39)";
  }
  if (!isShadowReachablePosture(record.posture)) {
    return `posture ${record.posture} is not reachable in the shadow stage`;
  }
  return null;
}

/**
 * Facts that are deliberately withheld from the model's context.
 *
 * Currently one: the delivery restriction. It is a **hard bound** (S2 §8.12,
 * §8.1 invariant 19), enforced by `resolveDeliveryEligibility` before and after
 * the judgment. Putting it in the prompt would hand a confident model the exact
 * material it needs to reason around AC-03 — "the prospect said after the 20th,
 * but this match is important" — and the guarantee would then rest on the model
 * agreeing rather than on the gate. What the model is told is only that
 * outbound is unavailable, which is true regardless.
 *
 * This is a *withholding* rule, not a redaction rule: nothing is removed from
 * durable state, and the fact remains fully visible to replay, to the
 * reconstruction and to a human.
 */
const FACTS_WITHHELD_FROM_JUDGMENT = new Set<string>([
  DELIVERY_RESTRICTION_FACT_KEY,
]);

function factLines(facts: ReadonlyMap<string, { value_jsonb: unknown }>): string[] {
  const lines: string[] = [];
  for (const [key, fact] of facts) {
    if (FACTS_WITHHELD_FROM_JUDGMENT.has(key)) continue;
    lines.push(`${key}: ${JSON.stringify(fact.value_jsonb)}`);
  }
  return lines;
}

function readObjective(facts: ReadonlyMap<string, { value_jsonb: unknown }>): {
  objective: string | null;
  category: string | null;
} {
  const raw = facts.get("opportunity.objective")?.value_jsonb;
  if (!raw || typeof raw !== "object") return { objective: null, category: null };
  const row = raw as Record<string, unknown>;
  return {
    objective: typeof row.objective === "string" ? row.objective : null,
    category: typeof row.category === "string" ? row.category : null,
  };
}

/**
 * One reconsideration as durable state records it, claim and settlement merged.
 */
export interface PostureHistoryEntry extends SupervisorReconsiderationRecord {
  /**
   * False when the run was interrupted between claiming the wake and settling
   * it. Recoverable, not corrupt: the wake is claimed and nothing durable was
   * half-created, so the gap is visible instead of inferred (SA-4.11).
   */
  settled: boolean;
  /** When the reconsideration was claimed. */
  recorded_at: string;
}

/**
 * Prior reconsiderations, oldest first.
 *
 * This is what makes the loop situational rather than amnesiac, and it comes
 * from durable state alone — no session, no transcript, no model memory (S2
 * §8.22). It is also what lets the judge notice it has already tried something
 * (EC-26, AC-38) instead of repeating it.
 *
 * Reads BOTH halves and folds them together on `wake_key`. The timeline is
 * append-only, so what a reconsideration produced cannot be written back into
 * the claim that reserved the wake — reconstructing the whole record means
 * reading both, which is a durable-state read either way.
 */
export async function listPostureHistory(
  db: DbClient,
  caseId: string,
  limit = 20
): Promise<PostureHistoryEntry[]> {
  const claims = await db
    .from("operational_case_events")
    .select("*")
    .eq("case_id", caseId)
    .eq("payload_jsonb->>kind", SUPERVISOR_RECONSIDERED_EVENT_KIND)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (claims.error) throw claims.error;

  const settlements = await db
    .from("operational_case_events")
    .select("*")
    .eq("case_id", caseId)
    .eq("payload_jsonb->>kind", SUPERVISOR_SETTLED_EVENT_KIND)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (settlements.error) throw settlements.error;

  const byWake = new Map<string, SupervisorReconsiderationSettlement>();
  for (const row of (settlements.data ?? []) as Array<{
    payload_jsonb: Record<string, unknown>;
  }>) {
    const settlement =
      row.payload_jsonb as unknown as SupervisorReconsiderationSettlement;
    if (settlement.wake_key) byWake.set(settlement.wake_key, settlement);
  }

  const rows = (claims.data ?? []) as Array<{
    created_at: string;
    payload_jsonb: Record<string, unknown>;
  }>;
  return rows
    .map((row) => {
      const claim =
        row.payload_jsonb as unknown as SupervisorReconsiderationRecord;
      const settlement = byWake.get(claim.wake_key);
      return {
        ...claim,
        ...(settlement
          ? {
              yield_posture: settlement.yield_posture,
              proposed_work_ids: settlement.proposed_work_ids,
              commitment_subject_ids: settlement.commitment_subject_ids,
            }
          : {}),
        settled: settlement !== undefined,
        recorded_at: row.created_at,
      } satisfies PostureHistoryEntry;
    })
    .reverse();
}

async function findReconsiderationByWakeKey(
  db: DbClient,
  caseId: string,
  wakeKey: string
): Promise<SupervisorReconsiderationRecord | null> {
  const { data, error } = await db
    .from("operational_case_events")
    .select("*")
    .eq("case_id", caseId)
    .eq("payload_jsonb->>kind", SUPERVISOR_RECONSIDERED_EVENT_KIND)
    .eq("payload_jsonb->>wake_key", wakeKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { payload_jsonb: Record<string, unknown> };
  return row.payload_jsonb as unknown as SupervisorReconsiderationRecord;
}

/**
 * Runs one reconsideration.
 *
 * Never throws for an ordinary situational outcome. A model that is unavailable
 * or unsure produces a recorded reconsideration with preserved uncertainty
 * (SA-4.11), not an exception and not a fabricated posture.
 */
export async function runSupervisorWake(
  request: SupervisorRequest
): Promise<SupervisorResult> {
  const { db, organizationId, userId, caseId, wake } = request;
  const now = request.now ?? new Date();

  // ── 1. Flags. Off ⇒ fully inert: no read, no judgment, no model spend.
  if (!(await isRelationshipOpsEnabled(db, organizationId))) {
    return { status: "inert", reason: "relationship_ops_disabled" };
  }
  const mode: RelationshipAdmissionMode = await getRelationshipAdmissionMode(
    db,
    organizationId
  );
  // SL-4 ships `shadow` only. A stage this Slice does not implement must not
  // silently behave as if it did — the position SL-2 established.
  if (mode !== "shadow") {
    return { status: "inert", reason: "supervisor_mode_disabled" };
  }

  // ── 2. Tenancy, before anything else is read (SA-4.12).
  //
  // Resolved from the Case row rather than trusted from the caller: identity is
  // not authorization (ADR-106), and an ambiguous Case must fail closed rather
  // than be supervised under whichever Organization happened to ask.
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase || opCase.case_type !== LEAD_OPPORTUNITY_CASE_TYPE) {
    return { status: "refused", reason: "case_not_supervisable" };
  }
  if (opCase.organization_id !== organizationId) {
    return { status: "refused", reason: "case_not_in_organization" };
  }

  // ── 3. Per-Case serialization. TD-8 relies on the CURRENT lease for this.
  //
  // The version is captured BEFORE the lease is taken and the successor derived
  // from the captured value. Reading `opCase.version` again afterwards would be
  // reading a row the lease itself moved, and the fence would be off by one at
  // exactly the moment it matters.
  const versionAtRead = opCase.version;
  const leased = await markCaseProcessing(
    db,
    opCase.id,
    versionAtRead,
    request.leaseMinutes ?? 5
  );
  if (!leased) return { status: "refused", reason: "case_busy" };
  const leasedVersion = versionAtRead + 1;

  // ── 4. Compile the authorized current situation (S2 §8.2).
  const currentFacts = await getCurrentCaseFacts(db, userId, opCase.id);
  const commitments = await listCurrentSubjectFactsByKind(
    db,
    userId,
    opCase.id,
    "commitment"
  );
  const workSummary = await summarizeCaseWork(db, userId, [opCase.id]);
  const history = await listPostureHistory(db, opCase.id);
  const { objective, category } = readObjective(currentFacts);

  // ── 5. Delivery eligibility — deterministic, and never shown to the model.
  const eligibility = resolveDeliveryEligibility({ currentFacts, now });

  // ── 6. The one semantic judgment.
  const summary = workSummary.get(opCase.id);
  const proposal = await request.judge.propose({
    wakeReason: wake.reason,
    objective,
    objectiveCategory: category,
    currentFacts: factLines(currentFacts),
    recentMessages: request.recentMessages ?? [],
    openCommitments: summarizeOpenCommitments(commitments),
    workSummary: summary
      ? [
          `total: ${summary.total}`,
          `blocked: ${summary.blocked}`,
          ...Object.entries(summary.byStatus).map(([k, v]) => `${k}: ${v}`),
        ]
      : [],
    postureHistory: history.map(
      (r) => `${r.posture} — ${r.rationale}${r.uncertainty ? ` (${r.uncertainty})` : ""}`
    ),
    daysSinceLastInbound: request.lastInboundAt
      ? Math.floor(
          (now.getTime() - new Date(request.lastInboundAt).getTime()) / 86_400_000
        )
      : null,
    // Always false in SL-4: the stage is shadow, so nothing prospect-facing is
    // reachable regardless of what the eligibility gate says. Both facts are
    // recorded, and the deterministic assertion is the one that binds.
    outboundAvailable: false,
    availableCapabilities: request.availableCapabilities ?? [],
  });

  const settled = settleProposal({ proposal, eligibility });

  // ── 7. Claim the wake, BEFORE anything durable exists (SA-4.6).
  const record: SupervisorReconsiderationRecord = {
    kind: SUPERVISOR_RECONSIDERED_EVENT_KIND,
    v: 1,
    wake_reason: wake.reason,
    wake_key: wake.key,
    posture: settled.posture,
    yield_posture: "no_useful_work_now",
    rationale: settled.rationale,
    diagnosis: settled.diagnosis,
    uncertainty: settled.uncertainty,
    proposed_work_ids: [],
    commitment_subject_ids: [],
    next_action_at: new Date(
      now.getTime() + clampHours(settled.reconsiderInHours) * 3_600_000
    ).toISOString(),
    stage: "shadow",
    model_id: settled.modelId,
    policy_version: null,
  };

  let claimed;
  try {
    claimed = await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "agent",
      payload: record as unknown as Record<string, unknown>,
    });
  } catch (error) {
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    // This wake was already reconsidered. Nothing durable was created by this
    // call, which is the guarantee — converge on the existing record.
    return {
      status: "already_reconsidered",
      wakeKey: wake.key,
      record: await findReconsiderationByWakeKey(db, opCase.id, wake.key),
    };
  }
  void claimed;

  // ── 8. Durable consequences, only now that the wake is ours.
  const recordedCommitments = await recordCommitments({
    db,
    userId,
    caseId: opCase.id,
    existing: commitments,
    proposed: settled.commitments,
    wakeKey: wake.key,
    now,
  });

  const durable = settled.proposedWork.filter((w) => w.durable);
  let workIds: string[] = [];
  if (durable.length > 0 && opCase.workflow_definition_version !== null) {
    const created = await createWorkItemsFromTemplates(db, {
      userId,
      caseId: opCase.id,
      workflowDefinitionVersion: opCase.workflow_definition_version,
      // First consumer of the reserved seam (TD-8). The Work Plane never
      // branches on origin; it exists for audit and replay equivalence.
      origin: "agent_proposed",
      templates: durable.map((w) => ({
        work_type: w.work_type,
        required_capability: w.work_type,
        input_contract: { purpose: w.purpose, proposed_by: "case_supervisor" },
        // Keyed on the wake, so a retry of the SAME wake converges on the same
        // Work rather than proposing it twice.
        idempotency_key: `${wake.key}:${w.work_type}`,
      })),
    });
    workIds = [...created.created, ...created.existing].map((item) => item.id);
  }

  // ── 9. Land responsibility, then yield (S2 §8.21).
  const finalRecord: SupervisorReconsiderationRecord = {
    ...record,
    proposed_work_ids: workIds,
    commitment_subject_ids: recordedCommitments.map((c) => c.subjectId),
    yield_posture: deriveYieldPosture({
      posture: settled.posture,
      createdDurableWork: workIds.length > 0,
      eligibility,
      uncertainty: settled.uncertainty,
    }),
  };

  const stranded = checkSafeYield(finalRecord);
  if (stranded) {
    // Not reachable through the paths above — `next_action_at` is always set
    // and the posture is always shadow-reachable — but asserted rather than
    // assumed, because "responsibility was stranded" is the failure this gate
    // exists to make impossible rather than unlikely.
    throw new Error(`[relationship-supervisor] unsafe yield: ${stranded}`);
  }

  // The timeline row is append-only, so the outcome of the durable work is
  // narrated as its own event rather than by editing the claim.
  const settlement: SupervisorReconsiderationSettlement = {
    kind: SUPERVISOR_SETTLED_EVENT_KIND,
    v: 1,
    wake_key: wake.key,
    yield_posture: finalRecord.yield_posture,
    proposed_work_ids: workIds,
    commitment_subject_ids: finalRecord.commitment_subject_ids,
  };
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "state_changed",
    actor: "agent",
    payload: settlement as unknown as Record<string, unknown>,
  });

  await updateOperationalCase(db, opCase.id, leasedVersion, {
    nextActionAt: finalRecord.next_action_at,
  });

  return {
    status: "reconsidered",
    record: finalRecord,
    eligibility,
    commitments: recordedCommitments,
  };
}

/**
 * Turns a proposal — or its absence — into the settled shape the record needs.
 *
 * This is where SA-4.11 lives. A missing judgment, an insufficient-evidence
 * judgment and a capability gap are three different findings, and each one
 * produces a *recorded* reconsideration that preserves the uncertainty rather
 * than an exception or a manufactured posture. Quiet is not broken.
 */
function settleProposal(params: {
  proposal: NextWorkProposal | null;
  eligibility: DeliveryEligibility;
}): {
  posture: SupervisorPosture;
  rationale: string;
  diagnosis: string | null;
  uncertainty: SupervisorUncertaintyKind | null;
  proposedWork: NextWorkProposal["proposed_work"];
  commitments: NextWorkProposal["commitments"];
  reconsiderInHours: number | null;
  modelId: string | null;
} {
  const { proposal } = params;

  if (!proposal) {
    return {
      posture: "no_op",
      rationale:
        "No judgment was available for this reconsideration; the uncertainty is preserved and the Case remains wakeable.",
      diagnosis: null,
      uncertainty: "no_judgment_available",
      proposedWork: [],
      commitments: [],
      reconsiderInHours: null,
      modelId: null,
    };
  }

  const modelId = process.env.RELATIONSHIP_SUPERVISOR_MODEL_ID?.trim() || null;

  if (proposal.capability_gap) {
    return {
      posture: "targeted_human_input",
      rationale: `A required capability is unavailable: ${proposal.capability_gap}. Exposed as a gap rather than worked around.`,
      diagnosis: proposal.diagnosis,
      uncertainty: "capability_gap",
      proposedWork: [],
      commitments: proposal.commitments,
      reconsiderInHours: proposal.reconsider_in_hours,
      modelId,
    };
  }

  if (proposal.insufficient_evidence) {
    return {
      posture: "no_op",
      rationale: proposal.rationale,
      diagnosis: proposal.diagnosis,
      uncertainty: "insufficient_evidence",
      proposedWork: [],
      // A commitment observed in the evidence is still a commitment even when
      // the situational judgment was inconclusive. Dropping it here would lose
      // a promise for a reason that has nothing to do with the promise.
      commitments: proposal.commitments,
      reconsiderInHours: proposal.reconsider_in_hours,
      modelId,
    };
  }

  return {
    posture: proposal.posture,
    rationale: proposal.rationale,
    diagnosis: proposal.diagnosis,
    uncertainty: null,
    proposedWork: proposal.proposed_work,
    commitments: proposal.commitments,
    reconsiderInHours: proposal.reconsider_in_hours,
    modelId,
  };
}

/** True when the posture is a deliberate absence of action (SA-4.9). */
export function isNoActionPosture(posture: SupervisorPosture): boolean {
  return NO_ACTION_POSTURES.includes(posture);
}

export type { OperationalCase };
