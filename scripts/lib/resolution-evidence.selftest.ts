// Selftests for the SL-3 hosted-evidence evaluator.
//
// The hosted run cannot be tested without a hosted environment, so its pass/fail
// logic lives in a pure module and is tested here. What these prove is the
// property SL-2's review established and this Slice inherits: an assertion must
// FAIL when the thing it names is untrue, and must not fail for unrelated
// reasons. A hosted evidence file whose checks cannot fail is decoration.
//
// The negative cases are chosen from SL-3's own risk table:
//   * a deleted Case, and a rewritten fact value — the EC-06 anti-pattern;
//   * two ongoing responsibilities, or a closure on the WRONG side — the S1
//     §8.6 failure AC-15 exists to catch;
//   * a moved Case-row column — the ADR-109 §4 prohibition;
//   * a narration on only one timeline;
//   * a second edge or a second closure after a retry;
//   * a resolution reported complete with a half missing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  allPassed,
  closureSourceRefFor,
  evaluateHostedResolutionEvidence,
  type HostedCaseRow,
  type HostedCheck,
  type HostedFactRow,
  type HostedRelationshipRow,
  type HostedResolutionInputs,
  type HostedSide,
  type HostedTimelineRow,
} from "./resolution-evidence";

const ORG = "11111111-1111-1111-1111-111111111111";
const CLOSING = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SURVIVING = "55555555-5555-5555-5555-555555555555";
const EDGE = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CLOSURE_FACT = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const OWNER = "22222222-2222-2222-2222-222222222222";
const CONFLICT_KEY = "opportunity.objective";

const redact = (value: string | null): string | null =>
  value ? `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}` : null;

