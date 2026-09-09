/**
 * Deterministic selftests for the Case Supervisor (R1 SL-4, shadow).
 *
 * These are the deterministic half of the Slice Acceptance Contract. Each group
 * names the assertion it evidences:
 *
 *   SA-4.1   a wake on a viable Opportunity with no useful work produces a
 *            recorded no-op with a coherent wake path and no prospect-facing
 *            work (deterministic half; whether nothing IS useful is the eval's);
 *   SA-4.2   every reconsideration records result and rationale in the posture
 *            taxonomy, inspectable per Case;
 *   SA-4.4   commitments are `case_subjects` with subject-scoped due/status
 *            facts and clean keys — no entity id inside `fact_key`;
 *   SA-4.5   the sequence is reconstructable by replay from durable state
 *            alone, with no dependence on a session or transcript;
 *   SA-4.6   repeated delivery of the same logical wake is durably coalesced,
 *            creating no duplicate durable work;
 *   SA-4.7   an explicit "contact me after X" suppresses outbound before X
 *            while permitting internal work;
 *   SA-4.8   work is recorded `agent_proposed` and NO prospect-facing effect is
 *            reachable — asserted negatively, not assumed;
 *   SA-4.9   posture distribution and no-op rate are observable, with no
 *            threshold asserted anywhere;
 *   SA-4.10  existing unscoped-fact behavior is untouched;
 *   SA-4.11  a failed or unsupported judgment preserves uncertainty and leaves
 *            a recoverable, reconstructable state with a re-entry path;
 *   SA-4.12  reads and writes stay inside one Organization.
 *
 * Plus the shared-baseline flags-off inertness and the S2 §8.21 safe-yield gate.
 *
 * SA-4.3 is deliberately absent: a multi-day posture history is RS-2 hosted
 * evidence over elapsed real time and cannot be produced by a fixture. What is
 * asserted here is the *coherence checker* SA-4.3 is evaluated with, so the
 * hosted run measures something already proven correct.
 *
 * The judge is stubbed throughout — on purpose. These tests assert that
 * deterministic gates hold *whatever* the model says, which is only provable
 * when the test controls what it says. What the model actually judges is the
 * eval set's job, not this file's.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { insertCaseFact, listCaseFacts, type DbClient } from "@agents/db";
import { recordOpenRouterCallUsage, setAiUsageRecorder } from "@agents/agent";
import type { AiUsageEventInput } from "@agents/types";
import {
  COMMITMENT_FACT_KEYS,
  SHADOW_REACHABLE_POSTURES,
  SUPERVISOR_POSTURES,
  SUPERVISOR_RECONSIDERED_EVENT_KIND,
  type SupervisorReconsiderationRecord,
} from "@agents/types";
import { createFakeDb, type FakeDb } from "../relationship-testing/fake-db";
import {
  buildWakeKey,
  checkSafeYield,
  listPostureHistory,
  runSupervisorWake,
  type SupervisorResult,
} from "./supervise";
import {
  DELIVERY_RESTRICTION_FACT_KEY,
  resolveDeliveryEligibility,
} from "./delivery";
import {
  normalizeNextWorkProposal,
  PROPOSABLE_POSTURES,
  buildNextWorkPrompt,
  type NextWorkJudge,
  type NextWorkProposal,
  type SupervisorJudgeInput,
} from "./next-work-judge";
import { checkPostureHistoryCoherence, distinctDaysCovered, reconstructSituation } from "./replay";
import { summarizePostureDistribution } from "./observability";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PILOT_ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const ADVISOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CASE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_CASE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const NOW = new Date("2026-09-08T12:00:00.000Z");

let passed = 0;
async function t(label: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ============================================================
// Fixture
// ============================================================

interface FixtureOverrides {
  relationshipOps?: boolean;
  mode?: string;
  /** Facts seeded on the pilot Case before the wake. */
  facts?: Array<{ key: string; value: unknown; subjectId?: string }>;
  /** A future lease held by another worker, to exercise the busy path. */
  leaseUntil?: string;
}

function baseTables(overrides: FixtureOverrides = {}): Record<string, Array<Record<string, unknown>>> {
  const flags: Array<Record<string, unknown>> = [];
  if (overrides.relationshipOps !== false) {
    flags.push({
      id: "f1",
      organization_id: PILOT_ORG,
      flag_key: "relationship_ops",
      enabled: true,
      value_text: null,
    });
  }
  flags.push({
    id: "f2",
    organization_id: PILOT_ORG,
    flag_key: "relationship_admission_mode",
    enabled: true,
    value_text: overrides.mode ?? "shadow",
  });

  const opportunityCase = {
    id: CASE_ID,
    user_id: ADVISOR,
    organization_id: PILOT_ORG,
    case_type: "lead_opportunity",
    case_type_id: "ct-1",
    status: "active",
    version: 1,
    next_action_at: overrides.leaseUntil ?? null,
    workflow_definition_version: 1,
    workflow_definition_id: "def-1",
    context_jsonb: {},
    current_step: null,
    due_at: null,
    updated_at: NOW.toISOString(),
  };

  const caseFacts: Array<Record<string, unknown>> = [
    {
      id: "fact-objective",
      case_id: CASE_ID,
      user_id: ADVISOR,
      fact_key: "opportunity.objective",
      value_jsonb: { objective: "Comprar casa en Zibatá", category: "buy_home" },
      source_kind: "derived",
      source_ref: null,
      confidence: null,
      superseded_by: null,
      subject_id: null,
      recorded_at: "2026-09-06T10:00:00.000Z",
    },
  ];
  for (const [index, fact] of (overrides.facts ?? []).entries()) {
    caseFacts.push({
      id: `fact-extra-${index}`,
      case_id: CASE_ID,
      user_id: ADVISOR,
      fact_key: fact.key,
      value_jsonb: fact.value,
      source_kind: "derived",
      source_ref: null,
      confidence: null,
      superseded_by: null,
      subject_id: fact.subjectId ?? null,
      recorded_at: "2026-09-07T10:00:00.000Z",
    });
  }

  return {
    organization_feature_flags: flags,
    operational_cases: [
      opportunityCase,
      {
        id: OTHER_CASE_ID,
        user_id: ADVISOR,
        organization_id: OTHER_ORG,
        case_type: "lead_opportunity",
        case_type_id: "ct-1",
        status: "active",
        version: 1,
        next_action_at: null,
        workflow_definition_version: 1,
        workflow_definition_id: "def-1",
        context_jsonb: {},
        current_step: null,
        due_at: null,
        updated_at: NOW.toISOString(),
      },
    ],
    operational_case_events: [],
    case_facts: caseFacts,
    case_subjects: [],
    work_items: [],
    work_item_events: [],
    work_item_dependencies: [],
  };
}

