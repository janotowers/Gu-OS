/**
 * Deterministic selftests for duplicate & supersession resolution — R1 SL-3.
 *
 * These cover the STRUCTURAL half of the Slice: everything Methodology §13
 * assigns to code and tests rather than to model judgment. Whether two
 * Opportunities represent one objective is not tested here — that is semantic,
 * and it belongs to the eval set with its stated bar.
 *
 * They run against the shared in-memory Supabase fake, which enforces the real
 * unique indexes and can fail a chosen write. That matters for SA-3.12: a
 * partial-completion test that hand-built the post-crash state would prove only
 * that the assertions agree with the fixture. Here the crash happens at a real
 * write, on the real code path.
 *
 * What the fake does NOT prove is PostgreSQL semantics — RLS, and the actual
 * concurrency of a partial unique index. Those live in `npm run test:rls`
 * against a real database, and the two suites are deliberately not merged.
 */
import assert from "node:assert/strict";
import {
  findClosureForResolution,
  getCurrentOpportunityClosure,
  isCaseRelationshipNarrated,
  listCaseRelationships,
  listOpportunityClosureHistory,
  narrateCaseRelationship,
  createCaseRelationship,
  recordOpportunityClosure,
  InvalidOpportunityClosure,
  closureSourceRef,
} from "@agents/db";
import {
  OPPORTUNITY_CLOSURE_FACT_KEY,
  OPPORTUNITY_CLOSURE_OUTCOMES,
  OPPORTUNITY_CLOSURE_REASON_LIST,
  closureReasonExplains,
  outcomeForClosureReason,
  validateOpportunityClosure,
  type OpportunityClosureFactValue,
} from "@agents/types";
import { createFakeDb, type FakeDb } from "../relationship-testing/fake-db";
import {
  findIncompleteResolutions,
  resolveCanonicalization,
  type ResolutionRequest,
} from "./resolve";

const PILOT_ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const ADVISOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_UID = "owner-uid-0000000000000001";

const CASE_A = "case-aaaa";
const CASE_B = "case-bbbb";
const CASE_FOREIGN = "case-ffff";

// ============================================================
// Harness
// ============================================================

function baseTables(
  overrides: { relationshipOps?: boolean } = {}
): Record<string, Record<string, unknown>[]> {
  return {
    organization_feature_flags: [
      {
        id: "flag-ops",
        organization_id: PILOT_ORG,
        flag_key: "relationship_ops",
        enabled: overrides.relationshipOps ?? true,
        value_text: null,
      },
    ],
    organization_memberships: [
      {
        id: "m1",
        organization_id: PILOT_ORG,
        user_id: ADVISOR,
        role: "advisor",
        status: "active",
      },
    ],
    operational_cases: [
      {
        id: CASE_A,
        organization_id: PILOT_ORG,
        user_id: OWNER_UID,
        case_type: "lead_opportunity",
        status: "active",
        runtime_authority: "legacy",
      },
      {
        id: CASE_B,
        organization_id: PILOT_ORG,
        user_id: OWNER_UID,
        case_type: "lead_opportunity",
        status: "active",
        runtime_authority: "legacy",
      },
      {
        id: CASE_FOREIGN,
        organization_id: OTHER_ORG,
        user_id: "someone-else",
        case_type: "lead_opportunity",
        status: "active",
        runtime_authority: "legacy",
      },
    ],
    case_relationships: [],
    case_facts: [],
    operational_case_events: [],
  };
}

