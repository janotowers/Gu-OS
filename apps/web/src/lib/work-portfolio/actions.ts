/**
 * Work Portfolio actions — R1 SL-7, Slice Plan SA-7.8 and SA-7.9.
 *
 * Exactly two business actions are in scope, plus a person's own presentation
 * (Slice Plan SL-7, "Scope, ordering, exclusions and hand-offs"):
 *
 *   - **deciding an approval** — the SA-7.9 gate: owner / org_admin only,
 *     never granted by assignment (D3). Recorded through the CURRENT
 *     `case_approvals` write path, with actor and role persisted on the Case
 *     timeline (TD-1: consequential decisions persist actor + role);
 *   - **completing a Work Item that needs a human** — which is also how Gu's
 *     targeted question gets its answer. Through the Work Plane's OWN paths:
 *     readiness → claim by a `human` executor → completion, or the CURRENT
 *     review → done transition for Work already in review.
 *
 * Neither writes any Portfolio-only business state (S4 invariants 1 and 19;
 * AC-9 §14.1). Both are authorized by `authorizeOrgAction` BEFORE anything
 * about the Case is read, and both are inert while `relationship_ops` is off.
 *
 * Server-only: the Work Plane and approvals are service-role tables in R1.
 */
import {
  approveReviewedItem,
  authorizeOrgAction,
  claimNextReady,
  completeAttempt,
  getActiveMembership,
  getOperationalCase,
  insertCaseApproval,
  insertOperationalCaseEvent,
  isRelationshipOpsEnabled,
  listPortfolioSupervisorEvents,
  listPortfolioWorkItems,
  propagateReadiness,
  writePortfolioPresentationState,
  type DbClient,
  type OrgAuthorizationReason,
} from "@agents/db";
import type { OperationalCase, OrganizationMembership, WorkItem } from "@agents/types";
import { workReviewActionPresentation } from "../operations/work-view-labels";
import { awaitedHumanAsk, evaluateMustSurface } from "./must-surface";
import { presentationPatchFor, type PresentationChange } from "./presentation";
import { buildCaseSnapshots, type PortfolioApprovalRequest } from "./snapshot";

/** Where these actions record themselves as the surface that acted. */
export const WORK_PORTFOLIO_SURFACE = "web_portfolio";

/** `payload.kind` of the timeline event a Portfolio approval decision writes (TD-11). */
export const PORTFOLIO_APPROVAL_DECIDED_EVENT_KIND = "portfolio_approval_decided";

/** A human's claim on a Work Item lasts this long. An ordinary engineering value. */
const HUMAN_CLAIM_LEASE_MS = 5 * 60_000;

export type PortfolioRefusal =
  | Exclude<OrgAuthorizationReason, "active_member">
  | "case_not_in_organization"
  | "work_not_awaiting_human"
  | "work_resolved_by_domain_decision"
  | "work_not_claimable"
  | "answer_required"
  | "no_pending_request"
  | "already_decided"
  | "invalid_decision"
  | "invalid_change"
  | "claim_lost";

export type PortfolioActionResult =
  | { status: "done" }
  | { status: "inert"; reason: "relationship_ops_disabled" }
  | { status: "refused"; reason: PortfolioRefusal };

const refused = (reason: PortfolioRefusal): PortfolioActionResult => ({ status: "refused", reason });

/** A denied gate's reason. `active_member` only ever accompanies an allowed gate. */
const denial = (reason: OrgAuthorizationReason): PortfolioRefusal =>
  reason === "active_member" ? "no_active_membership" : reason;

const INERT: PortfolioActionResult = { status: "inert", reason: "relationship_ops_disabled" };

/**
 * Where a pending approval request is found.
 *
 * A seam, not a store: **no Organization-Case producer exists before SL-9**
 * (Slice Plan SL-7, D4), so the live source finds nothing and the action
 * decides nothing — in SL-7 the gate is exercised by deterministic tests only.
 * The request's evidence always comes from here, server-side; a decision is
 * never taken on evidence the browser supplied.
 */
export interface ApprovalRequestSource {
  find(caseId: string, requestId: string): Promise<PortfolioApprovalRequest | null>;
}

export const NO_APPROVAL_REQUEST_PRODUCER: ApprovalRequestSource = {
  async find() {
    return null;
  },
};

async function organizationCase(
  serviceDb: DbClient,
  organizationId: string,
  caseId: string
): Promise<OperationalCase | null> {
  const opCase = await getOperationalCase(serviceDb, caseId);
  return opCase && opCase.organization_id === organizationId ? opCase : null;
}

