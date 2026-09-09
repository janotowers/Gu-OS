// Smoke test for the SL-4 hosted verifier's I/O — the half that
// `supervisor-evidence.selftest.ts` deliberately does NOT cover.
//
// WHY THIS EXISTS, CONCRETELY
//
// SL-3's Done record says its first hosted run "is not committed because it
// recorded the model as `"default (configuration)"`" — a verifier defect, found
// only after the run, that cost a repeat. Here a repeat is far more expensive
// than there: the seed and wake phases are what accumulate the multi-day
// posture history SA-4.3 needs, so a typo in a column name or a wrong filter
// does not cost a re-run, it costs a DAY. And the staging environment's
// required-reviewer rule means every hosted attempt also spends a human
// approval.
//
// So the phases are driven here against the in-memory fake, with a stubbed
// judge, before anyone is asked to approve anything. What this proves is
// narrow and worth saying exactly: that the verifier's reads, writes, filters
// and evidence assembly are internally consistent and produce an artifact the
// evaluator accepts. It proves NOTHING about PostgreSQL, about PostgREST's own
// filter semantics, or about the multi-day behavior itself — the fake cannot
// speak to any of those, and the hosted run remains the only evidence for
// SA-4.3.
import assert from "node:assert/strict";
import type { DbClient } from "@agents/db";
import { createFakeDb, type FakeDb } from "../apps/web/src/lib/relationship-testing/fake-db";
import type {
  NextWorkJudge,
  NextWorkProposal,
} from "../apps/web/src/lib/relationship-supervisor";
import {
  phaseSeed,
  phaseVerify,
  phaseWake,
  REQUIRED_DISTINCT_DAYS,
  SCENARIOS,
  type RunContext,
} from "./verify-supervisor";

const ORG = "11111111-1111-1111-1111-111111111111";
const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CASE_TYPE_ID = "ct-1";
const DEFINITION_ID = "def-1";
const RUN = "smoke-run";

