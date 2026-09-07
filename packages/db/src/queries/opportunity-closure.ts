/**
 * Business closure of an Opportunity — the canonical write path for the
 * `opportunity.closure` fact (S1 §8.10, §8.16; TD-8; Slice Plan SA-3.1/SA-3.11).
 *
 * This is the SECOND of the two governed operations a duplicate or supersession
 * resolution performs. The first is the lineage edge, written through
 * `case-relationships.ts`, which ADR-109 §4 forbids from touching either Case
 * row. That prohibition is exactly why closure needs its own operation: a
 * lineage edge alone would leave two ongoing business responsibilities standing,
 * which S1 §8.6 forbids.
 *
 * Two things this module deliberately does NOT do:
 *
 *  - **mutate the Case row.** Nothing here writes `operational_cases`. S1 §8.7
 *    keeps business closure and runtime status as separate dimensions, and no
 *    approved source requires recording `closure_outcome` to imply a runtime
 *    transition. SA-3.4's negative assertion depends on this staying true;
 *  - **decide.** Whether two Opportunities represent one objective is semantic
 *    judgment that belongs to the model and its eval. This module records a
 *    determination that has already been made, and enforces only that the
 *    record is internally coherent.
 */
import type {
  CaseFact,
  CaseFactSourceKind,
  OpportunityClosureFactValue,
} from "@agents/types";
import {
  OPPORTUNITY_CLOSURE_FACT_KEY,
  validateOpportunityClosure,
} from "@agents/types";
import type { DbClient } from "../client";
import {
  findCaseFactBySourceRef,
  insertCaseFact,
  listCaseFacts,
} from "./case-facts";

/**
 * `source_ref` for a closure written by a resolution.
 *
 * Naming the lineage edge is what gives the closure its identity: the
 * M-RESOLUTION-IDENTITY index makes one closure per (Case, fact_key, edge)
 * structural, so a retried resolution converges instead of writing a second
 * row. It also makes the two halves mutually explicable — from the closure you
 * can reach the edge, and from the edge you can find the closure it caused.
 */
export function closureSourceRef(relationshipId: string): string {
  return `case_relationships:${relationshipId}`;
}

export interface RecordOpportunityClosureInput {
  /** Case owner, as every `case_facts` write in this repo is user-scoped. */
  userId: string;
  caseId: string;
  /** The lineage edge this closure belongs to. */
  relationshipId: string;
  value: OpportunityClosureFactValue;
  /**
   * Provenance kind. Defaults to `derived`: a canonicalization determination
   * is a Gu OS conclusion drawn from evidence, not evidence itself. A caller
   * recording a human's own explicit determination may pass `user` so the
   * record does not present a person's decision as a system inference.
   */
  sourceKind?: CaseFactSourceKind;
  confidence?: number | null;
}

export interface RecordOpportunityClosureResult {
  fact: CaseFact;
  /** False when this resolution's closure was already recorded. */
  inserted: boolean;
  /**
   * The closure this one replaced, when the Case already carried a current
   * one — a correction, not a retry. Null on a first closure or a converged
   * retry. The replaced row is retained with `superseded_by` pointing here,
   * so nothing is discarded (S1 §8.6, §8.16).
   */
  superseded: CaseFact | null;
}

