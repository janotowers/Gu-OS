// Selftests for the hosted-evidence evaluator (R1 SL-2, SA-2.1 / SA-2.2).
//
// The hosted run itself cannot be tested without a hosted environment, so its
// pass/fail logic lives in a pure module and is tested here. What these prove is
// the property the review asked for: an assertion must fail when the thing it
// names is not true, and must not fail for unrelated reasons.
//
// In particular:
//   * "exactly one Case" must fail on two, not merely pass on one;
//   * the fact check must ask "did THIS admission write its owed evidence?",
//     keyed on `source_ref = source_events:<id>`, not "does the Case have any
//     fact with this key?";
//   * an unrelated legitimate Case fact must not fail the run;
//   * the objective fact is owed only when the decision carries an objective.
import assert from "node:assert/strict";
import {
  admissionSourceRef,
  evaluateHostedAdmissionEvidence,
  owedFactKeys,
  type HostedAdmissionInputs,
  type HostedCheck,
} from "./admission-evidence";

const ORG = "11111111-1111-1111-1111-111111111111";
const EVENT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CASE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOURCE_REF = admissionSourceRef(EVENT);

const POLICY = {
  policy_id: "platform-default@1",
  version: 1,
  source: "platform_default",
};

const ADMITTED = {
  disposition: "admitted",
  reason: "clear_objective",
  policy: POLICY,
  proposal: { objective: "Comprar casa en Coyoacan" },
};

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE,
    case_type: "lead_opportunity",
    organization_id: ORG,
    runtime_authority: "legacy",
    current_step: null,
    next_action_at: null,
    context_jsonb: { source_event_id: EVENT },
    ...overrides,
  } as HostedAdmissionInputs["matchingCases"][number];
}

function fact(factKey: string, overrides: Record<string, unknown> = {}) {
  return {
    fact_key: factKey,
    source_ref: SOURCE_REF,
    value_jsonb:
      factKey === "admission.disposition" ? { policy: POLICY } : { v: 1 },
    superseded_by: null,
    ...overrides,
  } as HostedAdmissionInputs["caseFacts"][number];
}

function inputs(
  overrides: Partial<HostedAdmissionInputs> = {}
): HostedAdmissionInputs {
  return {
    organizationId: ORG,
    sourceEventId: EVENT,
    decision: ADMITTED,
    returnedCaseId: CASE,
    matchingCases: [caseRow()],
    sourceEvent: {
      status: "completed",
      decision_jsonb: { disposition: "admitted", policy: POLICY },
      admitted_case_id: CASE,
    },
    caseFacts: [
      fact("admission.disposition"),
      fact("admission.source"),
      fact("opportunity.objective"),
    ],
    timeline: [
      { payload_jsonb: { kind: "admission_disposition", source_event_id: EVENT } },
    ],
    redact: (value) => (value ? `sha256:${value.slice(0, 8)}` : null),
    ...overrides,
  };
}

function failing(checks: HostedCheck[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.label);
}

function find(checks: HostedCheck[], fragment: string): HostedCheck {
  const match = checks.find((check) => check.label.includes(fragment));
  assert.ok(match, `no check mentioning "${fragment}"`);
  return match;
}

// ============================================================

function testHappyPathPasses(): void {
  const checks = evaluateHostedAdmissionEvidence(inputs());
  assert.deepEqual(failing(checks), [], "a complete materialisation passes");
}

function testTwoCasesFail(): void {
  // The defect the old `Boolean(case_id)` check could not see.
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      matchingCases: [caseRow(), caseRow({ id: "second-case" })],
    })
  );
  assert.equal(
    find(checks, "exactly one Opportunity Case").ok,
    false,
    "two Cases for one source event must fail"
  );
}

function testCaseMismatchFails(): void {
  const checks = evaluateHostedAdmissionEvidence(
    inputs({ matchingCases: [caseRow({ id: "someone-elses-case" })] })
  );
  assert.equal(find(checks, "the one admission returned").ok, false);
}