function harness(overrides: FixtureOverrides = {}): FakeDb {
  return createFakeDb({
    tables: baseTables(overrides),
    defaults: {
      case_facts: { superseded_by: null, subject_id: null, source_ref: null, confidence: null },
      case_subjects: { label: null, source_ref: null, created_by_user_id: null },
      operational_case_events: { created_at: NOW.toISOString() },
      work_items: { status: "todo" },
    },
    uniqueIndexes: [
      // uq_operational_case_events_supervisor_wake — M-WAKE-IDENTITY. Declared
      // so the executor's conflict path is exercised; the PostgreSQL race
      // itself is proven in the DB-backed suite, not here.
      {
        table: "operational_case_events",
        columns: ["case_id", "payload_jsonb->>wake_key"],
        where: (row) =>
          (row.payload_jsonb as Record<string, unknown> | undefined)?.kind ===
          SUPERVISOR_RECONSIDERED_EVENT_KIND,
      },
      // Work Plane: partial unique (case_id, idempotency_key).
      { table: "work_items", columns: ["case_id", "idempotency_key"] },
    ],
  });
}

/** A judge that says exactly what a test needs it to say, and counts calls. */
function stubJudge(
  proposal: NextWorkProposal | null,
  seen: SupervisorJudgeInput[] = [],
  modelId: string | null = null
): NextWorkJudge & { calls: SupervisorJudgeInput[] } {
  return {
    calls: seen,
    // Null by default on purpose: a stub is not a model, and a fixture must not
    // be able to make a reconsideration look as though a real one judged it.
    modelId,
    async propose(input) {
      seen.push(input);
      return proposal;
    },
  };
}

const QUIET: NextWorkProposal = {
  posture: "no_op",
  diagnosis: "Prospect has an open objective and nothing new has arrived.",
  rationale: "Nothing useful to do now; the last message was answered.",
  insufficient_evidence: false,
  capability_gap: null,
  proposed_work: [],
  commitments: [],
  reconsider_in_hours: 48,
};

const WORKING: NextWorkProposal = {
  posture: "work",
  diagnosis: "The prospect's budget is unverified and blocks a match.",
  rationale: "Verifying the budget changes what inventory is worth showing.",
  insufficient_evidence: false,
  capability_gap: null,
  proposed_work: [
    { work_type: "verify_budget", purpose: "Confirm the stated budget", durable: true },
  ],
  commitments: [],
  reconsider_in_hours: 24,
};

async function wake(
  db: DbClient,
  judge: NextWorkJudge,
  opts: {
    caseId?: string;
    organizationId?: string;
    wakeKey?: string;
    now?: Date;
  } = {}
): Promise<SupervisorResult> {
  return runSupervisorWake({
    db,
    organizationId: opts.organizationId ?? PILOT_ORG,
    userId: ADVISOR,
    caseId: opts.caseId ?? CASE_ID,
    wake: {
      reason: "scheduled_reconsideration",
      key: opts.wakeKey ?? buildWakeKey.scheduled("2026-09-08T12:00:00.000Z"),
    },
    judge,
    now: opts.now ?? NOW,
  });
}

/**
 * Runs a wake and stamps the events it produced with the simulated instant.
 *
 * `operational_case_events.created_at` defaults to `now()` in PostgreSQL, and
 * two wakes are two separate transactions, so real rows carry distinct
 * timestamps and order correctly. The fake has one static default per table, so
 * without this every event in a multi-wake test would share an instant and
 * "which reconsideration is latest" would be decided by an accident of sort
 * stability rather than by time. Stamping with the injected clock reproduces
 * what the database actually does.
 */
async function wakeAt(
  fake: FakeDb,
  judge: NextWorkJudge,
  when: Date,
  opts: { wakeKey?: string } = {}
): Promise<SupervisorResult> {
  const before = (fake.tables.operational_case_events ?? []).length;
  const result = await wake(fake.client, judge, { ...opts, now: when });
  for (const row of (fake.tables.operational_case_events ?? []).slice(before)) {
    row.created_at = when.toISOString();
  }
  return result;
}

function reconsiderations(fake: FakeDb): SupervisorReconsiderationRecord[] {
  return (fake.tables.operational_case_events ?? [])
    .map((row) => row.payload_jsonb as Record<string, unknown>)
    .filter((p) => p?.kind === SUPERVISOR_RECONSIDERED_EVENT_KIND)
    .map((p) => p as unknown as SupervisorReconsiderationRecord);
}

// ============================================================
// Suite
// ============================================================

