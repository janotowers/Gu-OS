// Selftests for the SL-4 hosted-evidence evaluator.
//
// The hosted run cannot be tested without a hosted environment, so its pass/fail
// logic lives in a pure module and is tested here. What these prove is the
// property SL-2's review established and every Slice since has inherited: an
// assertion must FAIL when the thing it names is untrue, and must not fail for
// unrelated reasons. A hosted evidence file whose checks cannot fail is
// decoration.
//
// The negative cases are chosen from SL-4's own risk table:
//   * three reconsiderations inside ONE day reported as a multi-day history —
//     the single most tempting thing for a verifier to fake;
//   * a posture recorded with no rationale, which is a posture nobody can
//     explain from the evidence available at the time;
//   * one wake producing two reconsiderations (SA-4.6);
//   * a reconsideration that left no re-entry path (EC-39);
//   * a claim with no settlement reported as a completed run;
//   * an entity id smuggled back into a `fact_key` (SA-4.4);
//   * a Work Item that is not `agent_proposed`, and a Case that acquired
//     runtime authority — the two ways shadow could silently end;
//   * a replay that disagrees with the rows it claims to reconstruct.
import assert from "node:assert/strict";
import {
  allPassed,
  distinctUtcDays,
  evaluateHostedSupervisorEvidence,
  type HostedCheck,
  type HostedSupervisorInputs,
} from "./supervisor-evidence";

const ORG = "11111111-1111-1111-1111-111111111111";
const CASE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SUBJECT = "55555555-5555-5555-5555-555555555555";