function caseRow(id: string, overrides: Partial<HostedCaseRow> = {}): HostedCaseRow {
  return {
    id,
    user_id: OWNER,
    organization_id: ORG,
    case_type: "lead_opportunity",
    status: "active",
    current_step: null,
    next_action_at: null,
    due_at: null,
    runtime_authority: "legacy",
    assigned_to_user_id: OWNER,
    workflow_definition_id: null,
    version: 0,
    updated_at: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function fact(
  id: string,
  caseId: string,
  factKey: string,
  value: unknown,
  overrides: Partial<HostedFactRow> = {}
): HostedFactRow {
  return {
    id,
    case_id: caseId,
    fact_key: factKey,
    source_kind: "derived",
    source_ref: null,
    value_jsonb: value,
    superseded_by: null,
    ...overrides,
  };
}

function edgeRow(overrides: Partial<HostedRelationshipRow> = {}): HostedRelationshipRow {
  return {
    id: EDGE,
    organization_id: ORG,
    from_case_id: CLOSING,
    to_case_id: SURVIVING,
    relationship_type: "duplicate_of",
    status: "active",
    actor_kind: "human",
    created_by_user_id: OWNER,
    reason: "same underlying objective, canonicalized onto the surviving Opportunity",
    evidence_refs_jsonb: { scenario: "ec06-ac15" },
    provenance_jsonb: { slice: "SL-3" },
    ended_at: null,
    ...overrides,
  };
}

function narration(caseId: string, side: "from" | "to"): HostedTimelineRow {
  return {
    case_id: caseId,
    payload_jsonb: {
      kind: "case_relationship",
      relationship_id: EDGE,
      relationship_type: "duplicate_of",
      transition: "created",
      side,
      counterpart_case_id: side === "from" ? SURVIVING : CLOSING,
    },
  };
}

function closureFact(overrides: Partial<HostedFactRow> = {}): HostedFactRow {
  return fact(
    CLOSURE_FACT,
    CLOSING,
    "opportunity.closure",
    {
      outcome: "duplicate",
      reason: "same_objective_canonicalized",
      counterpart_case_id: SURVIVING,
      actor_kind: "human",
      actor_user_id: OWNER,
      evidence_refs: { scenario: "ec06-ac15" },
      determination: "controlled T8 scenario",
    },
    { source_kind: "user", source_ref: closureSourceRefFor(EDGE), ...overrides }
  );
}

const CLOSING_OBJECTIVE = fact("fact-closing-1", CLOSING, CONFLICT_KEY, {
  objective: "casa 3 recamaras, presupuesto 4.2M",
  category: "purchase",
});
const SURVIVING_OBJECTIVE = fact("fact-surviving-1", SURVIVING, CONFLICT_KEY, {
  objective: "casa 3 recamaras, presupuesto 5.0M",
  category: "purchase",
});

function side(params: {
  caseRow: HostedCaseRow | null;
  facts: HostedFactRow[];
  timeline?: HostedTimelineRow[];
  relationships?: HostedRelationshipRow[];
}): HostedSide {
  return {
    case: params.caseRow,
    facts: params.facts,
    timeline: params.timeline ?? [],
    relationships: params.relationships ?? [],
  };
}

/** A complete, correct duplicate resolution. Every negative test mutates this. */
function happyPath(): HostedResolutionInputs {
  const afterClosing = side({
    caseRow: caseRow(CLOSING),
    facts: [CLOSING_OBJECTIVE, closureFact()],
    timeline: [narration(CLOSING, "from")],
    relationships: [edgeRow()],
  });
  const afterSurviving = side({
    caseRow: caseRow(SURVIVING),
    facts: [SURVIVING_OBJECTIVE],
    timeline: [narration(SURVIVING, "to")],
    relationships: [edgeRow()],
  });
  return {
    kind: "duplicate",
    organizationId: ORG,
    closingCaseId: CLOSING,
    survivingCaseId: SURVIVING,
    conflictingFactKey: CONFLICT_KEY,
    before: {
      closing: side({ caseRow: caseRow(CLOSING), facts: [CLOSING_OBJECTIVE] }),
      surviving: side({ caseRow: caseRow(SURVIVING), facts: [SURVIVING_OBJECTIVE] }),
    },
    after: { closing: afterClosing, surviving: afterSurviving },
    result: {
      status: "resolved",
      relationshipId: EDGE,
      closureFactId: CLOSURE_FACT,
      narratedBothTimelines: true,
      firstCompletion: true,
    },
    repeat: {
      status: "resolved",
      relationshipId: EDGE,
      closureFactId: CLOSURE_FACT,
      narratedBothTimelines: true,
      firstCompletion: false,
    },
    afterRepeat: { closing: afterClosing, surviving: afterSurviving },
    incompleteAfter: [],
    redact,
  };
}

function failing(checks: HostedCheck[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => `${check.assertion}:${check.label}`);
}

function assertOnlyFailure(checks: HostedCheck[], assertion: string, hint: string): void {
  const failed = checks.filter((check) => !check.ok);
  assert.ok(
    failed.length > 0,
    `expected ${assertion} to fail (${hint}), but every check passed`
  );
  assert.ok(
    failed.some((check) => check.assertion === assertion),
    `expected a ${assertion} failure (${hint}); got ${failing(checks).join(" | ")}`
  );
}

// ── Positive control ────────────────────────────────────────────────────────

function testHappyPathPasses(): void {
  const checks = evaluateHostedResolutionEvidence(happyPath());
  assert.ok(allPassed(checks), `expected all checks to pass; failed: ${failing(checks).join(" | ")}`);
  assert.ok(checks.length >= 15, `expected a substantive check set, got ${checks.length}`);
}

// ── EC-06: preserve both, relate with traceability, never delete ────────────

function testDeletedCaseFails(): void {
  const inputs = happyPath();
  inputs.after.closing = side({ caseRow: null, facts: [] });
  assertOnlyFailure(evaluateHostedResolutionEvidence(inputs), "EC-06", "a Case was deleted");
}

function testDiscardedHistoryFails(): void {
  const inputs = happyPath();
  // The closing Case's own objective fact is gone after resolution.
  inputs.after.closing = side({
    caseRow: caseRow(CLOSING),
    facts: [closureFact()],
    timeline: [narration(CLOSING, "from")],
    relationships: [edgeRow()],
  });
  assertOnlyFailure(evaluateHostedResolutionEvidence(inputs), "EC-06", "a fact row disappeared");
}

function testRewrittenHistoryFails(): void {
  const inputs = happyPath();
  const rewritten = fact("fact-closing-1", CLOSING, CONFLICT_KEY, {
    objective: "reconciled onto the surviving budget",
    category: "purchase",
  });
  inputs.after.closing = side({
    caseRow: caseRow(CLOSING),
    facts: [rewritten, closureFact()],
    timeline: [narration(CLOSING, "from")],
    relationships: [edgeRow()],
  });
  assertOnlyFailure(evaluateHostedResolutionEvidence(inputs), "EC-06", "a fact value was rewritten");
}

function testUntypedOrEndedEdgeFails(): void {
  const inputs = happyPath();
  const ended = edgeRow({ status: "ended", ended_at: "2026-09-07T01:00:00.000Z" });
  inputs.after.closing.relationships = [ended];
  inputs.after.surviving.relationships = [ended];
  assertOnlyFailure(evaluateHostedResolutionEvidence(inputs), "EC-06", "the edge is not active");
}

function testEdgeWithoutTraceabilityFails(): void {
  const inputs = happyPath();
  const bare = edgeRow({ reason: null, evidence_refs_jsonb: {}, provenance_jsonb: {} });
  inputs.after.closing.relationships = [bare];
  inputs.after.surviving.relationships = [bare];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "EC-06",
    "the edge carries no reason, evidence or provenance"
  );
}

function testReversedEdgeDirectionFails(): void {
  const inputs = happyPath();
  const reversed = edgeRow({ from_case_id: SURVIVING, to_case_id: CLOSING });
  inputs.after.closing.relationships = [reversed];
  inputs.after.surviving.relationships = [reversed];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "EC-06",
    "the edge points from the surviving Case to the closing one"
  );
}