function testShadowPropertiesChecked(): void {
  for (const [label, override] of [
    ["scheduled work", { next_action_at: "2026-09-06T00:00:00.000Z" }],
    ["a workflow stage", { current_step: "intake" }],
    ["runtime authority moved", { runtime_authority: "gu_os" }],
    ["no Organization", { organization_id: null }],
  ] as Array<[string, Record<string, unknown>]>) {
    const checks = evaluateHostedAdmissionEvidence(
      inputs({ matchingCases: [caseRow(override)] })
    );
    assert.equal(
      find(checks, "Organization-owned, lead_opportunity, and shadow").ok,
      false,
      `a Case with ${label} must fail the shadow materialisation check`
    );
  }
}

function testUnsettledSourceEventFails(): void {
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      sourceEvent: {
        status: "processing",
        decision_jsonb: null,
        admitted_case_id: null,
      },
    })
  );
  assert.equal(find(checks, "settled in the hosted target").ok, false);
  assert.equal(find(checks, "matches the returned disposition").ok, false);
}

function testSettledPolicyMismatchFails(): void {
  // A settled row attributing a different policy version than the returned
  // decision would mean the durable evidence and the answer disagree.
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      sourceEvent: {
        status: "completed",
        decision_jsonb: {
          disposition: "admitted",
          policy: { ...POLICY, version: 2 },
        },
        admitted_case_id: CASE,
      },
    })
  );
  assert.equal(
    find(checks, "the same effective policy attribution").ok,
    false
  );
}

function testFactFromAnotherProvenanceDoesNotSatisfy(): void {
  // The heart of it: a Case that HAS an opportunity.objective written by
  // somebody else must not be read as "this admission wrote its evidence".
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      caseFacts: [
        fact("admission.disposition"),
        fact("admission.source"),
        fact("opportunity.objective", { source_ref: "advisor_correction" }),
      ],
    })
  );
  assert.equal(
    find(checks, "exactly one opportunity.objective fact").ok,
    false,
    "another writer's fact must not satisfy admission's owed evidence"
  );
}

function testUnrelatedFactsDoNotFail(): void {
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      caseFacts: [
        fact("admission.disposition"),
        fact("admission.source"),
        fact("opportunity.objective"),
        // Legitimate facts from elsewhere, including one with no provenance.
        { fact_key: "property.bedrooms", source_ref: "advisor", value_jsonb: 3, superseded_by: null },
        { fact_key: "contact.phone", source_ref: null, value_jsonb: "x", superseded_by: null },
      ],
    })
  );
  assert.deepEqual(
    failing(checks),
    [],
    "unrelated Case facts must not fail the admission evidence"
  );
}

function testDuplicateFactFails(): void {
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      caseFacts: [
        fact("admission.disposition"),
        fact("admission.disposition"),
        fact("admission.source"),
        fact("opportunity.objective"),
      ],
    })
  );
  assert.equal(
    find(checks, "exactly one admission.disposition fact").ok,
    false
  );
}

function testObjectiveOwedOnlyWhenCarried(): void {
  assert.deepEqual(owedFactKeys({ decision: ADMITTED }), [
    "admission.disposition",
    "admission.source",
    "opportunity.objective",
  ]);
  const trustedSource = {
    disposition: "admitted",
    reason: "trusted_source",
    policy: POLICY,
    proposal: null,
  };
  assert.deepEqual(owedFactKeys({ decision: trustedSource }), [
    "admission.disposition",
    "admission.source",
  ]);

  // ...and the evaluation agrees: no objective fact, no failure.
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      decision: trustedSource,
      caseFacts: [fact("admission.disposition"), fact("admission.source")],
    })
  );
  assert.deepEqual(failing(checks), []);
}

function testDispositionFactPolicyMismatchFails(): void {
  const checks = evaluateHostedAdmissionEvidence(
    inputs({
      caseFacts: [
        fact("admission.disposition", {
          value_jsonb: { policy: { ...POLICY, version: 7 } },
        }),
        fact("admission.source"),
        fact("opportunity.objective"),
      ],
    })
  );
  assert.equal(
    find(checks, "disposition fact preserves the effective policy").ok,
    false
  );
}

