/**
 * The typed input contract of the Work Portfolio's pure rules (R1 SL-7).
 *
 * One `PortfolioCaseSnapshot` is everything the must-surface predicates and
 * the posture derivation may look at for one Case. Two properties are
 * structural here rather than promised elsewhere:
 *
 *  - **there is no presentation state in it.** A person's snooze, hide, pin or
 *    seen marker has no field to live in, so the predicates cannot read it even
 *    by accident — TD-9's hard guard, first half;
 *  - **the remaining predicates without a producer are typed inputs, not queries.**
 *    `approval_requests` and `effect_operations` are always empty from the
 *    live wiring (Slice Plan SL-7, D4). `authority_conflict` is live as of
 *    SL-6: assembled from durable `authority_resolutions` rows. The remaining
 *    empty inputs stay typed fixtures until SL-9.
 *
 * `approval_decisions` IS live: `case_approvals` exists and every surface
 * records decisions there, which is what makes "decided in Telegram ⇒ the web
 * does not ask again" hold the moment a producer exists.
 */
import {
  COMMITMENT_FACT_KEYS,
  OPPORTUNITY_CLOSURE_FACT_KEY,
  SUPERVISOR_RECONSIDERED_EVENT_KIND,
  SUPERVISOR_SETTLED_EVENT_KIND,
  type CaseApproval,
  type CaseApprovalDecision,
  type CaseFact,
  type CaseSubject,
  type OperationalCase,
  type OperationalCaseEvent,
  type OperationalCaseStatus,
  type RuntimeAuthority,
  type SupervisorPosture,
  type SupervisorUncertaintyKind,
  type SupervisorYieldPosture,
  type WorkItem,
  type WorkItemOrigin,
  type WorkItemStatus,
  type AuthorityResolution,
} from "@agents/types";

export interface PortfolioCase {
  id: string;
  organization_id: string;
  /** The Case owner's profile — the tenant key the CURRENT kernel rows use. */
  user_id: string;
  case_type: string;
  status: OperationalCaseStatus;
  runtime_authority: RuntimeAuthority | null;
  assigned_to_user_id: string | null;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PortfolioFact {
  id: string;
  fact_key: string;
  value: unknown;
  recorded_at: string;
  subject_id: string | null;
}

/** One reconsideration, claim and settlement folded on `wake_key`. */
export interface PortfolioReconsideration {
  wake_key: string;
  claim_event_id: string;
  claimed_at: string;
  posture: SupervisorPosture;
  rationale: string;
  diagnosis: string | null;
  uncertainty: SupervisorUncertaintyKind | null;
  next_action_at: string | null;
  /** Null for a run interrupted between claim and settlement (SA-4.11). */
  settlement: {
    event_id: string;
    settled_at: string;
    yield_posture: SupervisorYieldPosture;
    proposed_work_ids: readonly string[];
    commitment_subject_ids: readonly string[];
  } | null;
}

export interface PortfolioWork {
  id: string;
  work_type: string;
  status: WorkItemStatus;
  origin: WorkItemOrigin;
  blocked_reason: string | null;
  /** `input_contract_jsonb.purpose`, as the proposing reconsideration wrote it. */
  purpose: string | null;
  created_at: string;
  updated_at: string;
}

/** One commitment subject and its four current facts (TD-14). */
export interface PortfolioCommitment {
  subject_id: string;
  label: string | null;
  created_at: string;
  status: PortfolioFact | null;
  actor: PortfolioFact | null;
  due: PortfolioFact | null;
  expected_outcome: PortfolioFact | null;
}

/**
 * A durable approval request. **No Organization-Case producer before SL-9**;
 * the shape is what the rule needs, and SL-9 is where it is wired.
 */
export interface PortfolioApprovalRequest {
  request_id: string;
  approval_kind: string;
  decision_subject: string;
  consequence: string | null;
  requested_at: string;
  requested_by_work_item_id: string | null;
  evidence_hash: string;
  evidence_snapshot: Record<string, unknown>;
  withdrawn_at: string | null;
  superseded_by: string | null;
}

export interface PortfolioApprovalDecision {
  id: string;
  approval_kind: string;
  decision: CaseApprovalDecision;
  decided_at: string;
  evidence_hash: string;
  superseded_by: string | null;
}

/** TD-3's fail-safe incident. Produced by SL-6 `authority_resolutions`. */
export interface PortfolioAuthorityConflict {
  resolution_id: string;
  state: "unknown" | "conflicting";
  detected_at: string;
}

/** A TD-6 effect operation. **No table or producer before SL-9.** */
export interface PortfolioEffectOperation {
  id: string;
  capability: string;
  status: "claimed" | "running" | "succeeded" | "failed" | "unknown_outcome";
  updated_at: string;
}

export interface PortfolioCaseSnapshot {
  case: PortfolioCase;
  /** Current `opportunity.closure`, or null. */
  closure: PortfolioFact | null;
  /** Current `opportunity.objective`, for labeling only. */
  objective: PortfolioFact | null;
  /**
   * Every current case-level fact, newest value per key (R1 SL-12). Read by the
   * contextual ranking pass as evidence it may cite; the must-surface rules and
   * the posture derivation never read it. Optional so SL-7's typed fixtures
   * stay valid; the live assembly always fills it.
   */
  case_facts?: PortfolioFact[];
  /** Oldest first. */
  reconsiderations: PortfolioReconsideration[];
  work: PortfolioWork[];
  commitments: PortfolioCommitment[];
  approval_requests: PortfolioApprovalRequest[];
  approval_decisions: PortfolioApprovalDecision[];
  authority_conflict: PortfolioAuthorityConflict | null;
  effect_operations: PortfolioEffectOperation[];
}

// ============================================================
// Assembly from rows
// ============================================================

function toFact(row: CaseFact): PortfolioFact {
  return {
    id: row.id,
    fact_key: row.fact_key,
    value: row.value_jsonb,
    recorded_at: row.recorded_at,
    subject_id: row.subject_id ?? null,
  };
}

/**
 * Current value per key within a scope. Facts arrive newest first; the first
 * row seen for a key wins, which is also what repairs an interrupted
 * supersession (two unsuperseded rows: the later one is current).
 */
function newestByKey(rows: readonly CaseFact[]): Map<string, PortfolioFact> {
  const byKey = new Map<string, PortfolioFact>();
  const sorted = [...rows].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));
  for (const row of sorted) if (!byKey.has(row.fact_key)) byKey.set(row.fact_key, toFact(row));
  return byKey;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Folds the append-only timeline into reconsiderations — the same claim +
 * settlement pairing the SL-4 supervisor reads its own history with.
 */