// ── AC-15: one canonical active responsibility, history retained ────────────

function testNoClosureLeavesTwoResponsibilitiesAndFails(): void {
  const inputs = happyPath();
  inputs.after.closing = side({
    caseRow: caseRow(CLOSING),
    facts: [CLOSING_OBJECTIVE],
    timeline: [narration(CLOSING, "from")],
    relationships: [edgeRow()],
  });
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "AC-15",
    "an edge without a closure leaves two ongoing responsibilities"
  );
}

function testClosureOnTheSurvivingCaseFails(): void {
  const inputs = happyPath();
  inputs.after.surviving = side({
    caseRow: caseRow(SURVIVING),
    facts: [SURVIVING_OBJECTIVE, fact("other-closure", SURVIVING, "opportunity.closure", {
      outcome: "duplicate",
      reason: "same_objective_canonicalized",
      counterpart_case_id: CLOSING,
      actor_kind: "human",
      evidence_refs: { scenario: "ec06-ac15" },
    })],
    timeline: [narration(SURVIVING, "to")],
    relationships: [edgeRow()],
  });
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "AC-15",
    "the canonical survivor was closed too"
  );
}

function testClosureWithWrongOutcomeFails(): void {
  const inputs = happyPath();
  const wrong = closureFact();
  wrong.value_jsonb = {
    ...(wrong.value_jsonb as Record<string, unknown>),
    outcome: "lost",
  };
  inputs.after.closing.facts = [CLOSING_OBJECTIVE, wrong];
  inputs.afterRepeat.closing = inputs.after.closing;
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "AC-15",
    "the closure records the wrong business outcome"
  );
}