function makeDb(
  overrides: {
    relationshipOps?: boolean;
    failWrite?: Array<{ table: string; occurrence?: number }>;
  } = {}
): FakeDb {
  return createFakeDb({
    tables: baseTables({ relationshipOps: overrides.relationshipOps }),
    failWrite: overrides.failWrite,
    uniqueIndexes: [
      // uq_case_relationships_active_edge (SL-0): one ACTIVE edge per ordered
      // pair and type. Already SA-3.7 before this Slice existed.
      {
        table: "case_relationships",
        columns: ["from_case_id", "to_case_id", "relationship_type"],
        where: (row) => row.status === "active",
      },
      // uq_case_facts_resolution_closure (M-RESOLUTION-IDENTITY): one closure
      // per (Case, fact key, edge).
      {
        table: "case_facts",
        columns: ["case_id", "fact_key", "source_ref"],
        where: (row) =>
          String(row.source_ref ?? "").startsWith("case_relationships:"),
      },
      // uq_operational_case_events_relationship: one narration per (Case, edge).
      {
        table: "operational_case_events",
        columns: ["case_id", "payload_jsonb->>relationship_id"],
        where: (row) =>
          (row.payload_jsonb as Record<string, unknown> | null)?.kind ===
          "case_relationship",
      },
    ],
    defaults: {
      case_relationships: {
        status: "active",
        ended_at: null,
        reason: null,
        evidence_refs_jsonb: {},
        provenance_jsonb: {},
        actor_kind: "human",
        created_by_user_id: null,
      },
      case_facts: {
        superseded_by: null,
        source_ref: null,
        confidence: null,
      },
      operational_case_events: { payload_jsonb: {} },
    },
  });
}

/** The fake exposes raw tables; this keeps the assertions readable. */
function rowsOf(db: FakeDb, table: string): Record<string, unknown>[] {
  return db.tables[table] ?? [];
}

