// Selftest for the SL-7 hosted-evidence evaluator (`portfolio-evidence.ts`).
//
// One honest passing run, then one falsification per claim: each check must be
// able to FAIL for the reason its label names, or it proves nothing.

import assert from "node:assert/strict";
import {
  allPassed,
  diffRows,
  digestRows,
  evaluatePortfolioEvidence,
  fingerprint,
  OUTSIDE_TABLES,
  SEEDED_TABLES,
  type PortfolioCheckpoint,
  type PortfolioEvidenceInputs,
  type Row,
} from "./portfolio-evidence";

const ORG = "org-pilot";
const CASE = "case-seeded-7";
const ADVISOR = "user-advisor";
const ASK = "work-ask";
const OTHER_ORG_CASE = "case-other-org-1";

let passed = 0;
function t(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function checkpoint(label: string, overrides: Partial<Record<(typeof SEEDED_TABLES)[number], Row[]>> = {}, presentation: Row[] = []): PortfolioCheckpoint {
  const seeded = Object.fromEntries(SEEDED_TABLES.map((t) => [t, [] as Row[]])) as PortfolioCheckpoint["seeded"];
  seeded.operational_cases = [
    { id: CASE, organization_id: ORG, assigned_to_user_id: ADVISOR, runtime_authority: "legacy", version: 2 },
  ];
  seeded.operational_case_events = [
    { id: "ev-claim", payload_jsonb: { kind: "supervisor_reconsidered", wake_key: "k" } },
    {
      id: "ev-settled",
      payload_jsonb: {
        kind: "supervisor_reconsideration_settled",
        wake_key: "k",
        yield_posture: "waiting_for_human_input",
        proposed_work_ids: [ASK],
      },
    },
  ];
  seeded.work_items = [{ id: ASK, status: "todo", result_jsonb: null, version: 1 }];
  Object.assign(seeded, overrides);
  const outside = Object.fromEntries(
    OUTSIDE_TABLES.map((t) => [t, fingerprint([{ id: `${t}-other`, v: 1 }])])
  ) as PortfolioCheckpoint["outside"];
  return { label, takenAt: "2026-09-15T00:00:00Z", seededCaseId: CASE, seeded, outside, presentation };
}

const advisorRow = { id: "p1", user_id: ADVISOR, subject_kind: "case", subject_id: CASE, snooze_until: "2026-09-29T00:00:00Z", hidden_at: "2026-09-15T00:00:00Z" };

function honestRun(): PortfolioEvidenceInputs {
  const t0 = checkpoint("t0");
  const t1 = checkpoint("t1", {}, [advisorRow]);
  const t2 = checkpoint(
    "t2",
    {
      work_items: [
        {
          id: ASK,
          status: "done",
          version: 4,
          result_jsonb: { human_answer: { text: "Sí, 4.5M", answered_by: ADVISOR } },
        },
      ],
      work_item_attempts: [{ id: "att-1", work_item_id: ASK, executor_kind: "human", status: "succeeded" }],
      work_item_events: [
        { id: "we-1", event_type: "ready" },
        { id: "we-2", event_type: "claimed" },
        { id: "we-3", event_type: "done" },
      ],
    },
    [advisorRow]
  );
  return {
    organizationId: ORG,
    seededCaseId: CASE,
    advisorUserId: ADVISOR,
    askWorkItemId: ASK,
    t0,
    t1,
    t2,
    projected: {
      t1: { predicates: ["blocked_on_human", "due_commitment"], visible: true, exemptBecauseMustSurface: true, userSuppression: "hidden" },
      t2: { predicates: ["due_commitment"], visible: true, exemptBecauseMustSurface: true, userSuppression: "hidden" },
    },
    captures: {
      myWork: `… ${CASE} …`,
      organizationWork: `… ${CASE} … case-sl4-a …`,
      afterSuppress: `… ${CASE} …`,
      afterComplete: `… ${CASE} …`,
    },
    otherOrganizationCaseIds: [OTHER_ORG_CASE],
    probe: { attempted: true, refused: true, code: "42501" },
  };
}

const failing = (inputs: PortfolioEvidenceInputs) =>
  evaluatePortfolioEvidence(inputs).filter((c) => !c.ok).map((c) => c.label);

console.log("portfolio-evidence selftest (R1 SL-7)");

t("digests ignore row and key order, and diffs see exactly what moved", () => {
  assert.equal(digestRows([{ a: 1, b: 2 }, { a: 3 }]), digestRows([{ a: 3 }, { b: 2, a: 1 }]));
  assert.notEqual(digestRows([{ a: 1 }]), digestRows([{ a: 2 }]));
  const d = diffRows([{ id: "x", v: 1 }, { id: "y", v: 1 }], [{ id: "y", v: 2 }, { id: "z", v: 1 }]);
  assert.deepEqual(d, { added: ["z"], removed: ["x"], changed: ["y"] });
});

t("an honest session passes every check", () => {
  const checks = evaluatePortfolioEvidence(honestRun());
  assert.ok(allPassed(checks), JSON.stringify(checks.filter((c) => !c.ok), null, 2));
  assert.ok(checks.length >= 15);
});

t("RS2-1 fails when the seeded Case is missing from My Work, or another Organization's Case shows", () => {
  const missing = honestRun();
  missing.captures.myWork = "nothing here";
  assert.deepEqual(failing(missing), ["the seeded Case appears in the advisor's My Work"]);

  const leaked = honestRun();
  leaked.captures.organizationWork += ` ${OTHER_ORG_CASE}`;
  assert.deepEqual(failing(leaked), ["a Case of another Organization appears in neither"]);

  const vacuous = honestRun();
  vacuous.otherOrganizationCaseIds = [];
  assert.deepEqual(failing(vacuous), ["a Case of another Organization appears in neither"], "an unexercised negative is not a pass");
});

t("RS2-1 fails when the cross-user write was not attempted, or was accepted", () => {
  const none = honestRun();
  none.probe = null;
  assert.deepEqual(failing(none), ["an attempt to write another user's presentation state is refused"]);
  const accepted = honestRun();
  accepted.probe = { attempted: true, refused: false, code: null };
  assert.deepEqual(failing(accepted), ["an attempt to write another user's presentation state is refused"]);
});

t("RS2-2 fails when the item was suppressed, the row is missing, or a business row moved", () => {
  const suppressed = honestRun();
  suppressed.projected.t1 = { ...suppressed.projected.t1, visible: false };
  assert.ok(failing(suppressed).includes("the seeded must-surface items stay in the projection with that presentation applied"));

  const noRow = honestRun();
  noRow.t1 = checkpoint("t1", {}, []);
  assert.ok(failing(noRow).includes("the advisor's presentation-state row exists, snoozed and hidden"));

  const moved = honestRun();
  moved.t1.seeded.operational_cases = [{ ...moved.t1.seeded.operational_cases[0], version: 3 }];
  assert.ok(failing(moved).includes("no business row of the seeded Case changed between T0 and T1"));

  const outside = honestRun();
  outside.t1.outside.case_facts = fingerprint([{ id: "case_facts-other", v: 2 }]);
  assert.ok(failing(outside).includes("nothing outside the seeded Case changed between T0 and T1"));
});

t("RS2-3 fails on an extra Work row, a non-human attempt, a missing event, or a touched Case row", () => {
  const extraWork = honestRun();
  extraWork.t2.seeded.work_items.push({ id: "work-other", status: "todo" });
  assert.ok(failing(extraWork).includes("work_items: only the ask changed, to done, answered by the advisor"));

  const agentAttempt = honestRun();
  agentAttempt.t2.seeded.work_item_attempts = [{ id: "att-1", work_item_id: ASK, executor_kind: "main_agent", status: "succeeded" }];
  assert.ok(failing(agentAttempt).includes("work_item_attempts: exactly one new attempt, by a human executor, succeeded"));

  const missingEvent = honestRun();
  missingEvent.t2.seeded.work_item_events = missingEvent.t2.seeded.work_item_events.slice(0, 2);
  assert.ok(failing(missingEvent).includes("work_item_events: exactly ready, claimed and done were appended for the ask"));

  const touchedCase = honestRun();
  touchedCase.t2.seeded.operational_cases = [{ ...touchedCase.t2.seeded.operational_cases[0], next_action_at: "now" }];
  assert.ok(failing(touchedCase).includes("no other row of the seeded Case changed: Case, facts, subjects, timeline, approvals, notifications"));
});

t("RS2-3 fails when Portfolio-only state appears, or the need did not exit", () => {
  const presentationMoved = honestRun();
  presentationMoved.t2.presentation = [{ ...advisorRow, pinned: true }];
  assert.ok(failing(presentationMoved).includes("no Portfolio-only business state: nothing outside the seeded Case and no presentation row changed"));

  const stillAsked = honestRun();
  stillAsked.projected.t2 = { ...stillAsked.projected.t2, predicates: ["blocked_on_human", "due_commitment"] };
  assert.ok(failing(stillAsked).includes("the need exits: the ask is no longer a must-surface item; the due commitment still is"));
});

t("an authority change on the seeded Case fails the session boundary", () => {
  const changed = honestRun();
  changed.t2.seeded.operational_cases = [{ ...changed.t2.seeded.operational_cases[0], runtime_authority: "gu_os" }];
  const labels = failing(changed);
  assert.ok(labels.includes("no authority change and no write outside the seeded Case across the whole session (T0 → T2)"));
});

console.log(`portfolio-evidence selftest ok — ${passed} checks passed`);