// ============================================================
// Deciding an approval — SA-7.9
// ============================================================

export async function decidePortfolioApproval(params: {
  serviceDb: DbClient;
  actorUserId: string;
  organizationId: string;
  caseId: string;
  requestId: string;
  decision: string;
  rationale: string | null;
  requests: ApprovalRequestSource;
  now: Date;
}): Promise<PortfolioActionResult> {
  const { serviceDb, actorUserId, organizationId, caseId } = params;
  const decision = params.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return refused("invalid_decision");
  }

  // D3, first: role in THIS Organization, now. Assignment is never consulted.
  const gate = await authorizeOrgAction(serviceDb, actorUserId, organizationId, "case_approval.decide");
  if (!gate.allowed || !gate.membership) return refused(denial(gate.reason));
  if (!(await isRelationshipOpsEnabled(serviceDb, organizationId))) return INERT;

  const opCase = await organizationCase(serviceDb, organizationId, caseId);
  if (!opCase) return refused("case_not_in_organization");

  const request = await params.requests.find(caseId, params.requestId);
  if (!request || request.withdrawn_at !== null || request.superseded_by !== null) {
    return refused("no_pending_request");
  }

  // One business resolution per request, from whichever surface got there
  // first (S4 §13, invariant 22). Read under the CURRENT table every surface
  // records decisions in.
  const { data: prior, error } = await serviceDb
    .from("case_approvals")
    .select("*")
    .eq("case_id", caseId)
    .eq("approval_kind", request.approval_kind)
    .eq("evidence_hash", request.evidence_hash);
  if (error) throw error;
  const decided = ((prior ?? []) as Array<{ decision: string; decided_at: string | null }>).some(
    (row) =>
      row.decision !== "suspended" &&
      (row.decided_at === null || Date.parse(row.decided_at) >= Date.parse(request.requested_at))
  );
  if (decided) return refused("already_decided");

  const { approval } = await insertCaseApproval(serviceDb, {
    userId: opCase.user_id,
    caseId,
    approvalKind: request.approval_kind,
    decision,
    evidenceHash: request.evidence_hash,
    evidenceSnapshot: request.evidence_snapshot,
    decidedBy: actorUserId,
    rationale: params.rationale?.trim() || null,
  });
  await insertOperationalCaseEvent(serviceDb, {
    caseId,
    eventType: "human_decision",
    actor: "user",
    payload: {
      kind: PORTFOLIO_APPROVAL_DECIDED_EVENT_KIND,
      v: 1,
      approval_id: approval.id,
      approval_kind: request.approval_kind,
      decision,
      request_id: request.request_id,
      actor_user_id: actorUserId,
      actor_role: gate.membership.role,
      membership_id: gate.membership.id,
      surface: WORK_PORTFOLIO_SURFACE,
    },
  });
  return { status: "done" };
}

// ============================================================
// Completing a Work Item that needs a human — SA-7.8
// ============================================================

function humanAnswer(membership: OrganizationMembership, text: string, now: Date) {
  return {
    text,
    answered_by: membership.user_id,
    answered_by_role: membership.role,
    membership_id: membership.id,
    surface: WORK_PORTFOLIO_SURFACE,
    answered_at: now.toISOString(),
  };
}