function duplicateRequest(
  overrides: Partial<ResolutionRequest> = {}
): ResolutionRequest {
  return {
    organizationId: PILOT_ORG,
    ownerUserId: OWNER_UID,
    kind: "duplicate",
    closingCaseId: CASE_A,
    survivingCaseId: CASE_B,
    determination: {
      actorKind: "human",
      actorUserId: ADVISOR,
      note: "same property, same prospect, one objective",
      evidenceRefs: { conversation_ids: ["conv-1", "conv-2"] },
    },
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

const tests: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push([name, run]);
}

// ── Vocabulary (the newly owned in-Slice work) ──────────────

test("the closure outcome taxonomy is S1 §8.10's, unchanged", () => {
  assert.deepEqual(
    [...OPPORTUNITY_CLOSURE_OUTCOMES],
    ["objective_achieved", "lost", "invalid", "duplicate", "superseded"],
    "SL-3 settles the representation, never the approved product taxonomy"
  );
});

test("the reason registry is minimal — only what this Slice's flows need", () => {
  assert.deepEqual(
    [...OPPORTUNITY_CLOSURE_REASON_LIST].sort(),
    ["replaced_by_successor_opportunity", "same_objective_canonicalized"],
    "no broad final taxonomy of every future closure reason is invented"
  );
  assert.equal(
    outcomeForClosureReason("same_objective_canonicalized"),
    "duplicate"
  );
  assert.equal(
    outcomeForClosureReason("replaced_by_successor_opportunity"),
    "superseded"
  );
  assert.equal(outcomeForClosureReason("achieved_elsewhere"), null);
});

test("a reason cannot explain an outcome it is not registered for", () => {
  assert.equal(
    closureReasonExplains("duplicate", "same_objective_canonicalized"),
    true
  );
  assert.equal(
    closureReasonExplains("objective_achieved", "same_objective_canonicalized"),
    false,
    "a coherent-looking record of something that never happened"
  );
});

test("closure validation rejects incoherent determinations", () => {
  const base: OpportunityClosureFactValue = {
    outcome: "duplicate",
    reason: "same_objective_canonicalized",
    counterpart_case_id: CASE_B,
    actor_kind: "human",
    actor_user_id: ADVISOR,
    evidence_refs: {},
    determination: null,
  };
  assert.deepEqual(validateOpportunityClosure(base), []);

  assert.ok(
    validateOpportunityClosure({ ...base, outcome: "lost" }).some((p) =>
      p.includes("explains 'duplicate'")
    ),
    "mismatched outcome/reason must be named"
  );
  assert.ok(
    validateOpportunityClosure({ ...base, counterpart_case_id: null }).some((p) =>
      p.includes("requires a counterpart Case")
    ),
    "'this one is the duplicate' is incomplete without saying of what"
  );
  assert.ok(
    validateOpportunityClosure({ ...base, actor_user_id: null }).some((p) =>
      p.includes("deciding user")
    ),
    "a human determination must be attributable to a person"
  );
});

// ── SA-3.9 / flags ──────────────────────────────────────────

test("SA-3.9 with relationship_ops off, no resolution occurs", async () => {
  const db = makeDb({ relationshipOps: false });
  const result = await resolveCanonicalization(db.client, duplicateRequest());
  assert.equal(result.status, "inert");
  assert.equal(
    result.status === "inert" ? result.reason : null,
    "relationship_ops_disabled"
  );
  assert.equal(rowsOf(db, "case_relationships").length, 0);
  assert.equal(rowsOf(db, "case_facts").length, 0);
  assert.equal(rowsOf(db, "operational_case_events").length, 0);
});

// ── SA-3.8 / tenancy ────────────────────────────────────────

test("SA-3.8 a relationship cannot span Organizations", async () => {
  const db = makeDb();
  const result = await resolveCanonicalization(
    db.client,
    duplicateRequest({ survivingCaseId: CASE_FOREIGN })
  );
  assert.equal(result.status, "inert");
  assert.equal(
    result.status === "inert" ? result.reason : null,
    "case_not_in_organization"
  );
  assert.equal(
    rowsOf(db, "case_relationships").length,
    0,
    "refused before any write, not after"
  );
});

test("a Case cannot be resolved against itself", async () => {
  const db = makeDb();
  const result = await resolveCanonicalization(
    db.client,
    duplicateRequest({ survivingCaseId: CASE_A })
  );
  assert.equal(result.status, "inert");
  assert.equal(result.status === "inert" ? result.reason : null, "same_case");
});

// ── SA-3.1 / the duplicate flow, end to end ─────────────────

test("SA-3.1 a duplicate resolution produces one canonical responsibility", async () => {
  const db = makeDb();
  const result = await resolveCanonicalization(db.client, duplicateRequest());
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;

  const edges = rowsOf(db, "case_relationships");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].relationship_type, "duplicate_of");
  assert.equal(edges[0].from_case_id, CASE_A, "the closing Case is the `from` end");
  assert.equal(edges[0].to_case_id, CASE_B);
  assert.equal(edges[0].status, "active");

  const closure = await getCurrentOpportunityClosure(db.client, {
    userId: OWNER_UID,
    caseId: CASE_A,
  });
  assert.ok(closure, "the non-canonical Opportunity records a business closure");
  const value = closure.value_jsonb as OpportunityClosureFactValue;
  assert.equal(value.outcome, "duplicate");
  assert.equal(value.reason, "same_objective_canonicalized");
  assert.equal(value.counterpart_case_id, CASE_B);
  assert.equal(value.actor_kind, "human");
  assert.equal(value.actor_user_id, ADVISOR);
  assert.deepEqual(value.evidence_refs, {
    conversation_ids: ["conv-1", "conv-2"],
  });
  assert.equal(
    closure.source_ref,
    closureSourceRef(String(edges[0].id)),
    "the closure names the edge that caused it"
  );

  const survivorClosure = await getCurrentOpportunityClosure(db.client, {
    userId: OWNER_UID,
    caseId: CASE_B,
  });
  assert.equal(survivorClosure, null, "the canonical Case is not closed");
});

// ── SA-3.11 / the supersession flow ─────────────────────────