function testTimelineNarratedExactlyOnce(): void {
  const twice = evaluateHostedAdmissionEvidence(
    inputs({
      timeline: [
        { payload_jsonb: { kind: "admission_disposition", source_event_id: EVENT } },
        { payload_jsonb: { kind: "admission_disposition", source_event_id: EVENT } },
      ],
    })
  );
  assert.equal(find(twice, "narrated exactly once").ok, false);

  const none = evaluateHostedAdmissionEvidence(inputs({ timeline: [] }));
  assert.equal(find(none, "narrated exactly once").ok, false);

  // Another admission's narration on the same Case is not this one's.
  const other = evaluateHostedAdmissionEvidence(
    inputs({
      timeline: [
        {
          payload_jsonb: {
            kind: "admission_disposition",
            source_event_id: "another-event",
          },
        },
        { payload_jsonb: { kind: "admission_disposition", source_event_id: EVENT } },
        { payload_jsonb: { kind: "step_completed" } },
      ],
    })
  );
  assert.equal(find(other, "narrated exactly once").ok, true);
}

function testUnadmittedLeavesNoCase(): void {
  const refused = {
    disposition: "not_admitted",
    reason: "platform_hard_bound",
    policy: POLICY,
    proposal: null,
  };
  const clean = evaluateHostedAdmissionEvidence(
    inputs({
      decision: refused,
      returnedCaseId: null,
      matchingCases: [],
      caseFacts: [],
      timeline: [],
      sourceEvent: {
        status: "completed",
        decision_jsonb: { disposition: "not_admitted", policy: POLICY },
        admitted_case_id: null,
      },
    })
  );
  assert.deepEqual(failing(clean), []);

  // A Case that exists anyway is a contract violation, not a pass.
  const leaked = evaluateHostedAdmissionEvidence(
    inputs({
      decision: refused,
      returnedCaseId: null,
      matchingCases: [caseRow()],
      caseFacts: [],
      timeline: [],
      sourceEvent: {
        status: "completed",
        decision_jsonb: { disposition: "not_admitted", policy: POLICY },
        admitted_case_id: null,
      },
    })
  );
  assert.equal(find(leaked, "materialises no Opportunity Case").ok, false);
}

function testNoRawIdentifiersInDetails(): void {
  const checks = evaluateHostedAdmissionEvidence(
    inputs({ matchingCases: [caseRow({ id: "someone-elses-case" })] })
  );
  for (const check of checks) {
    const detail = check.detail ?? "";
    assert.ok(
      !detail.includes(CASE) && !detail.includes(EVENT),
      `check "${check.label}" leaked a raw identifier into evidence`
    );
  }
}

const tests: Array<[string, () => void]> = [
  ["a complete hosted materialisation passes", testHappyPathPasses],
  ["two Cases for one source event fail", testTwoCasesFail],
  ["a Case that is not the returned one fails", testCaseMismatchFails],
  ["the shadow materialisation properties are checked", testShadowPropertiesChecked],
  ["an unsettled source event fails", testUnsettledSourceEventFails],
  ["a settled policy mismatch fails", testSettledPolicyMismatchFails],
  ["another writer's fact does not satisfy admission's owed evidence", testFactFromAnotherProvenanceDoesNotSatisfy],
  ["unrelated Case facts do not fail the run", testUnrelatedFactsDoNotFail],
  ["a duplicated admission fact fails", testDuplicateFactFails],
  ["the objective fact is owed only when carried", testObjectiveOwedOnlyWhenCarried],
  ["a disposition fact with the wrong policy fails", testDispositionFactPolicyMismatchFails],
  ["the admission is narrated exactly once", testTimelineNarratedExactlyOnce],
  ["an unadmitted lead leaves no Case", testUnadmittedLeavesNoCase],
  ["no raw identifier reaches the evidence detail", testNoRawIdentifiersInDetails],
];

let passed = 0;
for (const [name, run] of tests) {
  run();
  console.log(`  ok  ${name}`);
  passed += 1;
}
console.log(`admission-evidence selftest: ${passed} checks passed`);
