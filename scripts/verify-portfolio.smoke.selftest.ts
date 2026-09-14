// Smoke test for the SL-7 hosted verifier's I/O — the half that
// `portfolio-evidence.selftest.ts` deliberately does not cover.
//
// The RS-2 run spends human approvals and the advisor's own time, so a typo in
// a filter or a mis-assembled checkpoint must fail HERE, before anyone is asked
// for anything. The phases are driven against the in-memory fake: seed with the
// real supervisor and the deterministic seed judge, checkpoint, then the
// advisor's session simulated through the SAME library actions the page calls,
// then verify. What this proves is narrow: the verifier's reads, writes and
// evidence assembly are internally consistent and produce an artifact the
// evaluator accepts. It proves nothing about PostgreSQL, RLS or the rendered
// page — the hosted run and the DB-backed suite own those.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createFakeDb } from "../apps/web/src/lib/relationship-testing/fake-db";
import { completePortfolioWork, writePortfolioPresentation } from "../apps/web/src/lib/work-portfolio/actions";
import { loadWorkPortfolio } from "../apps/web/src/lib/work-portfolio/load";
import { phaseCheckpoint, phaseSeed, phaseVerify, type SeedManifest } from "./verify-portfolio";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const ADVISOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_CASE = "cccccccc-0000-0000-0000-00000000000b";