test("SA-3.11 a supersession produces a directed edge and a `superseded` closure", async () => {
  const db = makeDb();
  const result = await resolveCanonicalization(
    db.client,
    duplicateRequest({
      kind: "supersession",
      determination: {
        actorKind: "agent",
        actorUserId: null,
        note: "responsibility moved to the successor Opportunity",
        evidenceRefs: { determination_ref: "gov-1" },
      },
    })
  );
  assert.equal(result.status, "resolved");

  const edge = rowsOf(db, "case_relationships")[0];
  assert.equal(edge.relationship_type, "superseded_by");
  assert.equal(edge.from_case_id, CASE_A, "the replaced Case is the `from` end");
  assert.equal(edge.to_case_id, CASE_B);

  const closure = await getCurrentOpportunityClosure(db.client, {
    userId: OWNER_UID,
    caseId: CASE_A,
  });
  const value = closure?.value_jsonb as OpportunityClosureFactValue;
  assert.equal(value.outcome, "superseded");
  assert.equal(value.reason, "replaced_by_successor_opportunity");
  assert.equal(
    closure?.source_kind,
    "derived",
    "an agent determination is a Gu OS conclusion, not a user-supplied fact"
  );
});

// ── SA-3.4 / relationships never mutate a Case row ──────────

test("SA-3.4 a relationship write alone mutates neither Case row", async () => {
  const db = makeDb();
  const before = rowsOf(db, "operational_cases").map((row) => ({ ...row }));

  await createCaseRelationship(db.client, {
    organizationId: PILOT_ORG,
    fromCaseId: CASE_A,
    toCaseId: CASE_B,
    relationshipType: "duplicate_of",
    actorKind: "human",
    createdByUserId: ADVISOR,
  });

  assert.deepEqual(
    rowsOf(db, "operational_cases"),
    before,
    "no close, pause, reactivate, ownership transfer or progression change"
  );
  assert.equal(
    rowsOf(db, "case_facts").length,
    0,
    "and no closure truth appears from a lineage write alone"
  );
});

test("SA-3.4 a full resolution still leaves both Case rows untouched", async () => {
  const db = makeDb();
  const before = rowsOf(db, "operational_cases").map((row) => ({ ...row }));
  await resolveCanonicalization(db.client, duplicateRequest());
  assert.deepEqual(
    rowsOf(db, "operational_cases"),
    before,
    "business closure is a fact, never a runtime transition (S1 §8.7)"
  );
});

// ── SA-3.5 / narration on both timelines ────────────────────

test("SA-3.5 a relationship event is appended to BOTH timelines", async () => {
  const db = makeDb();
  const result = await resolveCanonicalization(db.client, duplicateRequest());
  assert.equal(result.status, "resolved");

  const events = rowsOf(db, "operational_case_events")
    .filter(
      (row) =>
        (row.payload_jsonb as Record<string, unknown>).kind ===
        "case_relationship"
    );
  assert.equal(events.length, 2, "one per Case, not one per edge");
  assert.deepEqual(
    events.map((row) => row.case_id).sort(),
    [CASE_A, CASE_B].sort()
  );

  const sides = new Map(
    events.map((row) => [
      row.case_id,
      row.payload_jsonb as Record<string, unknown>,
    ])
  );
  assert.equal(sides.get(CASE_A)?.side, "from");
  assert.equal(sides.get(CASE_A)?.counterpart_case_id, CASE_B);
  assert.equal(sides.get(CASE_B)?.side, "to");
  assert.equal(
    sides.get(CASE_B)?.counterpart_case_id,
    CASE_A,
    "each timeline reads correctly from its own side"
  );

  const edge = rowsOf(db, "case_relationships")[0];
  assert.equal(
    await isCaseRelationshipNarrated(db.client, {
      relationship: edge as never,
    }),
    true
  );
});