function reconsiderationsOf(events: readonly OperationalCaseEvent[]): PortfolioReconsideration[] {
  const settlements = new Map<string, OperationalCaseEvent>();
  for (const event of events) {
    const payload = event.payload_jsonb ?? {};
    if (payload.kind !== SUPERVISOR_SETTLED_EVENT_KIND) continue;
    const key = asString(payload.wake_key);
    if (key) settlements.set(key, event);
  }

  return events
    .filter((event) => event.payload_jsonb?.kind === SUPERVISOR_RECONSIDERED_EVENT_KIND)
    .map((event) => {
      const claim = event.payload_jsonb;
      const wakeKey = asString(claim.wake_key) ?? "";
      const settled = settlements.get(wakeKey);
      const settlement = settled?.payload_jsonb;
      return {
        wake_key: wakeKey,
        claim_event_id: event.id,
        claimed_at: event.created_at,
        posture: claim.posture as SupervisorPosture,
        rationale: asString(claim.rationale) ?? "",
        diagnosis: asString(claim.diagnosis),
        uncertainty: (asString(claim.uncertainty) as SupervisorUncertaintyKind | null) ?? null,
        next_action_at: asString(claim.next_action_at),
        settlement:
          settled && settlement
            ? {
                event_id: settled.id,
                settled_at: settled.created_at,
                yield_posture: settlement.yield_posture as SupervisorYieldPosture,
                proposed_work_ids: asStringArray(settlement.proposed_work_ids),
                commitment_subject_ids: asStringArray(settlement.commitment_subject_ids),
              }
            : null,
      };
    })
    .sort((a, b) => Date.parse(a.claimed_at) - Date.parse(b.claimed_at));
}