function testClosureNotKeyedToTheEdgeFails(): void {
  const inputs = happyPath();
  const orphan = closureFact({ source_ref: "manual:operator-note" });
  inputs.after.closing.facts = [CLOSING_OBJECTIVE, orphan];
  inputs.afterRepeat.closing = inputs.after.closing;
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "AC-15",
    "the closure does not name the lineage edge it belongs to"
  );
}

function testMissingConflictPremiseFails(): void {
  const inputs = happyPath();
  // Both Cases carry the SAME objective — no conflicting facts, so this is not
  // the AC-15 scenario the Definition of Done asks for.
  const same = fact("fact-surviving-1", SURVIVING, CONFLICT_KEY, {
    objective: "casa 3 recamaras, presupuesto 4.2M",
    category: "purchase",
  });
  inputs.before.surviving = side({ caseRow: caseRow(SURVIVING), facts: [same] });
  inputs.after.surviving.facts = [same];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "premise",
    "the pair does not actually carry conflicting facts"
  );
}

function testPreExistingClosureFailsThePremise(): void {
  const inputs = happyPath();
  inputs.before.closing = side({
    caseRow: caseRow(CLOSING),
    facts: [CLOSING_OBJECTIVE, closureFact()],
  });
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "premise",
    "the Case was already closed before the scenario ran"
  );
}

// ── SA-3.1 / SA-3.12: a half-completed pair is never a resolution ───────────

function testUnresolvedIsNotReportedAsResolution(): void {
  const inputs = happyPath();
  inputs.result = {
    status: "unresolved",
    relationshipId: EDGE,
    closureFactId: null,
    missing: "closure",
    detail: "23505: duplicate key",
  };
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.1",
    "the executor did not report a completed resolution"
  );
}

function testOwedIncompleteResolutionFails(): void {
  const inputs = happyPath();
  inputs.incompleteAfter = [{ relationshipId: EDGE, missing: "closure" }];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.12",
    "the recovery read still reports a half-done resolution"
  );
}

// ── SA-3.3: lineage queryable from EITHER Case ──────────────────────────────

function testLineageNotQueryableFromSurvivingFails(): void {
  const inputs = happyPath();
  inputs.after.surviving.relationships = [];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.3",
    "the edge is not reachable from the surviving Case"
  );
}

// ── SA-3.4: the resolution mutates neither Case row ─────────────────────────

function testCaseRowMutationFails(): void {
  const inputs = happyPath();
  inputs.after.closing.case = caseRow(CLOSING, {
    status: "completed",
    version: 1,
    updated_at: "2026-09-07T02:00:00.000Z",
  });
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.4",
    "the closing Case row was closed by the resolution"
  );
}

function testScheduledNextActionFails(): void {
  const inputs = happyPath();
  inputs.after.surviving.case = caseRow(SURVIVING, {
    next_action_at: "2026-09-08T00:00:00.000Z",
  });
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.4",
    "the surviving Case was scheduled to act"
  );
}

// ── SA-3.5: both timelines, once each ───────────────────────────────────────

function testNarrationOnOneTimelineOnlyFails(): void {
  const inputs = happyPath();
  inputs.after.surviving.timeline = [];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.5",
    "only one endpoint was narrated"
  );
}

function testDoubleNarrationFails(): void {
  const inputs = happyPath();
  inputs.after.closing.timeline = [narration(CLOSING, "from"), narration(CLOSING, "from")];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.5",
    "the same edge was narrated twice on one timeline"
  );
}

function testNarrationSideMustMatchDirection(): void {
  const inputs = happyPath();
  inputs.after.closing.timeline = [narration(CLOSING, "to")];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.5",
    "the closing Case's narration claims the wrong end of the edge"
  );
}

// ── SA-3.6: conflicting facts survive, attributable to their own Case ───────