test("SA-3.5 narration is idempotent — a retry does not double-narrate", async () => {
  const db = makeDb();
  await resolveCanonicalization(db.client, duplicateRequest());
  const edge = rowsOf(db, "case_relationships")[0];

  const second = await narrateCaseRelationship(db.client, {
    relationship: edge as never,
  });
  assert.deepEqual(
    second.narratedCaseIds,
    [],
    "the unique index absorbed both sides; losing the race is a normal outcome"
  );
  assert.equal(
    rowsOf(db, "operational_case_events")
      .filter(
        (row) =>
          (row.payload_jsonb as Record<string, unknown>).kind ===
          "case_relationship"
      ).length,
    2
  );
});

// ── SA-3.7 / repeated resolution converges ──────────────────

test("SA-3.7 repeated resolution yields one active edge and one closure", async () => {
  const db = makeDb();
  const first = await resolveCanonicalization(db.client, duplicateRequest());
  const second = await resolveCanonicalization(db.client, duplicateRequest());

  assert.equal(first.status, "resolved");
  assert.equal(second.status, "resolved");
  if (first.status !== "resolved" || second.status !== "resolved") return;

  assert.equal(first.relationshipId, second.relationshipId, "one logical edge");
  assert.equal(first.closureFactId, second.closureFactId, "one logical closure");
  assert.equal(first.firstCompletion, true);
  assert.equal(
    second.firstCompletion,
    false,
    "the second call converged rather than resolving again"
  );

  assert.equal(rowsOf(db, "case_relationships").length, 1);
  assert.equal(
    rowsOf(db, "case_facts").filter((r) => r.fact_key === OPPORTUNITY_CLOSURE_FACT_KEY)
      .length,
    1
  );
});

// ── SA-3.2 / SA-3.6 / history survives ──────────────────────

test("SA-3.2 no Case is deleted and no history is discarded", async () => {
  const db = makeDb();
  await resolveCanonicalization(db.client, duplicateRequest());

  assert.equal(
    rowsOf(db, "operational_cases").length,
    3,
    "both resolved Cases still exist, alongside the foreign one"
  );
  const history = await listOpportunityClosureHistory(db.client, {
    userId: OWNER_UID,
    caseId: CASE_A,
  });
  assert.equal(history.length, 1);
  assert.equal(
    rowsOf(db, "case_relationships")[0].status,
    "active",
    "edges are ended, never deleted — and this one is not even ended"
  );
});

test("SA-3.6 a corrective closure supersedes without discarding the first", async () => {
  const db = makeDb();
  await resolveCanonicalization(db.client, duplicateRequest());

  // A second, DIFFERENT determination on the same Case — a correction, not a
  // retry, so it carries its own edge and its own source_ref.
  const correctionEdge = await createCaseRelationship(db.client, {
    organizationId: PILOT_ORG,
    fromCaseId: CASE_A,
    toCaseId: CASE_B,
    relationshipType: "superseded_by",
    actorKind: "human",
    createdByUserId: ADVISOR,
  });
  await recordOpportunityClosure(db.client, {
    userId: OWNER_UID,
    caseId: CASE_A,
    relationshipId: correctionEdge.id,
    value: {
      outcome: "superseded",
      reason: "replaced_by_successor_opportunity",
      counterpart_case_id: CASE_B,
      actor_kind: "human",
      actor_user_id: ADVISOR,
      evidence_refs: {},
      determination: "reclassified after review",
    },
  });

  const history = await listOpportunityClosureHistory(db.client, {
    userId: OWNER_UID,
    caseId: CASE_A,
  });
  assert.equal(history.length, 2, "the earlier closure is retained as history");
  const current = await getCurrentOpportunityClosure(db.client, {
    userId: OWNER_UID,
    caseId: CASE_A,
  });
  assert.equal(
    (current?.value_jsonb as OpportunityClosureFactValue).outcome,
    "superseded",
    "the correction is current"
  );
  assert.ok(
    history.some((row) => row.superseded_by !== null),
    "and the superseded row points at what replaced it"
  );
});

// ── SA-3.3 / lineage queryable from either Case ─────────────

