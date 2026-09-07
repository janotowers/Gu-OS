/**
 * Duplicate and supersession resolution — R1 SL-3.
 *
 * A canonicalization is **two governed operations, never one** (Slice Plan §4,
 * SA-3.1 / SA-3.4 / SA-3.11 / SA-3.12):
 *
 *   1. the typed **lineage edge**, written through the authorized
 *      `packages/db` relationship helper, which ADR-109 §4 forbids from
 *      touching either Case row;
 *   2. the **business closure** of the non-canonical Opportunity —
 *      `opportunity.closure` with outcome, reason, evidence and provenance —
 *      applied through the canonical `case_facts` mechanism (S1 §8.10, §8.16).
 *
 * Neither half is the other. An edge without closure leaves two ongoing
 * business responsibilities standing, which S1 §8.6 forbids; a closure without
 * an edge loses the traceable connection. **A half-completed pair is never
 * reported as a resolution** — this module returns `unresolved` and says which
 * half is missing, so the state left behind is explicitly recoverable rather
 * than silently wrong.
 *
 * What this module does NOT do, deliberately:
 *
 *  - **decide.** Whether two Opportunities represent one objective is semantic
 *    judgment that belongs to the model and its eval set. This executor
 *    consumes a determination that has already been made — by a human, or by
 *    an already-governed path — and turns it into durable, coherent truth
 *    (Methodology §13);
 *  - **invent a supersession trigger.** S1 approves `superseded` as an
 *    outcome and ADR-109 §7 leaves survivor/reconciliation algorithms
 *    downstream. SL-3 contracts what must be true *after* a governed
 *    determination, not when Gu should reach one;
 *  - **move data.** Human-reviewed merge/split is deferred post-R1 (S1 §17,
 *    TD-7). No path here copies, moves or deletes facts, commitments or
 *    evidence between Cases;
 *  - **assert a runtime transition.** S1 §8.7 keeps business closure and
 *    runtime status distinct.
 */
import { runWithAiUsageContext } from "@agents/agent";
import {
  createCaseRelationship,
  getOperationalCase,
  isRelationshipOpsEnabled,
  listCaseRelationships,
  narrateCaseRelationship,
  recordOpportunityClosure,
  findClosureForResolution,
  type DbClient,
} from "@agents/db";
import type { ContinuityJudge, ContinuityJudgeInput, ContinuityProposal } from "./continuity-judge";
import type {
  CaseRelationship,
  CaseRelationshipActorKind,
  CaseRelationshipType,
  OpportunityClosureFactValue,
  OpportunityClosureReason,
} from "@agents/types";
import { OPPORTUNITY_CLOSURE_REASONS } from "@agents/types";

/**
 * The two flows this Slice delivers, and nothing else.
 *
 * `transaction_association` and `split_from` are in the SL-0 registry but are
 * not resolutions: the first is a non-destructive business association that
 * supersedes nothing, the second belongs to the deferred split flow.
 */
export type ResolutionKind = "duplicate" | "supersession";

const RESOLUTION_SHAPE: Record<
  ResolutionKind,
  { edge: CaseRelationshipType; reason: OpportunityClosureReason }
> = {
  duplicate: {
    edge: "duplicate_of",
    reason: "same_objective_canonicalized",
  },
  supersession: {
    edge: "superseded_by",
    reason: "replaced_by_successor_opportunity",
  },
};

/**
 * A determination that has already been made, arriving from an authorized
 * actor or an already-governed path.
 *
 * Direction is fixed and uniform across both flows: `closingCaseId` is the
 * Case that stops carrying ongoing responsibility, `survivingCaseId` is the one
 * that keeps it. That maps onto the registry without the caller having to know
 * edge direction — `A duplicate_of B` and `A superseded_by B` both read
 * closing → surviving.
 */
export interface ResolutionRequest {
  organizationId: string;
  /** Case owner, as every `case_facts` write in this repo is user-scoped. */
  ownerUserId: string;
  kind: ResolutionKind;
  closingCaseId: string;
  survivingCaseId: string;
  determination: {
    actorKind: CaseRelationshipActorKind;
    actorUserId: string | null;
    /** The actor's own explanation. Explains; never classifies. */
    note?: string | null;
    /** Structured evidence refs, carried identically on edge and closure. */
    evidenceRefs?: Record<string, unknown>;
  };
}

export type ResolutionInertReason =
  | "relationship_ops_disabled"
  /** Both ids name the same Case — not a resolution, and structurally refused. */
  | "same_case"
  /** A Case is missing, or is not contained by the stated Organization. */
  | "case_not_in_organization";

/** Which governed half is still owed. */
export type ResolutionGap = "closure" | "narration";

export type ResolutionResult =
  | { status: "inert"; reason: ResolutionInertReason }
  | {
      status: "resolved";
      relationshipId: string;
      closureFactId: string;
      /** False only if a concurrent writer is mid-narration; retry converges. */
      narratedBothTimelines: boolean;
      /** False when this call converged onto an existing resolution. */
      firstCompletion: boolean;
    }
  | {
      status: "unresolved";
      /** Null when the edge itself could not be written. */
      relationshipId: string | null;
      missing: ResolutionGap;
      detail: string;
      /**
       * Always true. The incomplete state is left explicitly recoverable
       * rather than rolled back, so no history is deleted and a retry
       * converges on the same logical resolution (SA-3.12).
       */
      retryable: true;
    };