let passed = 0;
async function t(label: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function harness(): FakeDb {
  return createFakeDb({
    tables: {
      organization_feature_flags: [
        {
          id: "f1",
          organization_id: ORG,
          flag_key: "relationship_ops",
          enabled: true,
          value_text: null,
        },
        {
          id: "f2",
          organization_id: ORG,
          flag_key: "relationship_admission_mode",
          enabled: true,
          value_text: "shadow",
        },
      ],
      operational_cases: [],
      operational_case_events: [],
      case_facts: [],
      case_subjects: [],
      work_items: [],
      work_item_events: [],
      work_item_dependencies: [],
      workflow_definitions: [
        {
          id: DEFINITION_ID,
          owner_scope: "global",
          user_id: null,
          case_type: "lead_opportunity",
          version: 1,
          status: "published",
        },
      ],
    },
    defaults: {
      case_facts: {
        superseded_by: null,
        subject_id: null,
        source_ref: null,
        confidence: null,
      },
      case_subjects: { label: null, source_ref: null, created_by_user_id: null },
      operational_cases: { runtime_authority: null },
      work_items: { status: "todo" },
    },
    uniqueIndexes: [
      {
        table: "operational_case_events",
        columns: ["case_id", "payload_jsonb->>wake_key"],
        where: (row) =>
          (row.payload_jsonb as Record<string, unknown> | undefined)?.kind ===
          "supervisor_reconsidered",
      },
      { table: "work_items", columns: ["case_id", "idempotency_key"] },
    ],
  });
}

const QUIET: NextWorkProposal = {
  posture: "no_op",
  diagnosis: "Nothing new has arrived since the last exchange.",
  rationale: "No useful work exists right now; the Case stays wakeable.",
  insufficient_evidence: false,
  capability_gap: null,
  proposed_work: [],
  commitments: [],
  reconsider_in_hours: 24,
};

const WITH_COMMITMENT: NextWorkProposal = {
  ...QUIET,
  commitments: [
    {
      expected_outcome: "Enviar la comparacion de las dos casas",
      actor: "advisor",
      due_at: "2026-09-12T17:00:00.000Z",
      due_stated: true,
      key: "send_comparison",
    },
  ],
};

function judgeFor(scenarioId: string): NextWorkJudge {
  return {
    modelId: null,
    async propose() {
      return scenarioId === "commitment-bearing-opportunity" ? WITH_COMMITMENT : QUIET;
    },
  };
}

/**
 * A judge that answers per Case, the way the real one does.
 *
 * The verifier drives every controlled Case in one wake pass, so a single fixed
 * proposal would leave the commitment scenario untested.
 */
function multiJudge(fake: FakeDb): NextWorkJudge {
  return {
    modelId: null,
    async propose(input) {
      const scenario = SCENARIOS.find((s) =>
        input.recentMessages.length > 0
          ? s.recentMessages[0] === input.recentMessages[0]
          : false
      );
      void fake;
      return judgeFor(scenario?.id ?? "quiescent-opportunity").propose(input);
    },
  };
}

/**
 * Re-labels the events a wake produced as if they had happened on `day`.
 *
 * Both halves are needed and neither is optional. `created_at` is what the
 * evaluator counts days and elapsed span from. The `wake_key` has to move too,
 * because `phaseWake` derives it from TODAY's real UTC date — so without this,
 * every subsequent call in one test process would collide with the first and
 * coalesce. That collision is the production guarantee working exactly as
 * intended, which is why the date is NOT injectable into the phase: an operator
 * able to pass three dates could manufacture three days in one minute.
 *
 * It is also the precise limit of this smoke test, and the reason the hosted
 * run remains the only evidence for SA-4.3: nothing here proves elapsed time,
 * it only proves the verifier reads and assembles what elapsed time would
 * produce.
 */
function relabelAsDay(fake: FakeDb, from: number, day: string): void {
  for (const row of fake.tables.operational_case_events.slice(from)) {
    row.created_at = `${day}T12:00:00.000Z`;
    const payload = row.payload_jsonb as Record<string, unknown>;
    if (typeof payload.wake_key === "string") {
      payload.wake_key = `scheduled:${day}`;
    }
  }
}

/**
 * A UTC date `n` days before today.
 *
 * Deliberately never today's date: `phaseWake` keys on today, so a fixture that
 * re-labelled a wake as today would collide with the very next call and
 * coalesce — which is what happens in production, correctly, and is not what
 * this test is trying to exercise.
 */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log("\nthe three phases, driven end to end against the fake");
  const [DAY_1, DAY_2, DAY_3] = [daysAgo(3), daysAgo(2), daysAgo(1)];

  const fake = harness();
  const ctx: RunContext = {
    db: fake.client as DbClient,
    organizationId: ORG,
    ownerUserId: OWNER,
    runLabel: RUN,
  };

  await t("seed creates one controlled Case per scenario, stamped and scoped", async () => {
    await phaseSeed(ctx, CASE_TYPE_ID, DEFINITION_ID, 1);
    assert.equal(fake.tables.operational_cases.length, SCENARIOS.length);
    for (const row of fake.tables.operational_cases) {
      const context = row.context_jsonb as Record<string, unknown>;
      assert.equal(row.organization_id, ORG);
      assert.equal(row.case_type, "lead_opportunity");
      assert.equal(
        context.scenario_kind,
        "sl4_controlled",
        "a controlled Case must never be mistakable for an admitted lead"
      );
      assert.equal(context.sl4_run, RUN);
      assert.equal(
        row.runtime_authority,
        null,
        "shadow acquires no runtime authority at creation (ADR-107)"
      );
    }
    // Two facts per Case: the objective and the viability.
    assert.equal(fake.tables.case_facts.length, SCENARIOS.length * 2);
  });

  await t("seeding the same run twice is refused, not silently doubled", async () => {
    await assert.rejects(
      () => phaseSeed(ctx, CASE_TYPE_ID, DEFINITION_ID, 1),
      /already has/,
      "a second seed would halve the day span of each history"
    );
  });

  let dayOneFrom = 0;

  await t("wake records one reconsideration per Case, per day", async () => {
    dayOneFrom = fake.tables.operational_case_events.length;
    await phaseWake(ctx, multiJudge(fake));
    const claims = fake.tables.operational_case_events.filter(
      (r) =>
        (r.payload_jsonb as Record<string, unknown>)?.kind === "supervisor_reconsidered"
    );
    assert.equal(claims.length, SCENARIOS.length);
    for (const claim of claims) {
      const payload = claim.payload_jsonb as Record<string, unknown>;
      assert.equal(payload.stage, "shadow");
      assert.ok(payload.rationale, "every posture is attributable");
      assert.ok(payload.next_action_at, "and leaves a re-entry path");
    }
  });

  await t("a second wake on the SAME day coalesces and creates nothing", async () => {
    const eventsBefore = fake.tables.operational_case_events.length;
    const subjectsBefore = fake.tables.case_subjects.length;
    const workBefore = fake.tables.work_items.length;

    // The wake key is the UTC date, so this is a genuine redelivery (SA-4.6) —
    // and it is what stops repeated runs inflating the day span.
    await phaseWake(ctx, multiJudge(fake));

    assert.equal(fake.tables.operational_case_events.length, eventsBefore);
    assert.equal(fake.tables.case_subjects.length, subjectsBefore);
    assert.equal(fake.tables.work_items.length, workBefore);
  });

  await t("the commitment scenario recorded a commitment subject", async () => {
    assert.equal(fake.tables.case_subjects.length, 1);
    assert.equal(fake.tables.case_subjects[0].subject_kind, "commitment");
    const keys = fake.tables.case_facts
      .filter((f) => f.subject_id !== null)
      .map((f) => String(f.fact_key))
      .sort();
    assert.deepEqual(keys, [
      "commitment.actor",
      "commitment.due",
      "commitment.expected_outcome",
      "commitment.status",
    ]);
  });

  await t("verify FAILS on a one-day history — the assertion is load-bearing", async () => {
    relabelAsDay(fake, dayOneFrom, DAY_1);
    const ok = await phaseVerify(ctx, undefined);
    assert.equal(
      ok,
      false,
      `one day cannot satisfy a ${REQUIRED_DISTINCT_DAYS}-day requirement`
    );
  });

  await t("verify passes once the history genuinely spans the required days", async () => {
    // Two more days of wakes. The Case row's own wake time is advanced by each
    // reconsideration, so it is reset the way real elapsed time would.
    for (const day of [DAY_2, DAY_3]) {
      for (const row of fake.tables.operational_cases) row.next_action_at = null;
      const before = fake.tables.operational_case_events.length;
      await phaseWake(ctx, multiJudge(fake));
      relabelAsDay(fake, before, day);
    }

    const claims = fake.tables.operational_case_events.filter(
      (r) =>
        (r.payload_jsonb as Record<string, unknown>)?.kind === "supervisor_reconsidered"
    );
    assert.equal(claims.length, SCENARIOS.length * 3, "three days per Case");

    const ok = await phaseVerify(ctx, undefined);
    assert.equal(ok, true, "the verifier's own evidence assembly must pass a good run");
  });

  await t("the artifact is written with digests, never raw identifiers", async () => {
    // os.tmpdir(), not the working directory: CI runs on Linux where TEMP is
    // unset, and a stray artifact in the repo root would show up in git status.
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const artifactPath = join(tmpdir(), "sl4-smoke-artifact.json");
    await phaseVerify(ctx, artifactPath);
    const { readFileSync, rmSync } = await import("node:fs");
    const raw = readFileSync(artifactPath, "utf8");
    rmSync(artifactPath, { force: true });

    const artifact = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(artifact.passed, true);
    assert.equal(artifact.slice, "SL-4");
    assert.equal(artifact.legacySourceReads, 0);
    assert.equal(artifact.legacySourceWrites, 0);
    assert.ok(String(artifact.organization).startsWith("sha256:"));

    // The whole document must not contain a literal id from the run.
    for (const row of fake.tables.operational_cases) {
      assert.ok(
        !raw.includes(String(row.id)),
        "a raw Case id must never reach the evidence file"
      );
    }
    assert.ok(!raw.includes(ORG), "nor the Organization uuid");
    assert.ok(!raw.includes(OWNER), "nor the owner uuid");
  });

  console.log(`\nverify-supervisor smoke selftest: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