test("SA-3.3 lineage is queryable from EITHER Case, as structured data", async () => {
  const db = makeDb();
  await resolveCanonicalization(db.client, duplicateRequest());

  for (const caseId of [CASE_A, CASE_B]) {
    const edges = await listCaseRelationships(db.client, {
      organizationId: PILOT_ORG,
      caseId,
    });
    assert.equal(edges.length, 1, `lineage readable from ${caseId}`);
    const edge = edges[0];
    assert.equal(edge.relationship_type, "duplicate_of");
    assert.equal(edge.status, "active");
    assert.equal(edge.actor_kind, "human");
    assert.equal(edge.created_by_user_id, ADVISOR);
    assert.deepEqual(edge.evidence_refs_jsonb, {
      conversation_ids: ["conv-1", "conv-2"],
    });
    assert.equal(
      (edge.provenance_jsonb as Record<string, unknown>).slice,
      "SL-3",
      "provenance retrievable without parsing free text"
    );
  }
});

// ── SA-3.10 / merge & split are NOT delivered ───────────────

test("SA-3.10 no code path performs merge/split data movement", async () => {
  const db = makeDb();
  rowsOf(db, "case_facts").push({
    id: "fact-on-a",
    case_id: CASE_A,
    user_id: OWNER_UID,
    fact_key: "opportunity.objective",
    value_jsonb: { text: "buy a house" },
    source_kind: "derived",
    source_ref: null,
    superseded_by: null,
    recorded_at: new Date().toISOString(),
  });

  await resolveCanonicalization(db.client, duplicateRequest());

  const onSurvivor = rowsOf(db, "case_facts")
    .filter(
      (row) =>
        row.case_id === CASE_B && row.fact_key === "opportunity.objective"
    );
  assert.equal(
    onSurvivor.length,
    0,
    "resolution relates and closes; it never copies facts between Cases"
  );
  const stillOnA = rowsOf(db, "case_facts")
    .filter(
      (row) =>
        row.case_id === CASE_A && row.fact_key === "opportunity.objective"
    );
  assert.equal(stillOnA.length, 1, "and it never moves them away either");
});

// ── SA-3.12 / partial completion is never a resolution ──────

test("SA-3.12 a failed closure after a written edge is NOT reported resolved", async () => {
  // The crash happens at the real closure write, on the real path.
  const db = makeDb({ failWrite: [{ table: "case_facts", occurrence: 1 }] });
  const result = await resolveCanonicalization(db.client, duplicateRequest());

  assert.equal(result.status, "unresolved");
  if (result.status !== "unresolved") return;
  assert.equal(result.missing, "closure");
  assert.equal(result.retryable, true);
  assert.ok(result.relationshipId, "the edge that WAS written is named");

  assert.equal(rowsOf(db, "case_relationships").length, 1, "history is not deleted");
  assert.equal(
    rowsOf(db, "case_facts").length,
    0,
    "and no closure truth was invented"
  );
  assert.equal(
    rowsOf(db, "operational_case_events")
      .filter(
        (row) =>
          (row.payload_jsonb as Record<string, unknown>).kind ===
          "case_relationship"
      ).length,
    0,
    "the audit trail does not narrate a resolution that did not complete"
  );
});