/**
 * Applies a governed duplicate or supersession determination.
 *
 * Ordering is load-bearing. The **edge first**, because it is the half that
 * carries identity: its id is the `source_ref` that makes the closure
 * idempotent, and SL-0's `uq_case_relationships_active_edge` already makes a
 * repeated determination converge on one active edge (SA-3.7). Closure second,
 * narration last — narration is the audit trail of a resolution, not one of its
 * two halves, so it never gates completion of what actually happened.
 */
export async function resolveCanonicalization(
  db: DbClient,
  request: ResolutionRequest
): Promise<ResolutionResult> {
  // ── 1. Flags. Off ⇒ inert, before anything is read or written (SA-3.9).
  if (!(await isRelationshipOpsEnabled(db, request.organizationId))) {
    return { status: "inert", reason: "relationship_ops_disabled" };
  }

  if (request.closingCaseId === request.survivingCaseId) {
    return { status: "inert", reason: "same_case" };
  }

  // ── 2. Tenancy, fail-closed and BEFORE any write (SA-3.8).
  //
  // The composite FKs on `case_relationships` make a cross-Organization edge
  // structurally impossible, so this check is not the only guard. It exists so
  // the refusal is a named business outcome rather than a foreign-key error,
  // and so a missing Case is distinguishable from a cross-tenant attempt only
  // by an operator reading the log — never by the caller getting further.
  for (const caseId of [request.closingCaseId, request.survivingCaseId]) {
    const row = await getOperationalCase(db, caseId);
    if (!row || row.organization_id !== request.organizationId) {
      return { status: "inert", reason: "case_not_in_organization" };
    }
  }

  const shape = RESOLUTION_SHAPE[request.kind];
  const evidenceRefs = request.determination.evidenceRefs ?? {};

  // ── 3. The lineage edge (ADR-109 §4: mutates neither Case row).
  const edge = await ensureLineageEdge(db, request, shape.edge, evidenceRefs);
  if (!edge.ok) {
    return {
      status: "unresolved",
      relationshipId: null,
      missing: "closure",
      detail: `lineage edge not written: ${edge.detail}`,
      retryable: true,
    };
  }
  const relationship = edge.relationship;

  // ── 4. The business closure of the closing Case.
  //
  // Recorded through the canonical `case_facts` mechanism, keyed to THIS edge,
  // so a retry converges rather than writing a second closure for one
  // determination (M-RESOLUTION-IDENTITY).
  const closureValue: OpportunityClosureFactValue = {
    outcome: OPPORTUNITY_CLOSURE_REASONS[shape.reason],
    reason: shape.reason,
    counterpart_case_id: request.survivingCaseId,
    actor_kind: request.determination.actorKind,
    actor_user_id: request.determination.actorUserId,
    evidence_refs: evidenceRefs,
    determination: request.determination.note ?? null,
  };

  let closureFactId: string;
  let firstCompletion: boolean;
  try {
    const closure = await recordOpportunityClosure(db, {
      userId: request.ownerUserId,
      caseId: request.closingCaseId,
      relationshipId: relationship.id,
      value: closureValue,
      sourceKind: request.determination.actorKind === "human" ? "user" : "derived",
    });
    closureFactId = closure.fact.id;
    firstCompletion = closure.inserted;
  } catch (error) {
    // The edge stands. That is not a lie — it records that a determination was
    // made — and it is not a completed resolution either, which is exactly what
    // is reported. Nothing is rolled back, so no history is destroyed, and the
    // pair is discoverable and retryable via `findIncompleteResolutions`.
    return {
      status: "unresolved",
      relationshipId: relationship.id,
      missing: "closure",
      detail: describeFailure(error),
      retryable: true,
    };
  }

  // ── 5. Narration on both timelines (SA-3.5).
  //
  // After completion, never before: a narration describing a resolution that
  // did not complete would be the audit trail lying. Failure here does not
  // un-resolve anything, so it is reported as a gap on a resolution that DID
  // happen.
  let narratedBothTimelines: boolean;
  try {
    await narrateCaseRelationship(db, { relationship, transition: "created" });
    narratedBothTimelines = true;
  } catch (error) {
    return {
      status: "unresolved",
      relationshipId: relationship.id,
      missing: "narration",
      detail: describeFailure(error),
      retryable: true,
    };
  }

  return {
    status: "resolved",
    relationshipId: relationship.id,
    closureFactId,
    narratedBothTimelines,
    firstCompletion,
  };
}

type EnsureEdgeResult =
  | { ok: true; relationship: CaseRelationship }
  | { ok: false; detail: string };

/** Postgres unique-violation: the active edge already exists. */
const UNIQUE_VIOLATION = "23505";