let passed = 0;
async function t(label: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function harness() {
  return createFakeDb({
    tables: {
      organizations: [
        { id: ORG, name: "Pilot", status: "active" },
        { id: OTHER_ORG, name: "Other", status: "active" },
      ],
      organization_memberships: [
        { id: "m1", organization_id: ORG, user_id: ADVISOR, role: "advisor", status: "active" },
        { id: "m2", organization_id: ORG, user_id: OWNER, role: "owner", status: "active" },
      ],
      organization_feature_flags: [
        { id: "f1", organization_id: ORG, flag_key: "relationship_ops", enabled: true, value_text: null },
        { id: "f2", organization_id: ORG, flag_key: "relationship_admission_mode", enabled: true, value_text: "shadow" },
      ],
      operational_case_types: [
        { id: "ct-1", case_type: "lead_opportunity", user_id: null, default_skill_slug: "lead-opportunity-supervisor" },
      ],
      workflow_definitions: [
        { id: "def-1", owner_scope: "global", user_id: null, case_type: "lead_opportunity", version: 1, status: "published" },
      ],
      operational_cases: [
        { id: OTHER_CASE, user_id: "someone", organization_id: OTHER_ORG, case_type: "gate_a_fixture", status: "active", version: 0 },
      ],
      operational_case_events: [],
      case_facts: [],
      case_subjects: [],
      work_items: [],
      work_item_events: [],
      work_item_dependencies: [],
      work_item_attempts: [],
      portfolio_presentation_state: [],
    },
    defaults: {
      case_facts: { superseded_by: null, subject_id: null, source_ref: null, confidence: null },
      case_subjects: { label: null, source_ref: null, created_by_user_id: null },
      operational_cases: { runtime_authority: null },
      // The column defaults the Work Plane's claim CAS reads back. The fake
      // never sees a DEFAULT clause, and an undefined version would make every
      // compare-and-set miss for a reason unrelated to the code under test.
      work_items: {
        status: "todo",
        version: 1,
        attempt_count: 0,
        current_attempt_id: null,
        not_before: null,
        blocked_reason: null,
        result_jsonb: null,
      },
    },
    uniqueIndexes: [
      {
        table: "operational_case_events",
        columns: ["case_id", "payload_jsonb->>wake_key"],
        where: (row) => (row.payload_jsonb as Record<string, unknown> | undefined)?.kind === "supervisor_reconsidered",
      },
      { table: "work_items", columns: ["case_id", "idempotency_key"] },
    ],
  });
}

async function main(): Promise<void> {
  console.log("verify-portfolio smoke selftest (R1 SL-7)");
  const dir = mkdtempSync(path.join(tmpdir(), "sl7-smoke-"));
  const fake = harness();
  const db = fake.client;
  const file = (name: string) => path.join(dir, name);
  let seed!: SeedManifest;

  await t("seed: one controlled Case, under legacy authority, with an open ask and a due advisor commitment", async () => {
    await phaseSeed(db, { organizationId: ORG, advisorUserId: ADVISOR, run: "smoke", out: file("seed.json") });
    seed = JSON.parse(readFileSync(file("seed.json"), "utf8")) as SeedManifest;
    const opCase = fake.tables.operational_cases.find((c) => c.id === seed.caseId)!;
    assert.equal(opCase.runtime_authority, "legacy");
    assert.equal(opCase.assigned_to_user_id, ADVISOR);
    const reconsidered = fake.tables.operational_case_events.find(
      (e) => (e.payload_jsonb as Record<string, unknown>).kind === "supervisor_reconsidered"
    )!;
    assert.equal((reconsidered.payload_jsonb as Record<string, unknown>).model_id, null, "a stub never reads as a model");
    await assert.rejects(
      phaseSeed(db, { organizationId: ORG, advisorUserId: ADVISOR, run: "smoke", out: file("seed2.json") }),
      /already has a controlled Case/
    );
  });

  await t("checkpoint → the advisor's session through the page's own actions → verify: every check passes", async () => {
    await phaseCheckpoint(db, seed, "t0", file("t0.json"));
    const captureOf = async () => {
      const result = await loadWorkPortfolio({ serviceDb: db, userDb: db, actorUserId: ADVISOR, organizationId: ORG, now: new Date() });
      assert.equal(result.status, "ok");
      return result.status === "ok" ? result.portfolio : null;
    };
    const before = await captureOf();
    writeFileSync(file("my-work.txt"), JSON.stringify(before?.myWork));
    writeFileSync(file("organization-work.txt"), JSON.stringify(before?.organizationWork));

    for (const change of [{ kind: "snooze" as const, days: 14 }, { kind: "hide" as const }]) {
      const r = await writePortfolioPresentation({ serviceDb: db, userDb: db, actorUserId: ADVISOR, organizationId: ORG, caseId: seed.caseId, change, now: new Date() });
      assert.equal(r.status, "done");
    }
    writeFileSync(file("after-suppress.txt"), JSON.stringify((await captureOf())?.myWork));
    await phaseCheckpoint(db, seed, "t1", file("t1.json"));

    const done = await completePortfolioWork({ serviceDb: db, actorUserId: ADVISOR, organizationId: ORG, caseId: seed.caseId, workItemId: seed.askWorkItemId, answer: "Confirmado: 4.5M", now: new Date() });
    assert.equal(done.status, "done", JSON.stringify(done));
    writeFileSync(file("after-complete.txt"), JSON.stringify((await captureOf())?.myWork));
    await phaseCheckpoint(db, seed, "t2", file("t2.json"));

    // The fake cannot enforce RLS; the hosted probe is the advisor's to run.
    writeFileSync(file("probe.json"), JSON.stringify({ attempted: true, refused: true, code: "42501" }));
    const ok = await phaseVerify(db, seed, {
      checkpoints: [file("t0.json"), file("t1.json"), file("t2.json")],
      captures: dir,
      probe: file("probe.json"),
      json: file("evidence.json"),
    });
    assert.equal(ok, true);
  });

  await t("the evidence artifact carries digests, never a raw identifier", () => {
    const evidence = readFileSync(file("evidence.json"), "utf8");
    for (const raw of [seed.caseId, seed.askWorkItemId, ORG, ADVISOR]) {
      assert.ok(!evidence.includes(raw), `raw id leaked: ${raw.slice(0, 8)}`);
    }
    assert.equal(JSON.parse(evidence).passed, true);
  });

  await t("a session that changed a business row fails verification", async () => {
    const tampered = JSON.parse(readFileSync(file("t1.json"), "utf8"));
    tampered.seeded.operational_cases[0].status = "paused";
    writeFileSync(file("t1-tampered.json"), JSON.stringify(tampered));
    const ok = await phaseVerify(db, seed, {
      checkpoints: [file("t0.json"), file("t1-tampered.json"), file("t2.json")],
      captures: dir,
      probe: file("probe.json"),
      json: undefined,
    });
    assert.equal(ok, false);
  });

  console.log(`verify-portfolio smoke selftest ok — ${passed} checks passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