function testReconciledConflictFails(): void {
  const inputs = happyPath();
  const reconciled = fact("fact-closing-2", CLOSING, CONFLICT_KEY, {
    objective: "casa 3 recamaras, presupuesto 5.0M",
    category: "purchase",
  });
  inputs.after.closing.facts = [
    { ...CLOSING_OBJECTIVE, superseded_by: reconciled.id },
    reconciled,
    closureFact(),
  ];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.6",
    "the closing Case's conflicting value was overwritten with the survivor's"
  );
}

// ── SA-3.7: a retried determination converges ───────────────────────────────

function testRepeatCreatingASecondEdgeFails(): void {
  const inputs = happyPath();
  const second = edgeRow({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
  inputs.afterRepeat.closing = side({
    caseRow: caseRow(CLOSING),
    facts: [CLOSING_OBJECTIVE, closureFact()],
    timeline: [narration(CLOSING, "from")],
    relationships: [edgeRow(), second],
  });
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.7",
    "the retry wrote a second active edge"
  );
}

function testRepeatReportedAsFirstCompletionFails(): void {
  const inputs = happyPath();
  inputs.repeat = { ...inputs.repeat, firstCompletion: true };
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.7",
    "the retry claimed to be the first completion"
  );
}

function testRepeatWritingASecondClosureFails(): void {
  const inputs = happyPath();
  inputs.afterRepeat.closing = side({
    caseRow: caseRow(CLOSING),
    facts: [
      CLOSING_OBJECTIVE,
      closureFact(),
      closureFact({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd" }),
    ],
    timeline: [narration(CLOSING, "from")],
    relationships: [edgeRow()],
  });
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.7",
    "the retry wrote a second current closure"
  );
}

// ── SA-3.11: the supersession flow ──────────────────────────────────────────

function supersessionInputs(): HostedResolutionInputs {
  const inputs = happyPath();
  inputs.kind = "supersession";
  const supersededEdge = edgeRow({ relationship_type: "superseded_by" });
  const supersededClosure = closureFact();
  supersededClosure.value_jsonb = {
    ...(supersededClosure.value_jsonb as Record<string, unknown>),
    outcome: "superseded",
    reason: "replaced_by_successor_opportunity",
  };
  const closing = side({
    caseRow: caseRow(CLOSING),
    facts: [CLOSING_OBJECTIVE, supersededClosure],
    timeline: [
      {
        case_id: CLOSING,
        payload_jsonb: {
          kind: "case_relationship",
          relationship_id: EDGE,
          relationship_type: "superseded_by",
          transition: "created",
          side: "from",
          counterpart_case_id: SURVIVING,
        },
      },
    ],
    relationships: [supersededEdge],
  });
  const surviving = side({
    caseRow: caseRow(SURVIVING),
    facts: [SURVIVING_OBJECTIVE],
    timeline: [
      {
        case_id: SURVIVING,
        payload_jsonb: {
          kind: "case_relationship",
          relationship_id: EDGE,
          relationship_type: "superseded_by",
          transition: "created",
          side: "to",
          counterpart_case_id: CLOSING,
        },
      },
    ],
    relationships: [supersededEdge],
  });
  inputs.after = { closing, surviving };
  inputs.afterRepeat = { closing, surviving };
  return inputs;
}

function testSupersessionHappyPathPasses(): void {
  const checks = evaluateHostedResolutionEvidence(supersessionInputs());
  assert.ok(
    allPassed(checks),
    `expected the supersession scenario to pass; failed: ${failing(checks).join(" | ")}`
  );
  assert.ok(
    checks.some((check) => check.assertion === "SA-3.11"),
    "the supersession scenario must evaluate SA-3.11"
  );
}

function testSupersessionWithDuplicateEdgeFails(): void {
  const inputs = supersessionInputs();
  const wrongType = edgeRow({ relationship_type: "duplicate_of" });
  inputs.after.closing.relationships = [wrongType];
  inputs.after.surviving.relationships = [wrongType];
  assertOnlyFailure(
    evaluateHostedResolutionEvidence(inputs),
    "SA-3.11",
    "a supersession must not be recorded as a duplicate edge"
  );
}

function testDuplicateScenarioDoesNotEvaluateSA311(): void {
  const checks = evaluateHostedResolutionEvidence(happyPath());
  assert.ok(
    !checks.some((check) => check.assertion === "SA-3.11"),
    "the duplicate scenario must not claim to evidence the supersession assertion"
  );
}

// ── Privacy ─────────────────────────────────────────────────────────────────

function testNoRawIdentifiersInDetails(): void {
  const checks = evaluateHostedResolutionEvidence(happyPath());
  const blob = JSON.stringify(checks);
  for (const [name, raw] of Object.entries({ ORG, CLOSING, SURVIVING, OWNER })) {
    assert.ok(
      !blob.includes(raw),
      `${name} leaked into the evidence detail — it must be digested, not literal`
    );
  }
}

const tests: Array<[string, () => void]> = [
  ["a complete duplicate resolution passes", testHappyPathPasses],
  ["a deleted Case fails EC-06", testDeletedCaseFails],
  ["a discarded fact row fails EC-06", testDiscardedHistoryFails],
  ["a rewritten fact value fails EC-06", testRewrittenHistoryFails],
  ["an ended edge does not satisfy EC-06", testUntypedOrEndedEdgeFails],
  ["an edge without traceability fails EC-06", testEdgeWithoutTraceabilityFails],
  ["a reversed edge direction fails EC-06", testReversedEdgeDirectionFails],
  ["an edge without a closure fails AC-15", testNoClosureLeavesTwoResponsibilitiesAndFails],
  ["closing the canonical survivor fails AC-15", testClosureOnTheSurvivingCaseFails],
  ["a closure with the wrong outcome fails AC-15", testClosureWithWrongOutcomeFails],
  ["a closure not keyed to the edge fails AC-15", testClosureNotKeyedToTheEdgeFails],
  ["a pair without conflicting facts fails the premise", testMissingConflictPremiseFails],
  ["a pre-existing closure fails the premise", testPreExistingClosureFailsThePremise],
  ["an unresolved result is not evidence of resolution", testUnresolvedIsNotReportedAsResolution],
  ["an owed incomplete resolution fails SA-3.12", testOwedIncompleteResolutionFails],
  ["lineage unreachable from the survivor fails SA-3.3", testLineageNotQueryableFromSurvivingFails],
  ["a mutated Case row fails SA-3.4", testCaseRowMutationFails],
  ["a newly scheduled next action fails SA-3.4", testScheduledNextActionFails],
  ["narration on one timeline only fails SA-3.5", testNarrationOnOneTimelineOnlyFails],
  ["double narration fails SA-3.5", testDoubleNarrationFails],
  ["a narration on the wrong side fails SA-3.5", testNarrationSideMustMatchDirection],
  ["a reconciled conflicting fact fails SA-3.6", testReconciledConflictFails],
  ["a retry writing a second edge fails SA-3.7", testRepeatCreatingASecondEdgeFails],
  ["a retry claiming first completion fails SA-3.7", testRepeatReportedAsFirstCompletionFails],
  ["a retry writing a second closure fails SA-3.7", testRepeatWritingASecondClosureFails],
  ["a complete supersession resolution passes", testSupersessionHappyPathPasses],
  ["a supersession recorded as a duplicate fails SA-3.11", testSupersessionWithDuplicateEdgeFails],
  ["the duplicate scenario does not claim SA-3.11", testDuplicateScenarioDoesNotEvaluateSA311],
  ["no raw identifier reaches the evidence detail", testNoRawIdentifiersInDetails],
];

let passed = 0;
for (const [name, run] of tests) {
  run();
  console.log(`  ok  ${name}`);
  passed += 1;
}
console.log(`resolution-evidence selftest: ${passed} checks passed`);