function toWork(row: WorkItem): PortfolioWork {
  return {
    id: row.id,
    work_type: row.work_type,
    status: row.status,
    origin: row.origin,
    blocked_reason: row.blocked_reason ?? null,
    purpose: asString(row.input_contract_jsonb?.purpose),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function latestAuthorityConflict(
  rows: readonly AuthorityResolution[]
): PortfolioAuthorityConflict | null {
  if (rows.length === 0) return null;
  const latest = [...rows].sort((a, b) =>
    Date.parse(b.detected_at) - Date.parse(a.detected_at)
  )[0];
  if (!latest) return null;
  return {
    resolution_id: latest.id,
    state: latest.state,
    detected_at: latest.detected_at,
  };
}

function toPortfolioCase(row: OperationalCase): PortfolioCase | null {
  if (!row.organization_id) return null;
  return {
    id: row.id,
    organization_id: row.organization_id,
    user_id: row.user_id,
    case_type: row.case_type,
    status: row.status,
    runtime_authority: row.runtime_authority ?? null,
    assigned_to_user_id: row.assigned_to_user_id ?? null,
    next_action_at: row.next_action_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Builds one snapshot per Case of `organizationId` from the rows the
 * authorized reads returned.
 *
 * A row for any Case outside that set is ignored, and a Case of another
 * Organization is dropped even if a read returned it — defense in depth behind
 * RLS, never a substitute for it.
 */
export function buildCaseSnapshots(input: {
  organizationId: string;
  cases: readonly OperationalCase[];
  facts: readonly CaseFact[];
  subjects: readonly CaseSubject[];
  events: readonly OperationalCaseEvent[];
  approvals: readonly CaseApproval[];
  work: readonly WorkItem[];
  authorityResolutions?: readonly AuthorityResolution[];
}): PortfolioCaseSnapshot[] {
  const byCase = <T extends { case_id: string | null }>(rows: readonly T[]) => {
    const grouped = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.case_id) continue;
      const list = grouped.get(row.case_id) ?? [];
      list.push(row);
      grouped.set(row.case_id, list);
    }
    return grouped;
  };
  const facts = byCase(input.facts);
  const subjects = byCase(input.subjects);
  const events = byCase(input.events);
  const approvals = byCase(input.approvals);
  const work = byCase(input.work);
  const resolutions = byCase(input.authorityResolutions ?? []);

  const snapshots: PortfolioCaseSnapshot[] = [];
  for (const row of input.cases) {
    if (row.organization_id !== input.organizationId) continue;
    const opCase = toPortfolioCase(row);
    if (!opCase) continue;

    const caseFacts = facts.get(row.id) ?? [];
    const caseLevel = newestByKey(caseFacts.filter((f) => !f.subject_id));
    const commitments: PortfolioCommitment[] = (subjects.get(row.id) ?? [])
      .filter((subject) => subject.subject_kind === "commitment")
      .map((subject) => {
        const own = newestByKey(caseFacts.filter((f) => f.subject_id === subject.id));
        return {
          subject_id: subject.id,
          label: subject.label,
          created_at: subject.created_at,
          status: own.get(COMMITMENT_FACT_KEYS.status) ?? null,
          actor: own.get(COMMITMENT_FACT_KEYS.actor) ?? null,
          due: own.get(COMMITMENT_FACT_KEYS.due) ?? null,
          expected_outcome: own.get(COMMITMENT_FACT_KEYS.expectedOutcome) ?? null,
        };
      });

    snapshots.push({
      case: opCase,
      closure: caseLevel.get(OPPORTUNITY_CLOSURE_FACT_KEY) ?? null,
      objective: caseLevel.get("opportunity.objective") ?? null,
      case_facts: [...caseLevel.values()],
      reconsiderations: reconsiderationsOf(events.get(row.id) ?? []),
      work: (work.get(row.id) ?? []).map(toWork),
      commitments,
      // Rule-only inputs: no Organization-Case producer in SL-7 (D4).
      approval_requests: [],
      approval_decisions: (approvals.get(row.id) ?? []).map((approval) => ({
        id: approval.id,
        approval_kind: approval.approval_kind,
        decision: approval.decision,
        decided_at: approval.decided_at,
        evidence_hash: approval.evidence_hash,
        superseded_by: approval.superseded_by,
      })),
      authority_conflict: latestAuthorityConflict(resolutions.get(row.id) ?? []),
      effect_operations: [],
    });
  }
  return snapshots;
}