test("SA-3.12 the incomplete state is discoverable and safely retryable", async () => {
  const db = makeDb({ failWrite: [{ table: "case_facts", occurrence: 1 }] });
  const failed = await resolveCanonicalization(db.client, duplicateRequest());
  assert.equal(failed.status, "unresolved");

  const incomplete = await findIncompleteResolutions(db.client, {
    organizationId: PILOT_ORG,
    ownerUserId: OWNER_UID,
    caseId: CASE_A,
  });
  assert.equal(incomplete.length, 1, "the half-done pair can be found again");
  assert.equal(incomplete[0].missing, "closure");

  // Retry converges on the SAME logical resolution rather than duplicating it.
  const retried = await resolveCanonicalization(db.client, duplicateRequest());
  assert.equal(retried.status, "resolved");
  if (retried.status !== "resolved") return;
  assert.equal(
    retried.relationshipId,
    failed.status === "unresolved" ? failed.relationshipId : null,
    "the same edge, not a second one"
  );
  assert.equal(rowsOf(db, "case_relationships").length, 1);
  assert.equal(
    rowsOf(db, "case_facts").filter((r) => r.fact_key === OPPORTUNITY_CLOSURE_FACT_KEY)
      .length,
    1
  );

  assert.deepEqual(
    await findIncompleteResolutions(db.client, {
      organizationId: PILOT_ORG,
      ownerUserId: OWNER_UID,
      caseId: CASE_A,
    }),
    [],
    "and nothing is left unresolved afterwards"
  );
});

test("SA-3.12 a failed narration reports a gap, not a false success", async () => {
  const db = makeDb({ failWrite: [{ table: "operational_case_events", occurrence: 1 }] });
  const result = await resolveCanonicalization(db.client, duplicateRequest());

  assert.equal(result.status, "unresolved");
  if (result.status !== "unresolved") return;
  assert.equal(result.missing, "narration");
  assert.equal(
    rowsOf(db, "case_facts").filter((r) => r.fact_key === OPPORTUNITY_CLOSURE_FACT_KEY)
      .length,
    1,
    "the two governed halves DID complete; only the audit trail is owed"
  );

  const retried = await resolveCanonicalization(db.client, duplicateRequest());
  assert.equal(retried.status, "resolved");
  assert.equal(
    rowsOf(db, "operational_case_events")
      .filter(
        (row) =>
          (row.payload_jsonb as Record<string, unknown>).kind ===
          "case_relationship"
      ).length,
    2,
    "and the retry completes the narration on both sides exactly once"
  );
});

test("SA-3.12 a failed EDGE write leaves nothing at all behind", async () => {
  const db = makeDb({ failWrite: [{ table: "case_relationships", occurrence: 1 }] });
  const result = await resolveCanonicalization(db.client, duplicateRequest());

  assert.equal(result.status, "unresolved");
  if (result.status !== "unresolved") return;
  assert.equal(result.relationshipId, null);
  assert.equal(rowsOf(db, "case_relationships").length, 0);
  assert.equal(rowsOf(db, "case_facts").length, 0);
});

// ── Closure write guards ────────────────────────────────────

test("a closure cannot name its own Case as the counterpart", async () => {
  const db = makeDb();
  await assert.rejects(
    () =>
      recordOpportunityClosure(db.client, {
        userId: OWNER_UID,
        caseId: CASE_A,
        relationshipId: "edge-1",
        value: {
          outcome: "duplicate",
          reason: "same_objective_canonicalized",
          counterpart_case_id: CASE_A,
          actor_kind: "human",
          actor_user_id: ADVISOR,
          evidence_refs: {},
          determination: null,
        },
      }),
    InvalidOpportunityClosure
  );
  assert.equal(rowsOf(db, "case_facts").length, 0);
});

test("findClosureForResolution answers 'did MY half complete', not 'is it closed'", async () => {
  const db = makeDb();
  const result = await resolveCanonicalization(db.client, duplicateRequest());
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;

  assert.ok(
    await findClosureForResolution(db.client, {
      userId: OWNER_UID,
      caseId: CASE_A,
      relationshipId: result.relationshipId,
    })
  );
  assert.equal(
    await findClosureForResolution(db.client, {
      userId: OWNER_UID,
      caseId: CASE_A,
      relationshipId: "some-other-edge",
    }),
    null,
    "a different resolution's closure is not this one's"
  );
});

// ============================================================

async function main(): Promise<void> {
  let passed = 0;
  for (const [name, run] of tests) {
    await run();
    console.log(`  ok  ${name}`);
    passed += 1;
  }
  console.log(`relationship-resolution selftest: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