/** Structural incoherence in a closure determination — a fault, not a refusal. */
export class InvalidOpportunityClosure extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid opportunity closure: ${problems.join("; ")}`);
    this.name = "InvalidOpportunityClosure";
    this.problems = problems;
  }
}

/**
 * Records the business closure of an Opportunity, at most once per resolution.
 *
 * Coherence is checked before the write, not after: an `objective_achieved`
 * closure explained by `same_objective_canonicalized`, or a human
 * determination with no deciding user, would be a plausible-looking record of
 * something that did not happen. S1 §8.16 requires closing to leave
 * auditability, and an incoherent audit record is worse than none.
 *
 * WHY NOT `insertCaseFactOnce`, which is the other write-at-most-once helper:
 * that one deliberately **never displaces a current value it did not write**,
 * because a stale admission resuming late must not resurrect old truth. A
 * closure CORRECTION is the opposite case — a newer governed determination
 * that is meant to become current, with the earlier closure retained as
 * history. So this writes through `insertCaseFact`, whose supersession is
 * exactly that semantic, and gets its at-most-once guarantee from the
 * M-RESOLUTION-IDENTITY index instead: a retry of the SAME resolution
 * conflicts on `source_ref` and converges on the row that already exists,
 * while a DIFFERENT determination carries a different edge and supersedes.
 */
export async function recordOpportunityClosure(
  db: DbClient,
  input: RecordOpportunityClosureInput
): Promise<RecordOpportunityClosureResult> {
  const problems = validateOpportunityClosure(input.value);
  if (problems.length > 0) throw new InvalidOpportunityClosure(problems);

  if (input.value.counterpart_case_id === input.caseId) {
    throw new InvalidOpportunityClosure([
      "a Case cannot be its own closure counterpart",
    ]);
  }

  const sourceRef = closureSourceRef(input.relationshipId);

  try {
    const result = await insertCaseFact(db, {
      userId: input.userId,
      caseId: input.caseId,
      factKey: OPPORTUNITY_CLOSURE_FACT_KEY,
      value: input.value,
      sourceKind: input.sourceKind ?? "derived",
      sourceRef,
      confidence: input.confidence ?? null,
    });
    return {
      fact: result.fact,
      inserted: true,
      superseded: result.superseded,
    };
  } catch (error) {
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
  }

  // This resolution's closure is already recorded. Losing the race is a normal
  // outcome of a retry, not a fault: the caller continues with the row that
  // exists, which is the same logical closure it was about to write.
  const existing = await findCaseFactBySourceRef(db, {
    userId: input.userId,
    caseId: input.caseId,
    factKey: OPPORTUNITY_CLOSURE_FACT_KEY,
    sourceRef,
  });
  if (!existing) {
    throw new Error(
      "recordOpportunityClosure: unique violation on the closure, but no matching closure is readable"
    );
  }
  return { fact: existing, inserted: false, superseded: null };
}

/** Postgres unique-violation: this resolution's closure already exists. */
const UNIQUE_VIOLATION = "23505";

/**
 * The Case's current business closure, or `null` if it carries none.
 *
 * "Current" is the CURRENT `case_facts` meaning — the row not yet superseded —
 * so a corrected closure reads as the correction while the superseded row
 * stays reconstructible. A Case legitimately accumulates closure history; what
 * it never accumulates is two closures from one resolution.
 */
export async function getCurrentOpportunityClosure(
  db: DbClient,
  params: { userId: string; caseId: string }
): Promise<CaseFact | null> {
  const rows = await listCaseFacts(db, params.userId, params.caseId, {
    factKey: OPPORTUNITY_CLOSURE_FACT_KEY,
    limit: 1,
  });
  return rows[0] ?? null;
}

/**
 * The closure a specific resolution recorded, current or already superseded.
 *
 * This is the question SA-3.12's recovery path actually asks — "did MY half
 * complete?" — which is not the same as "does this Case have a closure". A
 * resolution whose closure was later corrected still completed.
 */
export async function findClosureForResolution(
  db: DbClient,
  params: { userId: string; caseId: string; relationshipId: string }
): Promise<CaseFact | null> {
  const rows = await listCaseFacts(db, params.userId, params.caseId, {
    factKey: OPPORTUNITY_CLOSURE_FACT_KEY,
    includeSuperseded: true,
  });
  const sourceRef = closureSourceRef(params.relationshipId);
  return rows.find((row) => row.source_ref === sourceRef) ?? null;
}

/**
 * Full closure history for a Case, newest first, including superseded rows.
 *
 * SA-3.2 and S1 §8.6 both turn on history never being silently discarded, so
 * the read that proves it has to exist.
 */
export async function listOpportunityClosureHistory(
  db: DbClient,
  params: { userId: string; caseId: string }
): Promise<CaseFact[]> {
  return listCaseFacts(db, params.userId, params.caseId, {
    factKey: OPPORTUNITY_CLOSURE_FACT_KEY,
    includeSuperseded: true,
  });
}