async function main(): Promise<void> {
  console.log("\nflags — off ⇒ fully inert");

  await t("with relationship_ops off nothing is read, judged or written", async () => {
    const fake = harness({ relationshipOps: false });
    const judge = stubJudge(QUIET);
    const result = await wake(fake.client, judge);
    assert.equal(result.status, "inert");
    assert.equal(
      result.status === "inert" ? result.reason : null,
      "relationship_ops_disabled"
    );
    assert.equal(judge.calls.length, 0, "no model spend");
    assert.equal(fake.writes.length, 0, "no durable write");
    assert.equal(reconsiderations(fake).length, 0);
  });

  await t("a stage this Slice does not implement is inert, never treated as shadow", async () => {
    const fake = harness({ mode: "assisted" });
    const judge = stubJudge(QUIET);
    const result = await wake(fake.client, judge);
    assert.equal(result.status, "inert");
    assert.equal(
      result.status === "inert" ? result.reason : null,
      "supervisor_mode_disabled"
    );
    assert.equal(judge.calls.length, 0);
    assert.equal(fake.writes.length, 0);
  });

  console.log("\nSA-4.12 tenancy");

  await t("a Case in another Organization is refused, and nothing is judged", async () => {
    const fake = harness();
    const judge = stubJudge(QUIET);
    const result = await wake(fake.client, judge, { caseId: OTHER_CASE_ID });
    assert.equal(result.status, "refused");
    assert.equal(
      result.status === "refused" ? result.reason : null,
      "case_not_in_organization"
    );
    assert.equal(judge.calls.length, 0, "tenancy is resolved before any judgment");
    assert.equal(fake.writes.length, 0);
  });

  await t("a Case that is not a lead Opportunity is refused", async () => {
    const fake = harness();
    fake.tables.operational_cases[0].case_type = "property_optioning";
    const result = await wake(fake.client, stubJudge(QUIET));
    assert.equal(result.status, "refused");
    assert.equal(
      result.status === "refused" ? result.reason : null,
      "case_not_supervisable"
    );
  });

  await t("a Case with a future wake time is refused, not double-supervised", async () => {
    // A lease reaching into the future is the CURRENT convention for "busy".
    // Computed from real wall-clock rather than the injected NOW, because
    // `markCaseProcessing` is a DB helper that reads the real clock — pinning
    // it to a fixture instant would make the test pass or fail by calendar.
    //
    // ONE reason covers two situations, deliberately. A future `next_action_at`
    // means both "another worker holds this" and "its own scheduled
    // reconsideration has not arrived yet": the CURRENT kernel uses one column
    // for the lease and for the next wake, and a five-minute lease is
    // byte-identical to a five-minute reconsideration. Reporting two reasons
    // was tried against the hosted run and reverted — the guess would be wrong
    // every time real contention occurred. The verifier reports how far out the
    // wake sits and lets the operator read it.
    const fake = harness({
      leaseUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const judge = stubJudge(QUIET);
    const result = await wake(fake.client, judge);
    assert.equal(result.status, "refused");
    assert.equal(result.status === "refused" ? result.reason : null, "case_busy");
    assert.equal(judge.calls.length, 0, "no model spend on a Case we cannot lease");
    assert.equal(reconsiderations(fake).length, 0);
    assert.equal(fake.tables.work_items.length, 0, "and nothing durable");
  });

  console.log("\nSA-4.1 / SA-4.2 deliberate no-op, recorded with rationale");

  await t("a quiet wake records a no-op with a rationale and a wake path", async () => {
    const fake = harness();
    const result = await wake(fake.client, stubJudge(QUIET));
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;

    assert.equal(result.record.posture, "no_op");
    assert.equal(result.record.yield_posture, "no_useful_work_now");
    assert.ok(result.record.rationale.length > 0, "the posture is attributable");
    assert.equal(result.record.diagnosis, QUIET.diagnosis);
    assert.equal(result.record.uncertainty, null);
    assert.equal(result.record.stage, "shadow");
    assert.equal(
      result.record.next_action_at,
      new Date(NOW.getTime() + 48 * 3_600_000).toISOString(),
      "the wake path honours the judged interval"
    );
  });

  await t("a no-op creates no Work at all — quiet is not busy", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(QUIET));
    assert.equal(fake.tables.work_items.length, 0);
    assert.equal(fake.tables.case_subjects.length, 0);
  });

  await t("the reconsideration is inspectable per Case on the timeline", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(QUIET));
    const records = reconsiderations(fake);
    assert.equal(records.length, 1);
    assert.equal(records[0].wake_reason, "scheduled_reconsideration");
    assert.ok(records[0].wake_key.startsWith("scheduled:"));
  });

  await t("the Case's own wake time is advanced to the recorded re-entry path", async () => {
    const fake = harness();
    const result = await wake(fake.client, stubJudge(QUIET));
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    assert.equal(
      fake.tables.operational_cases[0].next_action_at,
      result.record.next_action_at,
      "the row the runner wakes on agrees with the record"
    );
  });

  console.log("\nSA-4.8 shadow inertness — asserted, not assumed");

  await t("no prospect-facing effect path exists in this module's source", async () => {
    // A negative assertion over the source, following SL-3's precedent for
    // "no code path performs X". Cheap, and it fails the moment somebody adds
    // a send to a Slice whose entire premise is that it cannot.
    const files = [
      "supervise.ts",
      "commitments.ts",
      "delivery.ts",
      "replay.ts",
      "observability.ts",
      "next-work-judge.ts",
      "index.ts",
    ];
    const forbidden = [
      "send_prospect_message",
      "sendProspectMessage",
      "external_effect_operations",
      "sendWhatsApp",
      "runtime_authority",
      "bypass_bot",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      // Strip comments: the prose deliberately names what this Slice must not
      // do, and matching on that would make the assertion about wording.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const needle of forbidden) {
        assert.ok(
          !code.includes(needle),
          `${file} must not reference ${needle} in code`
        );
      }
    }
  });

  await t("the model cannot even express an effect posture", async () => {
    // Structural, not instructional. The four effect/authority postures are
    // absent from the proposable schema, so a model that wanted to send has no
    // field to say so in.
    for (const posture of ["act", "act_and_inform", "prepare_and_approval", "human_as_executor", "human_takeover_support"]) {
      assert.ok(
        !(PROPOSABLE_POSTURES as readonly string[]).includes(posture),
        `${posture} must not be proposable in the shadow stage`
      );
      assert.ok(
        !(SHADOW_REACHABLE_POSTURES as readonly string[]).includes(posture),
        `${posture} must not be shadow-reachable`
      );
    }
    // And the full taxonomy still carries them, so a later Slice is not
    // introducing "new" product behavior when it reaches one.
    assert.ok((SUPERVISOR_POSTURES as readonly string[]).includes("act"));
  });

  await t("durable work is created as agent_proposed, never any other origin", async () => {
    const fake = harness();
    const result = await wake(fake.client, stubJudge(WORKING));
    assert.equal(result.status, "reconsidered");
    assert.equal(fake.tables.work_items.length, 1);
    assert.equal(fake.tables.work_items[0].origin, "agent_proposed");
    assert.equal(fake.tables.work_items[0].status, "todo");
    if (result.status === "reconsidered") {
      assert.deepEqual(result.record.proposed_work_ids, [
        fake.tables.work_items[0].id,
      ]);
      assert.equal(result.record.yield_posture, "work_underway");
    }
  });

  await t("work that duplicates an open item is refused, not created twice", async () => {
    // Deterministic, not judged. The judge is shown the open Work and told not
    // to duplicate it; this is what makes the outcome certain when it does
    // anyway (S2 §8.16, EC-26, AC-38; Methodology §13).
    const fake = harness();
    fake.tables.work_items.push({
      id: "existing-work",
      case_id: CASE_ID,
      user_id: ADVISOR,
      work_type: "verify_budget",
      status: "todo",
      origin: "agent_proposed",
      idempotency_key: "earlier:verify_budget",
      priority: 100,
      created_at: "2026-09-07T00:00:00.000Z",
    });

    const result = await wake(fake.client, stubJudge(WORKING));
    assert.equal(result.status, "reconsidered");
    assert.equal(
      fake.tables.work_items.length,
      1,
      "the open item stands; no second one is created"
    );
    if (result.status === "reconsidered") {
      assert.deepEqual(result.record.proposed_work_ids, []);
      assert.equal(
        result.record.yield_posture,
        "work_underway",
        "the posture is still work — the work exists, it just already existed"
      );
    }
  });

  await t("a completed item of the same type does not block new work", async () => {
    // The guard is about work in flight. Work that finished is history, and
    // refusing to ever repeat it would turn a duplicate guard into a
    // once-per-Case rule nothing approves.
    const fake = harness();
    fake.tables.work_items.push({
      id: "done-work",
      case_id: CASE_ID,
      user_id: ADVISOR,
      work_type: "verify_budget",
      status: "done",
      origin: "agent_proposed",
      idempotency_key: "earlier:verify_budget",
      priority: 100,
      created_at: "2026-09-07T00:00:00.000Z",
    });
    await wake(fake.client, stubJudge(WORKING));
    assert.equal(fake.tables.work_items.length, 2);
  });

  await t("non-durable proposed work creates no Work Item (S2 §8.16)", async () => {
    const fake = harness();
    await wake(
      fake.client,
      stubJudge({
        ...WORKING,
        proposed_work: [
          { work_type: "reread_thread", purpose: "Re-read the thread", durable: false },
        ],
      })
    );
    assert.equal(
      fake.tables.work_items.length,
      0,
      "not every thought becomes a Work Item"
    );
  });

  console.log("\nSA-4.6 duplicate wake coalescing");

  await t("the same wake twice produces one reconsideration and one Work Item", async () => {
    const fake = harness();
    const first = await wake(fake.client, stubJudge(WORKING));
    assert.equal(first.status, "reconsidered");

    // A redelivery of the SAME logical wake. The Case row's version moved, so
    // re-read it the way a runner would.
    fake.tables.operational_cases[0].next_action_at = null;
    const second = await wake(fake.client, stubJudge(WORKING));

    assert.equal(second.status, "already_reconsidered");
    assert.equal(reconsiderations(fake).length, 1, "one reconsideration");
    assert.equal(fake.tables.work_items.length, 1, "no duplicate durable work");
    if (second.status === "already_reconsidered") {
      assert.ok(second.record, "converges on the reconsideration that happened");
      assert.equal(second.record?.posture, "work");
    }
  });

  await t("a DIFFERENT wake on the same Case is a new reconsideration", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(QUIET));
    fake.tables.operational_cases[0].next_action_at = null;
    const second = await wake(fake.client, stubJudge(QUIET), {
      wakeKey: buildWakeKey.scheduled("2026-09-09T12:00:00.000Z"),
    });
    assert.equal(second.status, "reconsidered");
    assert.equal(reconsiderations(fake).length, 2);
  });

  console.log("\nSA-4.7 delivery restrictions (S2 AC-03)");

  await t("before X outbound is blocked and internal work stays permitted", () => {
    const facts = new Map([
      [
        DELIVERY_RESTRICTION_FACT_KEY,
        {
          value_jsonb: {
            opt_out: false,
            not_before: "2026-09-20T00:00:00.000Z",
            basis: "prospect_stated",
            note: "contáctame después del 20",
          },
        },
      ],
    ]);
    const eligibility = resolveDeliveryEligibility({
      currentFacts: facts as never,
      now: NOW,
    });
    assert.equal(eligibility.outboundAllowed, false);
    assert.equal(eligibility.blockedBy, "not_before");
    assert.equal(eligibility.liftsAt, "2026-09-20T00:00:00.000Z");
    assert.equal(eligibility.internalWorkAllowed, true);
  });

  await t("at exactly X the restriction lifts — the boundary instant is inclusive", () => {
    const facts = new Map([
      [
        DELIVERY_RESTRICTION_FACT_KEY,
        {
          value_jsonb: {
            opt_out: false,
            not_before: "2026-09-20T00:00:00.000Z",
            basis: "prospect_stated",
            note: null,
          },
        },
      ],
    ]);
    assert.equal(
      resolveDeliveryEligibility({
        currentFacts: facts as never,
        now: new Date("2026-09-19T23:59:59.999Z"),
      }).outboundAllowed,
      false
    );
    assert.equal(
      resolveDeliveryEligibility({
        currentFacts: facts as never,
        now: new Date("2026-09-20T00:00:00.000Z"),
      }).outboundAllowed,
      true
    );
  });

  await t("an explicit opt-out blocks outbound with no lift time", () => {
    const facts = new Map([
      [
        DELIVERY_RESTRICTION_FACT_KEY,
        { value_jsonb: { opt_out: true, not_before: null, basis: "prospect_stated" } },
      ],
    ]);
    const eligibility = resolveDeliveryEligibility({
      currentFacts: facts as never,
      now: NOW,
    });
    assert.equal(eligibility.outboundAllowed, false);
    assert.equal(eligibility.blockedBy, "opt_out");
    assert.equal(eligibility.liftsAt, null);
    assert.equal(eligibility.internalWorkAllowed, true);
  });

  await t("an unreadable restriction FAILS CLOSED, never back to permitted", () => {
    for (const broken of [{}, { not_before: "not-a-date" }, "garbage", null]) {
      const facts = new Map([
        [DELIVERY_RESTRICTION_FACT_KEY, { value_jsonb: broken }],
      ]);
      assert.equal(
        resolveDeliveryEligibility({ currentFacts: facts as never, now: NOW })
          .outboundAllowed,
        false,
        `unreadable restriction ${JSON.stringify(broken)} must block`
      );
    }
  });

  await t("no restriction at all means outbound is not blocked by THIS gate", () => {
    const eligibility = resolveDeliveryEligibility({
      currentFacts: new Map(),
      now: NOW,
    });
    assert.equal(eligibility.outboundAllowed, true);
    assert.equal(eligibility.blockedBy, null);
  });

  await t("the restriction is never shown to the model", async () => {
    const fake = harness({
      facts: [
        {
          key: DELIVERY_RESTRICTION_FACT_KEY,
          value: {
            opt_out: false,
            not_before: "2026-09-20T00:00:00.000Z",
            basis: "prospect_stated",
            note: "contáctame después del 20",
          },
        },
      ],
    });
    const judge = stubJudge(QUIET);
    await wake(fake.client, judge);
    const prompt = buildNextWorkPrompt(judge.calls[0]);
    assert.ok(
      !prompt.includes("2026-09-20"),
      "a hard bound is enforced, not negotiated with"
    );
    assert.ok(
      prompt.includes("NOT available"),
      "the model is told contact is unavailable, not why"
    );
  });

  await t("internal work still runs while outbound is restricted (AC-03)", async () => {
    const fake = harness({
      facts: [
        {
          key: DELIVERY_RESTRICTION_FACT_KEY,
          value: {
            opt_out: false,
            not_before: "2026-09-20T00:00:00.000Z",
            basis: "prospect_stated",
          },
        },
      ],
    });
    const result = await wake(fake.client, stubJudge(WORKING));
    assert.equal(result.status, "reconsidered");
    assert.equal(fake.tables.work_items.length, 1, "internal work is permitted");
    if (result.status === "reconsidered") {
      assert.equal(result.eligibility.outboundAllowed, false);
      assert.equal(result.eligibility.internalWorkAllowed, true);
    }
  });

  await t("a wait caused by a not-before bound is recorded as waiting on time", async () => {
    const fake = harness({
      facts: [
        {
          key: DELIVERY_RESTRICTION_FACT_KEY,
          value: {
            opt_out: false,
            not_before: "2026-09-20T00:00:00.000Z",
            basis: "prospect_stated",
          },
        },
      ],
    });
    const result = await wake(
      fake.client,
      stubJudge({ ...QUIET, posture: "wait" })
    );
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    assert.equal(result.record.yield_posture, "waiting_until_time");
  });

  console.log("\nSA-4.4 commitments as subjects");

  const WITH_COMMITMENTS: NextWorkProposal = {
    ...QUIET,
    commitments: [
      {
        expected_outcome: "Send the comparison of three Zibatá houses",
        actor: "gu",
        due_at: "2026-09-11T17:00:00.000Z",
        due_stated: true,
        key: "send_comparison",
      },
      {
        expected_outcome: "Prospect confirms the visit window",
        actor: "prospect",
        due_at: "2026-09-12T17:00:00.000Z",
        due_stated: false,
        key: "confirm_visit_window",
      },
    ],
  };

  await t("commitments become case_subjects with clean, id-free fact keys", async () => {
    const fake = harness();
    const result = await wake(fake.client, stubJudge(WITH_COMMITMENTS));
    assert.equal(result.status, "reconsidered");

    assert.equal(fake.tables.case_subjects.length, 2);
    for (const subject of fake.tables.case_subjects) {
      assert.equal(subject.subject_kind, "commitment");
      assert.equal(subject.case_id, CASE_ID);
      assert.equal(subject.actor_kind, "agent");
    }

    const subjectFacts = fake.tables.case_facts.filter((f) => f.subject_id !== null);
    assert.equal(subjectFacts.length, 8, "4 facts per commitment");
    for (const fact of subjectFacts) {
      const key = String(fact.fact_key);
      assert.ok(
        key.startsWith("commitment."),
        `unexpected subject fact key ${key}`
      );
      assert.equal(
        key.split(".").length,
        2,
        `fact_key ${key} must not carry an entity id`
      );
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(key),
        `fact_key ${key} must contain no uuid`
      );
    }
  });

  await t("two commitments' commitment.due facts do not collapse into one", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(WITH_COMMITMENTS));
    const dues = fake.tables.case_facts.filter(
      (f) => f.fact_key === COMMITMENT_FACT_KEYS.due && f.superseded_by === null
    );
    assert.equal(dues.length, 2, "one current due per Commitment");
    assert.equal(
      new Set(dues.map((f) => f.subject_id)).size,
      2,
      "each belongs to its own subject"
    );
  });

  await t("a commitment starts open with NO evidence, never fulfilled", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(WITH_COMMITMENTS));
    const statuses = fake.tables.case_facts.filter(
      (f) => f.fact_key === COMMITMENT_FACT_KEYS.status
    );
    assert.equal(statuses.length, 2);
    for (const fact of statuses) {
      const value = fact.value_jsonb as { status: string; evidence_refs: string[] };
      assert.equal(value.status, "open");
      assert.deepEqual(value.evidence_refs, []);
    }
  });

  await t("due provenance distinguishes a stated deadline from an inferred one", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(WITH_COMMITMENTS));
    const bases = fake.tables.case_facts
      .filter((f) => f.fact_key === COMMITMENT_FACT_KEYS.due)
      .map((f) => (f.value_jsonb as { basis: string }).basis)
      .sort();
    assert.deepEqual(bases, ["inferred_from_context", "stated"]);
  });

  await t("an already-tracked commitment is not re-created on the next wake", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(WITH_COMMITMENTS));
    assert.equal(fake.tables.case_subjects.length, 2);

    fake.tables.operational_cases[0].next_action_at = null;
    const second = await wake(fake.client, stubJudge(WITH_COMMITMENTS), {
      wakeKey: buildWakeKey.scheduled("2026-09-09T12:00:00.000Z"),
    });
    assert.equal(second.status, "reconsidered");
    assert.equal(
      fake.tables.case_subjects.length,
      2,
      "the same promise is one commitment, not two"
    );
    if (second.status === "reconsidered") {
      assert.deepEqual(
        second.commitments.map((c) => c.created),
        [false, false]
      );
    }
  });

  await t("an open commitment reaches the judge; nothing else about it is invented", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(WITH_COMMITMENTS));
    fake.tables.operational_cases[0].next_action_at = null;
    const judge = stubJudge(QUIET);
    await wake(fake.client, judge, {
      wakeKey: buildWakeKey.scheduled("2026-09-09T12:00:00.000Z"),
    });
    const summary = judge.calls[0].openCommitments;
    assert.equal(summary.length, 2);
    assert.ok(summary.some((line) => line.includes("Send the comparison")));
    assert.ok(summary.some((line) => line.includes("due: 2026-09-11")));
  });

  console.log("\nSA-4.11 preserved uncertainty — no manufactured certainty");

  await t("no judgment at all is recorded as such, with a re-entry path", async () => {
    const fake = harness();
    const result = await wake(fake.client, stubJudge(null));
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;

    assert.equal(result.record.uncertainty, "no_judgment_available");
    assert.equal(result.record.posture, "no_op");
    assert.equal(result.record.model_id, null);
    assert.ok(result.record.next_action_at, "responsibility is not stranded");
    assert.equal(fake.tables.work_items.length, 0, "no unsupported work");
    assert.equal(fake.tables.case_subjects.length, 0);
  });

  await t("insufficient evidence produces a no-op, not a confident posture", async () => {
    const fake = harness();
    const result = await wake(
      fake.client,
      stubJudge({
        ...WORKING,
        insufficient_evidence: true,
      })
    );
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    assert.equal(result.record.uncertainty, "insufficient_evidence");
    assert.equal(result.record.posture, "no_op");
    assert.equal(
      fake.tables.work_items.length,
      0,
      "work proposed on evidence the model itself called thin is not created"
    );
  });

  await t("a commitment survives an inconclusive judgment", async () => {
    // The promise was observed in the evidence. Dropping it because the
    // situational judgment was unsure would lose it for an unrelated reason.
    const fake = harness();
    await wake(
      fake.client,
      stubJudge({ ...WITH_COMMITMENTS, insufficient_evidence: true })
    );
    assert.equal(fake.tables.case_subjects.length, 2);
  });

  await t("a capability gap is exposed as a human ask, never worked around", async () => {
    const fake = harness();
    const result = await wake(
      fake.client,
      stubJudge({ ...WORKING, capability_gap: "authorized inventory search" })
    );
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    assert.equal(result.record.uncertainty, "capability_gap");
    assert.equal(result.record.posture, "targeted_human_input");
    assert.equal(result.record.yield_posture, "waiting_for_human_input");
    assert.equal(fake.tables.work_items.length, 0);
    assert.ok(result.record.rationale.includes("authorized inventory search"));
  });

  await t("an incoherent proposal is no judgment, never half-applied", async () => {
    // A quiet posture carrying work, or an active posture carrying none, is
    // not something to silently repair — repairing it would misreport what the
    // model said.
    assert.equal(
      normalizeNextWorkProposal({ ...QUIET, proposed_work: WORKING.proposed_work }),
      null
    );
    assert.equal(normalizeNextWorkProposal({ ...WORKING, proposed_work: [] }), null);
    assert.equal(normalizeNextWorkProposal({ posture: "act" }), null);
    assert.equal(normalizeNextWorkProposal("nonsense"), null);
    assert.ok(normalizeNextWorkProposal(QUIET));
  });

  await t("the record names the model that judged — from the judge, not the env", async () => {
    // SL-3 discarded a hosted run over exactly this failure: its verifier read
    // an unset override variable instead of the resolved constant and recorded
    // a model name that said nothing. The resolved id now travels with the
    // judge, so the record cannot be silently blank.
    const fake = harness();
    const result = await wake(
      fake.client,
      stubJudge(QUIET, [], "openai/gpt-5.4-mini")
    );
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    assert.equal(result.record.model_id, "openai/gpt-5.4-mini");
  });

  await t("a stub judge cannot make a reconsideration look model-judged", async () => {
    const fake = harness();
    const result = await wake(fake.client, stubJudge(QUIET));
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    assert.equal(result.record.model_id, null);
  });

  console.log("\nS2 §8.21 safe yield");

  await t("a reconsideration with no re-entry path is refused, not recorded", () => {
    assert.ok(
      checkSafeYield({
        posture: "wait",
        yield_posture: "waiting_for_prospect",
        next_action_at: null,
      })
    );
    assert.equal(
      checkSafeYield({
        posture: "wait",
        yield_posture: "waiting_for_prospect",
        next_action_at: NOW.toISOString(),
      }),
      null
    );
  });

  await t("a posture outside the shadow stage cannot be yielded on", () => {
    assert.ok(
      checkSafeYield({
        posture: "act",
        yield_posture: "work_underway",
        next_action_at: NOW.toISOString(),
      })
    );
  });

  await t("a null reconsideration interval still leaves a wake path", async () => {
    const fake = harness();
    const result = await wake(
      fake.client,
      stubJudge({ ...QUIET, reconsider_in_hours: null })
    );
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    assert.ok(result.record.next_action_at, "EC-39: never dependent on memory");
  });

  await t("an absurd interval is clamped rather than honoured", async () => {
    const fake = harness();
    const result = await wake(
      fake.client,
      stubJudge({ ...QUIET, reconsider_in_hours: 100_000 })
    );
    assert.equal(result.status, "reconsidered");
    if (result.status !== "reconsidered") return;
    const hours =
      (new Date(result.record.next_action_at as string).getTime() - NOW.getTime()) /
      3_600_000;
    assert.equal(hours, 24 * 30);
  });

  console.log("\nSA-4.5 reconstruction from durable state alone");

  await t("a fresh reader rebuilds the situation with no session or transcript", async () => {
    const fake = harness();
    await wakeAt(fake, stubJudge(WITH_COMMITMENTS), NOW);
    fake.tables.operational_cases[0].next_action_at = null;
    await wakeAt(fake, stubJudge(WORKING), new Date("2026-09-09T12:00:00.000Z"), {
      wakeKey: buildWakeKey.scheduled("2026-09-09T12:00:00.000Z"),
    });

    const situation = await reconstructSituation({
      db: fake.client,
      userId: ADVISOR,
      caseId: CASE_ID,
      now: NOW,
    });
    assert.ok(situation);
    if (!situation) return;

    assert.equal(situation.objective, "Comprar casa en Zibatá");
    assert.equal(situation.organizationId, PILOT_ORG);
    assert.equal(situation.commitments.length, 2);
    assert.equal(situation.postureHistory.length, 2);
    assert.equal(situation.work.total, 1);
    assert.equal(situation.waitingOn, "work_underway");
    assert.ok(situation.nextWakeAt, "the meaningful next wake condition survives");
    for (const commitment of situation.commitments) {
      assert.equal(commitment.status, "open");
      assert.ok(commitment.expectedOutcome);
    }
  });

  await t("an interrupted run is visibly unsettled, not silently complete", async () => {
    // The wake claim and the settlement are two durable writes, because the
    // claim has to land BEFORE anything is created and the timeline is
    // append-only. A crash between them must therefore be legible: the wake is
    // claimed, nothing was half-created, and the gap shows rather than being
    // inferred from an absence.
    const fake = harness();
    await wakeAt(fake, stubJudge(WORKING), NOW);
    const settled = fake.tables.operational_case_events.filter(
      (row) =>
        (row.payload_jsonb as Record<string, unknown>)?.kind ===
        "supervisor_reconsideration_settled"
    );
    assert.equal(settled.length, 1);

    // Drop the settlement, as an interrupted run would have left it.
    fake.tables.operational_case_events = fake.tables.operational_case_events.filter(
      (row) => !settled.includes(row)
    );

    const history = await listPostureHistory(fake.client, CASE_ID);
    assert.equal(history.length, 1, "the reconsideration itself survives");
    assert.equal(history[0].settled, false);
    assert.deepEqual(history[0].proposed_work_ids, [], "no outcome is claimed");
    assert.ok(history[0].rationale, "and the judgment made is still readable");
  });

  await t("a settled run reports its outcome from durable state, not memory", async () => {
    const fake = harness();
    const result = await wakeAt(fake, stubJudge(WORKING), NOW);
    assert.equal(result.status, "reconsidered");
    const history = await listPostureHistory(fake.client, CASE_ID);
    assert.equal(history.length, 1);
    assert.equal(history[0].settled, true);
    assert.equal(history[0].yield_posture, "work_underway");
    assert.equal(history[0].proposed_work_ids.length, 1);
    assert.equal(history[0].recorded_at, NOW.toISOString());
  });

  await t("reconstruction takes no session-shaped argument at all", () => {
    // The guarantee is structural: if reconstruction could accept a transcript
    // it would be possible to depend on one. `reconstructSituation` takes a db
    // handle, a user, a case and a clock — nothing else.
    const source = readFileSync(path.join(__dirname, "replay.ts"), "utf8");
    for (const needle of ["session", "transcript", "messages"]) {
      assert.ok(
        !new RegExp(`params\\.[A-Za-z]*${needle}`, "i").test(source),
        `reconstruction must not read a ${needle} parameter`
      );
    }
  });

  await t("the posture history coherence checker catches what it claims to", () => {
    const base: SupervisorReconsiderationRecord = {
      kind: SUPERVISOR_RECONSIDERED_EVENT_KIND,
      v: 1,
      wake_reason: "scheduled_reconsideration",
      wake_key: "scheduled:a",
      posture: "no_op",
      yield_posture: "no_useful_work_now",
      rationale: "nothing useful",
      diagnosis: null,
      uncertainty: null,
      proposed_work_ids: [],
      commitment_subject_ids: [],
      next_action_at: NOW.toISOString(),
      stage: "shadow",
      model_id: null,
      policy_version: null,
    };
    assert.equal(
      checkPostureHistoryCoherence([base, { ...base, wake_key: "scheduled:b" }])
        .coherent,
      true
    );
    assert.equal(
      checkPostureHistoryCoherence([base, base]).coherent,
      false,
      "one wake must not produce two reconsiderations"
    );
    assert.equal(
      checkPostureHistoryCoherence([{ ...base, rationale: "" }]).coherent,
      false,
      "an unattributable posture is not coherent"
    );
    assert.equal(
      checkPostureHistoryCoherence([{ ...base, next_action_at: null }]).coherent,
      false
    );
  });

  await t("multi-day is counted in distinct days, not in wall-clock claims", () => {
    assert.equal(
      distinctDaysCovered([
        "2026-09-08T01:00:00.000Z",
        "2026-09-08T23:00:00.000Z",
      ]),
      1,
      "two reconsiderations minutes or hours apart are ONE day"
    );
    assert.equal(
      distinctDaysCovered([
        "2026-09-08T23:00:00.000Z",
        "2026-09-09T01:00:00.000Z",
        "2026-09-10T01:00:00.000Z",
      ]),
      3
    );
    assert.equal(distinctDaysCovered(["not-a-date"]), 0);
  });

  console.log("\nSA-4.9 observability, with NO threshold");

  await t("posture distribution and no-op rate are observable per Organization", async () => {
    const fake = harness();
    await wakeAt(fake, stubJudge(QUIET), NOW);
    fake.tables.operational_cases[0].next_action_at = null;
    await wakeAt(fake, stubJudge(WORKING), new Date("2026-09-09T12:00:00.000Z"), {
      wakeKey: buildWakeKey.scheduled("2026-09-09T12:00:00.000Z"),
    });

    const distribution = await summarizePostureDistribution({
      db: fake.client,
      organizationId: PILOT_ORG,
    });
    assert.equal(distribution.total, 2);
    assert.equal(distribution.byPosture.no_op, 1);
    assert.equal(distribution.byPosture.work, 1);
    assert.equal(distribution.noAction, 1);
    assert.equal(distribution.noActionRatio, 0.5);
    assert.equal(distribution.uncertain, 0);
    assert.equal(distribution.byWakeReason.scheduled_reconsideration, 2);
  });

  await t("no observations reports null, never a zero that reads as a result", async () => {
    const fake = harness();
    const distribution = await summarizePostureDistribution({
      db: fake.client,
      organizationId: PILOT_ORG,
    });
    assert.equal(distribution.total, 0);
    assert.equal(distribution.noActionRatio, null);
  });

  await t("another Organization's reconsiderations are not counted", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(QUIET));
    const distribution = await summarizePostureDistribution({
      db: fake.client,
      organizationId: OTHER_ORG,
    });
    assert.equal(distribution.total, 0);
  });

  await t("no numeric no-op target is asserted anywhere in the module", () => {
    // SA-4.9 contracts observability precisely because no governing artifact
    // approves a ratio. A threshold appearing here later would be a product
    // decision taken by the development system.
    const source = readFileSync(path.join(__dirname, "observability.ts"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const needle of ["threshold", "target", "acceptableRatio", "maxNoOp"]) {
      assert.ok(!code.includes(needle), `observability must not carry a ${needle}`);
    }
  });

  console.log("\nSA-4.10 existing unscoped-fact behavior is untouched");

  await t("a case-level fact still supersedes only case-level facts", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(WITH_COMMITMENTS));

    // Two subject-scoped `commitment.due` facts exist. Writing a case-level
    // fact of the SAME key must not disturb them, and vice versa.
    await insertCaseFact(fake.client, {
      userId: ADVISOR,
      caseId: CASE_ID,
      factKey: COMMITMENT_FACT_KEYS.due,
      value: { due_at: "2026-01-01T00:00:00.000Z", basis: "stated" },
      sourceKind: "derived",
    });

    const currentSubjectDues = fake.tables.case_facts.filter(
      (f) =>
        f.fact_key === COMMITMENT_FACT_KEYS.due &&
        f.subject_id !== null &&
        f.superseded_by === null
    );
    assert.equal(currentSubjectDues.length, 2, "subject facts are untouched");

    const caseLevel = await listCaseFacts(fake.client, ADVISOR, CASE_ID, {
      factKey: COMMITMENT_FACT_KEYS.due,
    });
    assert.equal(caseLevel.length, 1, "case-level reads see only case-level rows");
    assert.equal(caseLevel[0].subject_id, null);
  });

  await t("the objective fact seeded before this Slice is unchanged", async () => {
    const fake = harness();
    await wake(fake.client, stubJudge(WITH_COMMITMENTS));
    const objective = fake.tables.case_facts.find(
      (f) => f.id === "fact-objective"
    );
    assert.ok(objective);
    assert.equal(objective?.superseded_by, null);
    assert.equal(objective?.subject_id, null);
  });

  console.log("\ncorrelation coverage (shared baseline, from SL-2)");

  await t("the supervisor's model call is correlated to Organization AND Case", async () => {
    const captured: AiUsageEventInput[] = [];
    setAiUsageRecorder((event) => {
      captured.push(event);
    });
    try {
      const fake = harness();
      // A judge that meters exactly the way the production one does. What is
      // under test is the CONTEXT the supervisor binds around it, not the
      // metering call itself.
      const metering: NextWorkJudge = {
        modelId: "openai/gpt-5.4-mini",
        async propose() {
          await recordOpenRouterCallUsage({
            modelId: "openai/gpt-5.4-mini",
            modelRole: "relationship_supervisor_next_work",
            operation: "classification",
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          });
          return QUIET;
        },
      };
      const result = await wake(fake.client, metering);
      assert.equal(result.status, "reconsidered");

      assert.equal(
        captured.length,
        1,
        "the supervisor model call is metered, not dropped for want of a context"
      );
      assert.equal(captured[0].organizationId, PILOT_ORG);
      assert.equal(captured[0].userId, ADVISOR);
      assert.equal(
        captured[0].modelRole,
        "relationship_supervisor_next_work",
        "the supervisor judge is attributable as its own role"
      );
      assert.equal(
        captured[0].operationalCaseId,
        CASE_ID,
        "unlike admission, a reconsideration always has a Case — so it is bound, not left null"
      );
    } finally {
      setAiUsageRecorder(null);
    }
  });

  await t("with flags off there is no model call to correlate", async () => {
    const captured: AiUsageEventInput[] = [];
    setAiUsageRecorder((event) => {
      captured.push(event);
    });
    try {
      const fake = harness({ relationshipOps: false });
      await wake(fake.client, stubJudge(QUIET));
      assert.equal(captured.length, 0, "flags off ⇒ no model spend at all");
    } finally {
      setAiUsageRecorder(null);
    }
  });

  console.log("\neval set");

  await t("the eval set is well formed and its bar is stated", () => {
    const raw = readFileSync(
      path.join(__dirname, "eval", "supervisor-scenarios.json"),
      "utf8"
    );
    const suite = JSON.parse(raw) as {
      failure_rate_bar: number;
      fabricated_work_bar: number;
      bar_rationale: string;
      recorded: Record<string, unknown>;
      scenarios: Array<Record<string, unknown>>;
    };
    // Same flat shape SL-3's set uses, so the two eval contracts stay readable
    // side by side.
    assert.equal(
      typeof suite.failure_rate_bar,
      "number",
      "a bar must be frozen before the first run (§14.1)"
    );
    assert.equal(
      suite.fabricated_work_bar,
      0,
      "manufactured work is the failure this Slice exists to measure"
    );
    assert.ok(suite.bar_rationale.length > 0, "the bar must say why it is that number");
    assert.ok(
      String(suite.recorded.barEstablishedBy).includes("BEFORE"),
      "the record must state that the bar predates the first run"
    );
    assert.ok(suite.scenarios.length >= 12, "a representative set, not a token one");

    const ids = new Set<string>();
    for (const scenario of suite.scenarios) {
      assert.equal(typeof scenario.id, "string");
      assert.ok(!ids.has(scenario.id as string), `duplicate scenario ${scenario.id}`);
      ids.add(scenario.id as string);
      assert.ok(
        Array.isArray(scenario.acceptable_postures) &&
          (scenario.acceptable_postures as string[]).length > 0,
        `${scenario.id} states no acceptable posture`
      );
      for (const posture of scenario.acceptable_postures as string[]) {
        assert.ok(
          (PROPOSABLE_POSTURES as readonly string[]).includes(posture),
          `${scenario.id} expects unproposable posture ${posture}`
        );
      }
      assert.equal(
        typeof scenario.rubric,
        "string",
        `${scenario.id} carries no rationale rubric (S2 §15)`
      );
    }

    // The quality bar S2 names must actually be covered by the set.
    const covered = new Set(
      suite.scenarios.flatMap((s) => (s.covers as string[]) ?? [])
    );
    for (const required of [
      "deliberate_no_op",
      "timer_is_not_action",
      "diagnose_before_act",
      "information_gathering_as_work",
      "loop_stopping",
      "capability_gap",
      "commitment_detection",
      "contact_restriction",
    ]) {
      assert.ok(covered.has(required), `the set does not cover ${required}`);
    }
  });

  console.log(`\nrelationship-supervisor selftest: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
