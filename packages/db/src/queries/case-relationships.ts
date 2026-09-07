import type {
  CaseRelationship,
  CaseRelationshipActorKind,
  CaseRelationshipType,
} from "@agents/types";
import type { DbClient } from "../client";
import { insertOperationalCaseEvent } from "./operational-cases";

/**
 * Generic Case-to-Case relationships (ADR-109 / Technical Plan TD-7).
 *
 * ADR-109 §4: a relationship mutation NEVER touches either Case row. Nothing in
 * this module updates `operational_cases` — creating a `superseded_by` edge does
 * not close the superseded Case, and a `transaction_association` leaves the
 * Opportunity open alongside the Transaction. Lifecycle changes to a Case are a
 * separate, separately authorized decision.
 *
 * ADR-109 §9: edges are Organization-contained. The database enforces it with
 * composite foreign keys on both endpoints, so a cross-Organization edge cannot
 * be written even if a caller tries.
 *
 * ADR-109 §8: lineage mutations carry authority and evidence — actor, reason and
 * evidence references are recorded so the edge can be explained later.
 */

export async function createCaseRelationship(
  db: DbClient,
  params: {
    organizationId: string;
    fromCaseId: string;
    toCaseId: string;
    relationshipType: CaseRelationshipType;
    createdByUserId?: string | null;
    actorKind?: CaseRelationshipActorKind;
    reason?: string | null;
    evidenceRefs?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  }
): Promise<CaseRelationship> {
  if (params.fromCaseId === params.toCaseId) {
    throw new Error("createCaseRelationship: a Case cannot relate to itself");
  }
  const { data, error } = await db
    .from("case_relationships")
    .insert({
      organization_id: params.organizationId,
      from_case_id: params.fromCaseId,
      to_case_id: params.toCaseId,
      relationship_type: params.relationshipType,
      created_by_user_id: params.createdByUserId ?? null,
      actor_kind: params.actorKind ?? "human",
      reason: params.reason ?? null,
      evidence_refs_jsonb: params.evidenceRefs ?? {},
      provenance_jsonb: params.provenance ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as CaseRelationship;
}

/** Active edges where the Case is either endpoint. */
export async function listCaseRelationships(
  db: DbClient,
  params: {
    organizationId: string;
    caseId: string;
    includeEnded?: boolean;
  }
): Promise<CaseRelationship[]> {
  let query = db
    .from("case_relationships")
    .select("*")
    .eq("organization_id", params.organizationId)
    .or(`from_case_id.eq.${params.caseId},to_case_id.eq.${params.caseId}`);
  if (!params.includeEnded) query = query.eq("status", "active");
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CaseRelationship[];
}

/**
 * Ends an edge instead of deleting it, so lineage stays reconstructible: the
 * fact that two Cases were once considered duplicates is itself evidence.
 */
export async function endCaseRelationship(
  db: DbClient,
  params: {
    organizationId: string;
    relationshipId: string;
    reason?: string | null;
  }
): Promise<CaseRelationship> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("case_relationships")
    .update({
      status: "ended",
      ended_at: now,
      updated_at: now,
      ...(params.reason ? { reason: params.reason } : {}),
    })
    .eq("organization_id", params.organizationId)
    .eq("id", params.relationshipId)
    .eq("status", "active")
    .select("*")
    .single();
  if (error) throw error;
  return data as CaseRelationship;
}

/** Postgres unique-violation: this narration already exists. */
const UNIQUE_VIOLATION = "23505";

/**
 * Narrates a relationship on BOTH endpoints' timelines (TD-7; SA-3.5).
 *
 * Kept separate from `createCaseRelationship` on purpose. The edge write is
 * one operation with one failure mode; folding narration into it would hide a
 * partial failure inside what a caller reads as a single call, and SA-3.4 is
 * clearest when the pure edge write exists to be tested on its own.
 *
 * Idempotent by construction, not by checking first: M-RESOLUTION-IDENTITY's
 * partial unique index keeps one narration per (Case, edge), so a retry — which
 * SA-3.12's recoverable path makes a normal event — converges instead of
 * double-narrating. A read-then-write guard would prove nothing here, since two
 * workers can both observe "missing" before either writes.
 *
 * Two rows, one per Case: the same edge is narrated once on `from` and once on
 * `to`. Neither is the other's duplicate.
 *
 * `state_changed` is used because the CURRENT `operational_case_events`
 * `event_type` CHECK is a closed enum with no relationship member; extending it
 * is TD-11 evidence-gated work this Slice has no mandate to do. The specific
 * kind travels in the payload, as SL-2's admission narration does.
 */
export async function narrateCaseRelationship(
  db: DbClient,
  params: {
    relationship: CaseRelationship;
    /** What the narration is about: the edge appearing, or being ended. */
    transition?: "created" | "ended";
  }
): Promise<{ narratedCaseIds: string[] }> {
  const edge = params.relationship;
  const transition = params.transition ?? "created";
  const narrated: string[] = [];

  for (const [caseId, side] of [
    [edge.from_case_id, "from"],
    [edge.to_case_id, "to"],
  ] as const) {
    try {
      await insertOperationalCaseEvent(db, {
        caseId,
        eventType: "state_changed",
        actor: edge.actor_kind === "human" ? "user" : "system",
        payload: {
          kind: "case_relationship",
          relationship_id: edge.id,
          relationship_type: edge.relationship_type,
          transition,
          // Which end of the edge THIS Case is, so the timeline reads
          // correctly from either side without the reader inferring direction.
          side,
          counterpart_case_id:
            side === "from" ? edge.to_case_id : edge.from_case_id,
          actor_kind: edge.actor_kind,
          reason: edge.reason,
          evidence_refs: edge.evidence_refs_jsonb,
        },
      });
      narrated.push(caseId);
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      // Already narrated on this side. One logical event exists, which is the
      // whole requirement.
    }
  }

  return { narratedCaseIds: narrated };
}

/**
 * Whether both endpoints carry a narration for this edge (SA-3.5).
 *
 * The read that closes the loop: `narrateCaseRelationship` reports what IT
 * wrote, which is not the same question as what EXISTS after a retry.
 */
export async function isCaseRelationshipNarrated(
  db: DbClient,
  params: { relationship: CaseRelationship }
): Promise<boolean> {
  const edge = params.relationship;
  const { data, error } = await db
    .from("operational_case_events")
    .select("case_id, payload_jsonb")
    .in("case_id", [edge.from_case_id, edge.to_case_id]);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    case_id: string;
    payload_jsonb: Record<string, unknown> | null;
  }>;
  const narrated = new Set(
    rows
      .filter(
        (row) =>
          row.payload_jsonb?.kind === "case_relationship" &&
          row.payload_jsonb?.relationship_id === edge.id
      )
      .map((row) => row.case_id)
  );
  return narrated.has(edge.from_case_id) && narrated.has(edge.to_case_id);
}