export async function completePortfolioWork(params: {
  serviceDb: DbClient;
  actorUserId: string;
  organizationId: string;
  caseId: string;
  workItemId: string;
  /** The human's contribution. Required when it answers Gu's question. */
  answer: string;
  now: Date;
}): Promise<PortfolioActionResult> {
  const { serviceDb, actorUserId, organizationId, caseId, workItemId, now } = params;

  // The existing Organization action vocabulary: any active member may write
  // an Organization Case. No new authority is minted for the Portfolio.
  const gate = await authorizeOrgAction(serviceDb, actorUserId, organizationId, "case.write");
  if (!gate.allowed || !gate.membership) return refused(denial(gate.reason));
  if (!(await isRelationshipOpsEnabled(serviceDb, organizationId))) return INERT;

  const opCase = await organizationCase(serviceDb, organizationId, caseId);
  if (!opCase) return refused("case_not_in_organization");

  // Only Work the projection itself shows as awaiting a human can be
  // completed here — the same rule, not a second one (SA-7.4, D4).
  const [events, workRows] = await Promise.all([
    listPortfolioSupervisorEvents(serviceDb, [caseId]),
    listPortfolioWorkItems(serviceDb, [caseId]),
  ]);
  const [snapshot] = buildCaseSnapshots({
    organizationId,
    cases: [opCase],
    facts: [],
    subjects: [],
    events,
    approvals: [],
    work: workRows,
  });
  const awaiting = evaluateMustSurface(snapshot, now).find(
    (item) =>
      item.predicate === "blocked_on_human" &&
      (item.interaction.interaction === "information_request" ||
        item.interaction.interaction === "human_work_request") &&
      item.interaction.work_item_id === workItemId
  );
  const row = workRows.find((w) => w.id === workItemId) as WorkItem | undefined;
  if (!awaiting || !row) return refused("work_not_awaiting_human");

  const text = params.answer.trim();
  const answersQuestion = awaitedHumanAsk(snapshot)?.openWork.some((w) => w.id === workItemId) ?? false;
  if (answersQuestion && text === "") return refused("answer_required");

  // The rows are keyed to the Case owner's profile (the CURRENT tenant key);
  // the person acting is recorded separately, never substituted for it.
  const tenantUserId = row.user_id;

  if (row.status === "review") {
    // The CURRENT Work Plane already separates review Work a person may simply
    // close from review Work that is a DOMAIN DECISION resolved by its own
    // handler (e.g. `verify_valuation` closes by approving or adjusting the
    // price). Closing the latter here would record the Work done without the
    // decision — and without that decision's own authorization — so the
    // Portfolio follows the same rule the operator view does.
    if (workReviewActionPresentation(row.work_type).kind === "domain_decision") {
      return refused("work_resolved_by_domain_decision");
    }
    const done = await approveReviewedItem(serviceDb, {
      userId: tenantUserId,
      itemId: row.id,
      resolvedBy: actorUserId,
      resolution: {
        source: "work_portfolio",
        decision: "completed",
        rationale: text || null,
      },
    });
    return done ? { status: "done" } : refused("claim_lost");
  }

  if (row.status === "todo") {
    const ready = await propagateReadiness(serviceDb, {
      userId: tenantUserId,
      caseId,
      workItemId: row.id,
    });
    if (!ready.readyIds.includes(row.id)) return refused("work_not_claimable");
  } else if (row.status !== "ready") {
    // `running`: an executor holds the claim; a human does not take it over.
    return refused("work_not_claimable");
  }

  const claimed = await claimNextReady(serviceDb, {
    userId: tenantUserId,
    caseId,
    workItemId: row.id,
    runnerRef: `work_portfolio:${actorUserId}`,
    executorKind: "human",
    leaseMs: HUMAN_CLAIM_LEASE_MS,
  });
  if (!claimed) return refused("work_not_claimable");

  const answer = humanAnswer(gate.membership, text, now);
  const completed = await completeAttempt(serviceDb, {
    userId: tenantUserId,
    attemptId: claimed.attempt.id,
    outcome: "succeeded",
    itemStatusOnSuccess: "done",
    resultJsonb: { human_answer: answer },
    evidenceJsonb: { human_answer: answer },
  });
  return completed.ok ? { status: "done" } : refused("claim_lost");
}

// ============================================================
// A person's own presentation — SA-7.5, SA-7.6
// ============================================================

/**
 * Writes this person's presentation of one Case with THEIR JWT, so "own rows,
 * active member only" is enforced by the database (M-PRESENTATION). Touches
 * `portfolio_presentation_state` and nothing else.
 */
export async function writePortfolioPresentation(params: {
  serviceDb: DbClient;
  userDb: DbClient;
  actorUserId: string;
  organizationId: string;
  caseId: string;
  change: PresentationChange;
  now: Date;
}): Promise<PortfolioActionResult> {
  const { serviceDb, userDb, actorUserId, organizationId, caseId } = params;
  let patch;
  try {
    patch = presentationPatchFor(params.change, params.now);
  } catch {
    return refused("invalid_change");
  }

  const membership = await getActiveMembership(serviceDb, organizationId, actorUserId);
  if (!membership) return refused("no_active_membership");
  if (!(await isRelationshipOpsEnabled(serviceDb, organizationId))) return INERT;
  if (!(await organizationCase(serviceDb, organizationId, caseId))) {
    return refused("case_not_in_organization");
  }

  await writePortfolioPresentationState(userDb, {
    userId: actorUserId,
    organizationId,
    caseId,
    patch,
  });
  return { status: "done" };
}