let passed = 0;
function t(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function failedAssertions(checks: readonly HostedCheck[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => `${c.assertion}: ${c.label}`);
}

/** A run that is correct in every respect. Each case below breaks exactly one. */
function baseline(): HostedSupervisorInputs {
  return {
    organizationId: ORG,
    requiredDistinctDays: 3,
    cases: [
      {
        id: CASE,
        organization_id: ORG,
        case_type: "lead_opportunity",
        status: "active",
        next_action_at: "2026-09-12T12:00:00.000Z",
        runtime_authority: null,
      },
    ],
    reconsiderations: [
      reconsideration("scheduled:d1", "2026-09-08T12:00:00.000Z", "no_op"),
      reconsideration("scheduled:d2", "2026-09-09T12:00:00.000Z", "work"),
      reconsideration("scheduled:d3", "2026-09-10T12:00:00.000Z", "wait"),
    ],
    settlements: [
      settlement("scheduled:d1", "2026-09-08T12:00:01.000Z"),
      settlement("scheduled:d2", "2026-09-09T12:00:01.000Z"),
      settlement("scheduled:d3", "2026-09-10T12:00:01.000Z"),
    ],
    subjects: [
      {
        id: SUBJECT,
        case_id: CASE,
        subject_kind: "commitment",
        attrs_jsonb: { commitment_key: "send_comparison" },
      },
    ],
    facts: [
      fact("f1", "commitment.due", SUBJECT),
      fact("f2", "commitment.status", SUBJECT),
      fact("f3", "opportunity.objective", null),
    ],
    work: [
      {
        id: "w1",
        case_id: CASE,
        work_type: "verify_budget",
        origin: "agent_proposed",
        status: "todo",
      },
    ],
    replay: {
      caseId: CASE,
      objective: "Comprar casa en Zibatá",
      commitmentCount: 1,
      postureCount: 3,
      waitingOn: "waiting_for_prospect",
      nextWakeAt: "2026-09-12T12:00:00.000Z",
    },
    observability: {
      total: 3,
      noAction: 2,
      noActionRatio: 2 / 3,
      distinctDays: 3,
    },
  };
}

function reconsideration(wakeKey: string, createdAt: string, posture: string) {
  return {
    created_at: createdAt,
    case_id: CASE,
    payload: {
      kind: "supervisor_reconsidered",
      v: 1,
      wake_key: wakeKey,
      wake_reason: "scheduled_reconsideration",
      posture,
      yield_posture: "no_useful_work_now",
      rationale: "nothing material changed since the last exchange",
      diagnosis: null,
      uncertainty: null,
      next_action_at: "2026-09-12T12:00:00.000Z",
      stage: "shadow",
      model_id: "openai/gpt-5.4-mini",
    },
  };
}

function settlement(wakeKey: string, createdAt: string) {
  return {
    created_at: createdAt,
    case_id: CASE,
    payload: {
      kind: "supervisor_reconsideration_settled",
      wake_key: wakeKey,
      yield_posture: "no_useful_work_now",
      proposed_work_ids: [],
      commitment_subject_ids: [],
    },
  };
}

function fact(id: string, key: string, subjectId: string | null) {
  return {
    id,
    case_id: CASE,
    fact_key: key,
    subject_id: subjectId,
    superseded_by: null,
    value_jsonb: {},
  };
}

function main(): void {
  console.log("\nthe baseline must pass, or every negative below proves nothing");

  t("a correct hosted run passes every check", () => {
    const checks = evaluateHostedSupervisorEvidence(baseline());
    assert.ok(
      allPassed(checks),
      `unexpected failures: ${failedAssertions(checks).join("; ")}`
    );
  });

  console.log("\nSA-4.3 multi-day — the assertion a verifier could most easily fake");

  t("three reconsiderations inside ONE day fail the multi-day assertion", () => {
    const input = baseline();
    input.reconsiderations = [
      reconsideration("scheduled:a", "2026-09-08T09:00:00.000Z", "no_op"),
      reconsideration("scheduled:b", "2026-09-08T09:05:00.000Z", "work"),
      reconsideration("scheduled:c", "2026-09-08T09:10:00.000Z", "wait"),
    ];
    input.settlements = [
      settlement("scheduled:a", "2026-09-08T09:00:01.000Z"),
      settlement("scheduled:b", "2026-09-08T09:05:01.000Z"),
      settlement("scheduled:c", "2026-09-08T09:10:01.000Z"),
    ];
    input.observability = { total: 3, noAction: 2, noActionRatio: 2 / 3, distinctDays: 1 };
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(
      failedAssertions(checks).some((f) => f.includes("distinct UTC days")),
      "the day-span assertion must be the one that fails"
    );
  });

  t("two days is not three when three are required", () => {
    const input = baseline();
    input.reconsiderations[2] = reconsideration(
      "scheduled:d3",
      "2026-09-09T18:00:00.000Z",
      "wait"
    );
    input.observability = { total: 3, noAction: 2, noActionRatio: 2 / 3, distinctDays: 2 };
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("three calendar days four minutes apart fail the elapsed-span check", () => {
    // The loophole a pure day count leaves open, and the reason the span is
    // checked too: the operator is at UTC-6, so 17:59 and 18:01 local are two
    // different UTC days.
    const input = baseline();
    input.reconsiderations = [
      reconsideration("scheduled:a", "2026-09-08T23:58:00.000Z", "no_op"),
      reconsideration("scheduled:b", "2026-09-09T00:01:00.000Z", "work"),
      reconsideration("scheduled:c", "2026-09-10T00:01:00.000Z", "wait"),
    ];
    input.settlements = [
      settlement("scheduled:a", "2026-09-08T23:58:01.000Z"),
      settlement("scheduled:b", "2026-09-09T00:01:01.000Z"),
      settlement("scheduled:c", "2026-09-10T00:01:01.000Z"),
    ];
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.equal(
      failedAssertions(checks).filter((f) => f.includes("distinct UTC days")).length,
      0,
      "the day COUNT is satisfied — which is exactly the problem"
    );
    assert.ok(!allPassed(checks));
    assert.ok(
      failedAssertions(checks).some((f) => f.includes("apart")),
      "the elapsed-span assertion must be the one that catches it"
    );
  });

  t("a genuine three-day run satisfies both the day count and the span", () => {
    assert.ok(allPassed(evaluateHostedSupervisorEvidence(baseline())));
  });

  t("the day count is computed from the database clock, in UTC", () => {
    assert.deepEqual(
      distinctUtcDays([
        "2026-09-08T23:59:59.000Z",
        "2026-09-09T00:00:01.000Z",
        "2026-09-09T23:00:00.000Z",
      ]),
      ["2026-09-08", "2026-09-09"]
    );
    assert.deepEqual(distinctUtcDays(["not-a-date"]), []);
  });

  console.log("\nSA-4.2 attributability");

  t("a posture with no rationale fails", () => {
    const input = baseline();
    input.reconsiderations[1].payload.rationale = "   ";
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("a reconsideration with no wake key fails", () => {
    const input = baseline();
    input.reconsiderations[0].payload.wake_key = "";
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("a reconsideration on a Case outside this run fails", () => {
    const input = baseline();
    input.reconsiderations[0].case_id = "99999999-9999-9999-9999-999999999999";
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  console.log("\nSA-4.6 / SA-4.3 coalescing and completeness");

  t("one wake producing two reconsiderations fails", () => {
    const input = baseline();
    input.reconsiderations[2] = reconsideration(
      "scheduled:d1",
      "2026-09-10T12:00:00.000Z",
      "wait"
    );
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(
      failedAssertions(checks).some((f) => f.includes("two reconsiderations"))
    );
  });

  t("a reconsideration with no re-entry path fails (EC-39)", () => {
    const input = baseline();
    input.reconsiderations[1].payload.next_action_at = null;
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(failedAssertions(checks).some((f) => f.includes("re-entry path")));
  });

  t("a claim with no settlement is not a completed reconsideration", () => {
    const input = baseline();
    input.settlements = input.settlements.slice(0, 2);
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(failedAssertions(checks).some((f) => f.includes("settled")));
  });

  console.log("\nSA-4.4 subject-scoped facts");

  t("an entity id smuggled back into a fact_key fails", () => {
    const input = baseline();
    input.facts[0] = fact(
      "f1",
      "commitment.cccccccc-cccc-cccc-cccc-cccccccccccc.due",
      SUBJECT
    );
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(failedAssertions(checks).some((f) => f.includes("entity id")));
  });

  t("a subject fact pointing at another Case's subject fails", () => {
    const input = baseline();
    input.facts[0] = fact("f1", "commitment.due", "deadbeef-dead-beef-dead-beefdeadbeef");
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("two current rows for the same (subject, key) fail", () => {
    const input = baseline();
    input.facts.push(fact("f4", "commitment.due", SUBJECT));
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  console.log("\nSA-4.8 the two ways shadow could silently end");

  t("a Work Item that is not agent_proposed fails", () => {
    const input = baseline();
    input.work[0].origin = "definition_template";
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(failedAssertions(checks).some((f) => f.includes("agent_proposed")));
  });

  t("a Case that acquired runtime authority fails", () => {
    const input = baseline();
    input.cases[0].runtime_authority = "gu_os";
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(failedAssertions(checks).some((f) => f.includes("runtime authority")));
  });

  t("a reconsideration recording a stage other than shadow fails", () => {
    const input = baseline();
    input.reconsiderations[0].payload.stage = "assisted";
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  console.log("\nSA-4.5 reconstruction must AGREE with the rows");

  t("a replay that misses a reconsideration fails", () => {
    const input = baseline();
    input.replay = { ...input.replay!, postureCount: 2 };
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("a replay that misses a commitment fails", () => {
    const input = baseline();
    input.replay = { ...input.replay!, commitmentCount: 0 };
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("a replay that recovers no wake condition fails", () => {
    const input = baseline();
    input.replay = { ...input.replay!, nextWakeAt: null };
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("no replay at all is a failure, not a silent omission", () => {
    const input = baseline();
    input.replay = null;
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
    assert.ok(failedAssertions(checks).some((f) => f.startsWith("SA-4.5")));
  });

  console.log("\nSA-4.9 observability is reported, never judged");

  t("a missing ratio fails; the ratio's VALUE never does", () => {
    const input = baseline();
    input.observability = { total: 0, noAction: 0, noActionRatio: null, distinctDays: 3 };
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));

    // Every ratio from all-quiet to all-action passes, because no governing
    // artifact approves a target and inventing one here would manufacture a
    // product threshold the Slice does not own.
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const ok = baseline();
      ok.observability = {
        total: 3,
        noAction: Math.round(ratio * 3),
        noActionRatio: ratio,
        distinctDays: 3,
      };
      assert.ok(
        allPassed(evaluateHostedSupervisorEvidence(ok)),
        `ratio ${ratio} must not itself fail anything`
      );
    }
  });

  t("observability that disagrees with the rows about the day span fails", () => {
    const input = baseline();
    input.observability = { ...input.observability!, distinctDays: 7 };
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  console.log("\nSA-4.12 containment");

  t("a Case belonging to another Organization fails", () => {
    const input = baseline();
    input.cases[0].organization_id = "22222222-2222-2222-2222-222222222222";
    assert.ok(!allPassed(evaluateHostedSupervisorEvidence(input)));
  });

  t("the containment check says plainly that it does not prove RLS", () => {
    const checks = evaluateHostedSupervisorEvidence(baseline());
    const containment = checks.find((c) => c.assertion === "SA-4.12");
    assert.ok(containment?.detail?.includes("NOT proven"));
  });

  console.log("\nan empty run must never look like a passing one");

  t("a run with no reconsiderations at all fails", () => {
    const input = baseline();
    input.reconsiderations = [];
    input.settlements = [];
    const checks = evaluateHostedSupervisorEvidence(input);
    assert.ok(!allPassed(checks));
  });

  console.log(`\nsupervisor-evidence selftest: ${passed} checks passed`);
}

main();