/**
 * The active edge for this determination, creating it if it is not there.
 *
 * A repeated determination must converge on ONE edge, and
 * `uq_case_relationships_active_edge` is what guarantees it — so the race is
 * resolved by the database and losing it is a normal outcome, not a fault. The
 * loser re-reads and continues with the winner's edge, which is the same
 * logical resolution.
 */
async function ensureLineageEdge(
  db: DbClient,
  request: ResolutionRequest,
  relationshipType: CaseRelationshipType,
  evidenceRefs: Record<string, unknown>
): Promise<EnsureEdgeResult> {
  try {
    const relationship = await createCaseRelationship(db, {
      organizationId: request.organizationId,
      fromCaseId: request.closingCaseId,
      toCaseId: request.survivingCaseId,
      relationshipType,
      createdByUserId: request.determination.actorUserId,
      actorKind: request.determination.actorKind,
      reason: request.determination.note ?? null,
      evidenceRefs,
      provenance: {
        slice: "SL-3",
        resolution_kind: request.kind,
        organization_id: request.organizationId,
      },
    });
    return { ok: true, relationship };
  } catch (error) {
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) {
      return { ok: false, detail: describeFailure(error) };
    }
  }

  const existing = (
    await listCaseRelationships(db, {
      organizationId: request.organizationId,
      caseId: request.closingCaseId,
    })
  ).find(
    (row) =>
      row.from_case_id === request.closingCaseId &&
      row.to_case_id === request.survivingCaseId &&
      row.relationship_type === relationshipType
  );

  return existing
    ? { ok: true, relationship: existing }
    : {
        ok: false,
        detail:
          "unique violation on the active edge, but no matching active edge is readable",
      };
}

/**
 * Resolutions whose edge exists but whose closure does not — the state SA-3.12
 * permits an implementation to leave behind, made discoverable so it can
 * actually be reconciled.
 *
 * Without this read, "explicitly unresolved and safely retryable" would be a
 * claim rather than a property: nothing would be able to find the half-done
 * pair again.
 */
export async function findIncompleteResolutions(
  db: DbClient,
  params: { organizationId: string; ownerUserId: string; caseId: string }
): Promise<Array<{ relationship: CaseRelationship; missing: ResolutionGap }>> {
  const edges = await listCaseRelationships(db, {
    organizationId: params.organizationId,
    caseId: params.caseId,
  });

  const incomplete: Array<{
    relationship: CaseRelationship;
    missing: ResolutionGap;
  }> = [];

  for (const edge of edges) {
    if (edge.relationship_type !== "duplicate_of" && edge.relationship_type !== "superseded_by") {
      continue;
    }
    // The closing Case is always the edge's `from` end, for both flows.
    if (edge.from_case_id !== params.caseId) continue;

    const closure = await findClosureForResolution(db, {
      userId: params.ownerUserId,
      caseId: edge.from_case_id,
      relationshipId: edge.id,
    });
    if (!closure) incomplete.push({ relationship: edge, missing: "closure" });
  }

  return incomplete;
}

/**
 * A readable failure string.
 *
 * PostgREST rejects with a plain `{ code, message }` object rather than an
 * Error, and `String(...)` on one yields "[object Object]" — a `detail` that
 * tells an operator nothing about why the resolution stalled.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const shaped = error as { code?: unknown; message?: unknown };
    const message =
      typeof shaped.message === "string" ? shaped.message : JSON.stringify(error);
    return typeof shaped.code === "string" ? `${shaped.code}: ${message}` : message;
  }
  return String(error);
}

/**
 * Asks the continuity judge whether two Opportunities share one objective,
 * with the model call correlated to the Organization that incurred it.
 *
 * This is the ONLY runtime path in this Slice that reaches a model, and it
 * deliberately returns a **proposal**, never a resolution. Nothing here writes
 * anything: turning a proposal into a governed determination is a separate
 * decision — by a human, or by an already-governed path — and
 * `resolveCanonicalization` is what consumes that determination.
 *
 * Why not wire it straight into the executor: SL-3 explicitly declines to
 * invent a trigger for when Gu should decide that two Opportunities are one.
 * ADR-109 §7 leaves survivor and reconciliation algorithms downstream, and no
 * approved source defines the trigger, so building one here would be inventing
 * product truth this Slice does not own.
 *
 * The correlation wrapper is the §2 baseline's correlation-coverage
 * requirement, which applies from SL-2 onward: `organizationId` is the only
 * dimension available, since the judgment precedes any Case-level work.
 * Callback-scoped rather than `bindAiUsageContext`, so this never leaves its
 * attribution behind in a caller's async context.
 */
export async function proposeContinuity(
  db: DbClient,
  params: {
    organizationId: string;
    userId: string;
    judge: ContinuityJudge;
    input: ContinuityJudgeInput;
  }
): Promise<ContinuityProposal | null> {
  if (!(await isRelationshipOpsEnabled(db, params.organizationId))) return null;
  return runWithAiUsageContext(
    {
      userId: params.userId,
      organizationId: params.organizationId,
      channel: "cron",
    },
    db,
    () => params.judge.judge(params.input)
  );
}
