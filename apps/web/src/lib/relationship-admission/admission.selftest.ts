/**
 * Deterministic selftests for governed admission (R1 SL-2).
 *
 * These are the deterministic half of the Slice Acceptance Contract. Each group
 * names the assertion it evidences:
 *
 *   SA-2.2   an admitted lead materialises exactly one shadow Opportunity Case,
 *            with provenance-bearing admitting facts;
 *   SA-2.3   an ambiguous opener produces NO Case and stays open to
 *            clarification (deterministic half; the semantic half is the eval);
 *   SA-2.4   the same source event twice yields one effective outcome, and the
 *            `dedup_key` collision is observable;
 *   SA-2.5   a platform hard bound beats a permissive policy AND a confident
 *            model judgment;
 *   SA-2.6   a policy-excluded category is not auto-admitted, however confident
 *            the judgment (deterministic half; adversarial fixtures in the eval);
 *   SA-2.7   with no published policy the versioned platform baseline applies
 *            and is attributed; draft policy never becomes authority; invalid
 *            published policy fails closed;
 *   SA-2.8   the Organization binding check precedes every read, and a lead
 *            outside the bound Organization is refused with zero reads;
 *   SA-2.9   with `relationship_ops` off admission is fully inert;
 *   SA-2.10  no prospect-facing effect is reachable from this Slice.
 *
 * Plus the shared-baseline correlation-coverage check (Technical Plan §7 (a)),
 * which applies from SL-2 onward.
 *
 * SA-2.1 is deliberately absent: it is RS-2 hosted evidence against real pilot
 * data and cannot be produced by a fixture.
 *
 * The interpreter is stubbed throughout — on purpose. These tests assert that
 * deterministic gates hold *whatever* the model says, which is only provable
 * when the test controls what it says. What the model actually judges is the
 * eval set's job, not this file's.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimSourceEvent,
  failSourceEvent,
  insertAiUsageEvent,
  insertCaseFact,
  linkAdmittedCase,
  reclaimSourceEvent,
  recordSourceEvent,
  recordSourceEventDecision,
  settleSourceEvent,
  type DbClient,
} from "@agents/db";
import {
  recordOpenRouterCallUsage,
  setAiUsageRecorder,
} from "@agents/agent";
import type { AiUsageEventInput } from "@agents/types";
import {
  PLATFORM_DEFAULT_POLICY_ID,
  buildSourceEventDedupKey,
  type AdmissionProposal,
} from "@agents/types";
import { LegacyReadRefusal } from "../legacy-gateway/errors";
import { runAdmission, applyPolicyToProposal } from "./admit";
import { deriveDedupKey, latestInboundMessage } from "./ingest";
import { createFakeDb, type FakeDb } from "./fake-db";
import { resolveEffectiveAdmissionPolicy, parseAdmissionPolicy } from "./policy";
import {
  ADMISSION_OBJECTIVE_CATEGORIES,
  normalizeProposal,
  type AdmissionInterpreter,
} from "./interpreter";
import type { PlatformHardBoundProbe } from "./hard-bounds";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PILOT_ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const ADVISOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_UID = "owner-uid-0000000000000001";
const PILOT_LEAD = "5215500000001521550000000252155000000003";
const OTHER_ORG_LEAD = "5215500000077521550000000252155000000099";
const CASE_TYPE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DEFINITION_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const GATEWAY_ON = { LEGACY_GATEWAY_ENABLED: "true" } as const;

// ============================================================
// Fixtures
// ============================================================

interface EvalScenario {
  id: string;
  label: string;
  input: {
    message: string | null;
    sourceLabel: string | null;
    originLabel: string | null;
    propertyContext: string | null;
    priorMessages: string[];
  };
  expected: {
    has_actionable_objective: boolean;
    objective_category: string | null;
  };
  adversarial?: boolean;
  note?: string;
}

interface EvalSet {
  failure_rate_bar: number;
  scenarios: EvalScenario[];
}

const evalSet = JSON.parse(
  readFileSync(path.join(__dirname, "eval", "admission-scenarios.json"), "utf8")
) as EvalSet;

// ============================================================
// Harness
// ============================================================

function baseTables(
  overrides: {
    relationshipOps?: boolean;
    admissionMode?: string;
    publishedPolicy?: Record<string, unknown> | null;
    draftPolicy?: Record<string, unknown> | null;
  } = {}
): Record<string, Record<string, unknown>[]> {
  const tables: Record<string, Record<string, unknown>[]> = {
    organization_feature_flags: [
      {
        id: "flag-ops",
        organization_id: PILOT_ORG,
        flag_key: "relationship_ops",
        enabled: overrides.relationshipOps ?? true,
        value_text: null,
      },
      {
        id: "flag-mode",
        organization_id: PILOT_ORG,
        flag_key: "relationship_admission_mode",
        enabled: true,
        value_text: overrides.admissionMode ?? "shadow",
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
    external_identity_bindings: [
      {
        id: "b1",
        organization_id: PILOT_ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_organization_key",
        external_id: OWNER_UID,
        ref_organization_id: PILOT_ORG,
      },
      {
        id: "b2",
        organization_id: OTHER_ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_lead",
        external_id: OTHER_ORG_LEAD,
        ref_case_id: "case-other",
      },
    ],
    organization_policies: [],
    source_events: [],
    operational_case_types: [
      {
        id: CASE_TYPE_ID,
        case_type: "lead_opportunity",
        display_name: "Oportunidad de prospecto",
        default_skill_slug: "lead-opportunity-supervisor",
        user_id: null,
        visibility: "global",
        status: "active",
      },
    ],
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
    operational_cases: [],
    operational_case_events: [],
    case_facts: [],
    ai_usage_events: [],
  };

  if (overrides.publishedPolicy !== undefined && overrides.publishedPolicy) {
    tables.organization_policies.push({
      id: "policy-published",
      organization_id: PILOT_ORG,
      policy_type: "relationship_admission",
      version: 3,
      status: "published",
      policy_jsonb: overrides.publishedPolicy,
      nl_intent_source: null,
      published_by: ADVISOR,
      published_at: "2026-09-01T00:00:00.000Z",
    });
  }
  if (overrides.draftPolicy) {
    tables.organization_policies.push({
      id: "policy-draft",
      organization_id: PILOT_ORG,
      policy_type: "relationship_admission",
      version: 4,
      status: "draft",
      policy_jsonb: overrides.draftPolicy,
      nl_intent_source: null,
      published_by: null,
      published_at: null,
    });
  }
  return tables;
}

function harness(
  overrides: Parameters<typeof baseTables>[0] = {},
  extra: {
    failWrite?: Array<{ table: string; occurrence?: number }>;
    onWrite?: (table: string) => Promise<void> | void;
  } = {}
): FakeDb {
  return createFakeDb({
    tables: baseTables(overrides),
    uniqueIndexes: [
      { table: "source_events", columns: ["organization_id", "dedup_key"] },
      // uq_operational_cases_source_event: one source event admits at most one
      // Opportunity. Declared here so the executor's unique-violation recovery
      // path is exercised, NOT as a claim that the fake proves the PostgreSQL
      // race — that lives in the DB-backed suite.
      {
        table: "operational_cases",
        columns: ["organization_id", "context_jsonb->>source_event_id"],
      },
      // uq_case_facts_admission_evidence: one evidence row per (Case, fact key,
      // source event). Keyed on source_ref, so another writer's fact for the
      // same key neither blocks admission's nor is blocked by it.
      {
        table: "case_facts",
        columns: ["case_id", "fact_key", "source_ref"],
        where: (row) => String(row.source_ref ?? "").startsWith("source_events:"),
      },
      // uq_operational_case_events_admission: one admission narration per
      // (Case, source event).
      {
        table: "operational_case_events",
        columns: ["case_id", "payload_jsonb->>source_event_id"],
        where: (row) =>
          (row.payload_jsonb as Record<string, unknown> | null)?.kind ===
          "admission_disposition",
      },
    ],
    defaults: {
      source_events: {
        status: "pending",
        claim_epoch: 0,
        claimed_at: null,
        claimed_by: null,
        claim_expires_at: null,
        completed_at: null,
        processing_error: null,
        decision_jsonb: null,
        admitted_case_id: null,
      },
      case_facts: { superseded_by: null, source_ref: null, confidence: null },
      operational_cases: { organization_id: null, runtime_authority: null },
    },
    ...extra,
  });
}

/** An interpreter that always answers the same way, whatever it is asked. */
function fixedInterpreter(
  proposal: AdmissionProposal | null
): AdmissionInterpreter {
  return { interpret: async () => proposal };
}

const CLEAR_BUY: AdmissionProposal = {
  has_actionable_objective: true,
  objective: "Comprar casa de 3 recámaras en Polanco",
  objective_category: "buy_residential",
  confidence: "high",
  rationale: "explicit budget and zone",
};

const AMBIGUOUS: AdmissionProposal = {
  has_actionable_objective: false,
  objective: null,
  objective_category: null,
  confidence: "high",
  rationale: "isolated greeting with no context",
};

/**
 * The fake rejects the way PostgREST does — a plain `{ code, message }` object,
 * not an Error — so the assertion has to match that shape rather than a string.
 */
function isInjectedFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "INJECTED"
  );
}

const noBounds: PlatformHardBoundProbe = { evaluate: async () => null };
const blockedBounds: PlatformHardBoundProbe = {
  evaluate: async () => "prospect_blocked",
};

function request(
  db: FakeDb,
  options: {
    interpreter?: AdmissionInterpreter;
    hardBounds?: PlatformHardBoundProbe;
    lead?: string;
    dedupKey?: string;
    sourceLabel?: string | null;
    leaseSeconds?: number;
  } = {}
) {
  const lead = options.lead ?? PILOT_LEAD;
  return {
    ctx: {
      db: db.client,
      organizationId: PILOT_ORG,
      actorUserId: ADVISOR,
    },
    event: {
      kind: "inbound_prospect_message" as const,
      externalLeadRef: lead,
      dedupKey:
        options.dedupKey ??
        buildSourceEventDedupKey({
          sourceSystem: "traditional_gu",
          eventKind: "inbound_prospect_message",
          externalRef: lead,
          discriminator: "wamid.HBg1",
        }),
      message: "Hola, busco casa en Polanco",
      sourceLabel: options.sourceLabel ?? "portal_gu",
      originLabel: "portal",
      payload: {},
    },
    ownerUserId: ADVISOR,
    interpreter: options.interpreter ?? fixedInterpreter(CLEAR_BUY),
    hardBounds: options.hardBounds ?? noBounds,
    env: GATEWAY_ON,
    ...(options.leaseSeconds === undefined
      ? {}
      : { leaseSeconds: options.leaseSeconds }),
  };
}

async function expectRefusal(
  run: () => Promise<unknown>,
  reason: string
): Promise<LegacyReadRefusal> {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof LegacyReadRefusal,
      `expected a LegacyReadRefusal, got ${String(error)}`
    );
    assert.equal(error.reason, reason);
    return error;
  }
  throw new assert.AssertionError({
    message: `expected refusal "${reason}", but the call succeeded`,
  });
}

// ============================================================
// SA-2.2 — one Opportunity Case, with provenance-bearing facts
// ============================================================

async function testAdmittedMaterialisesOneCase(): Promise<void> {
  const db = harness();
  const result = await runAdmission(request(db));

  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "admitted");
  assert.equal(result.outcome.decision.reason, "clear_objective");
  assert.ok(result.outcome.case_id);

  const cases = db.tables.operational_cases;
  assert.equal(cases.length, 1, "exactly one Opportunity Case");
  assert.equal(cases[0].organization_id, PILOT_ORG);
  assert.equal(cases[0].case_type, "lead_opportunity");
  // ADR-107: admission takes responsibility, not runtime authority.
  assert.equal(cases[0].runtime_authority, "legacy");
  // AC-7: no workflow stage — progression lives in facts.
  assert.equal(cases[0].current_step, null);
  // Shadow: nothing is scheduled to act on the Case.
  assert.equal(cases[0].next_action_at, null);

  const facts = db.tables.case_facts;
  assert.ok(facts.length >= 2, "admitting facts recorded");
  for (const fact of facts) {
    assert.equal(fact.case_id, cases[0].id);
    assert.match(
      String(fact.source_ref),
      /^source_events:/,
      "every admitting fact traces to the source event"
    );
  }
  const keys = facts.map((fact) => fact.fact_key);
  assert.ok(keys.includes("admission.disposition"));
  assert.ok(keys.includes("admission.source"));
  assert.ok(keys.includes("opportunity.objective"));

  const events = db.tables.operational_case_events;
  assert.equal(events.length, 1);
  assert.equal(
    (events[0].payload_jsonb as Record<string, unknown>).kind,
    "admission_disposition"
  );
}

// ============================================================
// SA-2.3 — an ambiguous opener creates no Case
// ============================================================

async function testAmbiguousCreatesNoCase(): Promise<void> {
  const db = harness();
  const result = await runAdmission(
    request(db, { interpreter: fixedInterpreter(AMBIGUOUS) })
  );

  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "deferred_clarification");
  assert.equal(result.outcome.decision.reason, "ambiguous_objective");
  assert.equal(result.outcome.case_id, null);
  assert.equal(db.tables.operational_cases.length, 0, "EC-01: no Case");
  assert.equal(db.tables.case_facts.length, 0);

  // The disposition is still recorded, so an unadmitted lead is observable
  // rather than invisible.
  assert.equal(db.tables.source_events.length, 1);
  assert.equal(db.tables.source_events[0].status, "completed");
  assert.ok(db.tables.source_events[0].decision_jsonb);
}

/** A null judgment — model unavailable — must behave exactly like ambiguity. */
async function testNoJudgmentIsAmbiguity(): Promise<void> {
  const db = harness();
  const result = await runAdmission(
    request(db, { interpreter: fixedInterpreter(null) })
  );
  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "deferred_clarification");
  assert.equal(db.tables.operational_cases.length, 0);
}

// ============================================================
// SA-2.4 — one logical event, one settled outcome, at least once
//
// The happy-path duplicate is the easy half. These cover the half that decides
// whether the guarantee holds in production: concurrency, lease loss, and a
// crash at EVERY boundary of the materialisation the decision owes. S1 §8.16
// states the invariant they all serve — duplicate/retry processing must not
// create multiple active Opportunities for the same admitted event.
//
// Crashes are injected at real writes rather than simulated by editing rows, so
// recovery is proven to read what the CODE wrote.
// ============================================================

/** 1. Duplicate after a COMPLETED admitted event. */
async function testDuplicateAfterCompletedAdmission(): Promise<void> {
  const db = harness();
  const first = await runAdmission(request(db));
  const second = await runAdmission(request(db));

  assert.equal(first.status, "evaluated");
  assert.equal(second.status, "evaluated");
  if (first.status !== "evaluated" || second.status !== "evaluated") return;

  assert.equal(first.outcome.deduplicated, false);
  assert.equal(second.outcome.deduplicated, true, "the collision is observable");
  assert.equal(second.outcome.decision.disposition, "admitted");
  assert.equal(
    second.outcome.case_id,
    first.outcome.case_id,
    "the canonical admitted Case comes back with the settled outcome"
  );
  assert.ok(
    second.outcome.case_id,
    "an admitted duplicate must never report admitted with a null Case"
  );
  assert.equal(db.tables.source_events.length, 1);
  assert.equal(db.tables.operational_cases.length, 1);
}

/** 1b. Duplicate after a COMPLETED not-admitted event returns that outcome. */
async function testDuplicateAfterCompletedRefusal(): Promise<void> {
  const db = harness();
  const first = await runAdmission(request(db, { hardBounds: blockedBounds }));
  // Even a permissive probe on the retry must not change a settled outcome.
  const second = await runAdmission(request(db, { hardBounds: noBounds }));
  assert.equal(first.status, "evaluated");
  assert.equal(second.status, "evaluated");
  if (first.status !== "evaluated" || second.status !== "evaluated") return;
  assert.equal(second.outcome.decision.disposition, "not_admitted");
  assert.equal(second.outcome.decision.reason, "platform_hard_bound");
  assert.equal(second.outcome.case_id, null);
  assert.equal(db.tables.operational_cases.length, 0);
}

/** 2. Duplicate while the first delivery is still in flight. */
async function testDuplicateWhileInFlight(): Promise<void> {
  const db = harness();

  // Hold the first call inside the interpreter, which is exactly where the
  // original delivery spends its time in production.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: AdmissionInterpreter = {
    async interpret() {
      await held;
      return CLEAR_BUY;
    },
  };

  const firstPromise = runAdmission(request(db, { interpreter: slow }));
  await new Promise((resolve) => setImmediate(resolve));

  const second = await runAdmission(request(db));
  assert.equal(
    second.status,
    "in_flight",
    "a duplicate must not decide while another worker owns the event"
  );
  if (second.status === "in_flight") {
    assert.ok(second.claimedBy, "the live claim is reported, not invented");
    assert.ok(second.claimExpiresAt);
    assert.equal(second.lostClaim, false, "this caller never held the claim");
  }
  assert.equal(
    db.tables.operational_cases.length,
    0,
    "no Case yet: the first call has not finished"
  );

  release();
  const first = await firstPromise;
  assert.equal(first.status, "evaluated");
  if (first.status !== "evaluated") return;
  assert.equal(first.outcome.decision.disposition, "admitted");
  assert.equal(db.tables.operational_cases.length, 1, "still exactly one Case");
  assert.equal(db.tables.source_events.length, 1);
}

/** 3. Failure before any decision is recorded. */
async function testCrashBeforeDecision(): Promise<void> {
  const db = harness();
  const exploding: AdmissionInterpreter = {
    async interpret() {
      throw new Error("interpreter died mid-evaluation");
    },
  };

  await assert.rejects(
    () => runAdmission(request(db, { interpreter: exploding })),
    /interpreter died/
  );

  const [inbox] = db.tables.source_events;
  assert.equal(inbox.status, "failed", "the claim is released, not held");
  assert.equal(inbox.decision_jsonb, null, "nothing was decided");
  assert.equal(db.tables.operational_cases.length, 0);

  const retry = await runAdmission(request(db));
  assert.equal(retry.status, "evaluated");
  if (retry.status !== "evaluated") return;
  assert.equal(retry.outcome.decision.disposition, "admitted");
  assert.equal(db.tables.source_events.length, 1, "still one inbox row");
  assert.equal(db.tables.operational_cases.length, 1, "exactly one Case");
}

/**
 * 4. A crash at EVERY boundary of the owed materialisation.
 *
 * Each case fails one real write, then retries, and asserts the retry converges
 * on the complete canonical materialisation: one Case, all three facts, exactly
 * one timeline event, the original decision preserved, and settlement only
 * after all of it.
 */
async function testEveryMaterialisationCrashBoundaryConverges(): Promise<void> {
  // (table, occurrence) of the write to fail, in materialisation order.
  const boundaries: Array<[string, { table: string; occurrence: number }]> = [
    // source_events write order: 1 insert, 2 claim, 3 decision, 4 link, 5 settle.
    ["A: after Case creation, before the source-event link", { table: "source_events", occurrence: 4 }],
    ["B: after the link, before the disposition fact", { table: "case_facts", occurrence: 1 }],
    ["C: after the disposition fact, before the source fact", { table: "case_facts", occurrence: 2 }],
    ["D: after the source fact, before the objective fact", { table: "case_facts", occurrence: 3 }],
    ["E: after the objective fact, before the timeline event", { table: "operational_case_events", occurrence: 1 }],
    ["F: after the timeline event, before settlement", { table: "source_events", occurrence: 5 }],
  ];

  for (const [label, fault] of boundaries) {
    const db = harness({}, { failWrite: [fault] });

    await assert.rejects(
      () => runAdmission(request(db)),
      isInjectedFailure,
      `${label}: the injected fault must actually fire`
    );

    // The decision is durable from before the Case existed, whatever failed.
    const beforeRetry = db.tables.source_events[0];
    assert.ok(
      beforeRetry.decision_jsonb,
      `${label}: the decision is recorded before anything irreversible`
    );
    assert.notEqual(
      beforeRetry.status,
      "completed",
      `${label}: an interrupted materialisation is never settled`
    );

    const originalPolicy = (
      beforeRetry.decision_jsonb as { policy?: { policy_id?: string } }
    ).policy?.policy_id;

    const retry = await runAdmission(request(db));
    assert.equal(retry.status, "evaluated", `${label}: the retry completes`);
    if (retry.status !== "evaluated") return;

    assert.equal(
      db.tables.operational_cases.length,
      1,
      `${label}: exactly one Opportunity Case`
    );
    assert.equal(
      db.tables.source_events.length,
      1,
      `${label}: exactly one inbox row`
    );

    const inbox = db.tables.source_events[0];
    assert.equal(inbox.status, "completed", `${label}: settled`);
    assert.ok(inbox.admitted_case_id, `${label}: the Case link is recorded`);
    assert.equal(
      inbox.admitted_case_id,
      db.tables.operational_cases[0].id,
      `${label}: the link points at the one Case`
    );
    assert.equal(
      (inbox.decision_jsonb as { policy?: { policy_id?: string } }).policy
        ?.policy_id,
      originalPolicy,
      `${label}: the original policy attribution survives the retry`
    );

    // Every owed fact exists, exactly once as a current value.
    const current = db.tables.case_facts.filter(
      (fact) => fact.superseded_by == null
    );
    for (const key of [
      "admission.disposition",
      "admission.source",
      "opportunity.objective",
    ]) {
      const matching = current.filter((fact) => fact.fact_key === key);
      assert.equal(
        matching.length,
        1,
        `${label}: exactly one current ${key} fact`
      );
    }

    // Exactly one timeline event, never re-appended by the resume.
    const admissionEvents = db.tables.operational_case_events.filter((entry) => {
      const payload = entry.payload_jsonb as Record<string, unknown>;
      return payload?.kind === "admission_disposition";
    });
    assert.equal(
      admissionEvents.length,
      1,
      `${label}: the timeline event is written once, not duplicated by recovery`
    );
  }
}

/**
 * 5. The original effective policy version survives a crash, even when the
 * Organization's published policy changes before the retry.
 *
 * This is the misattribution defect: recovery must replay the decision that
 * actually governed the admission, not re-resolve today's policy.
 */
async function testOriginalPolicyAttributionSurvivesPolicyChange(): Promise<void> {
  const db = harness({
    publishedPolicy: {
      excluded_categories: [],
      auto_admit_clear_objectives: true,
      trusted_sources: [],
    },
  });

  // Crash after the Case exists but before the disposition fact.
  db.failNextWrite("case_facts");
  await assert.rejects(() => runAdmission(request(db)), isInjectedFailure);

  const decided = db.tables.source_events[0].decision_jsonb as {
    policy: { policy_id: string; version: number; source: string };
  };
  assert.equal(decided.policy.version, 3, "version 3 governed this admission");
  assert.equal(decided.policy.source, "organization_published");

  // The Organization publishes a NEW version before the retry: v3 archived,
  // v4 published, and materially different.
  const published = db.tables.organization_policies.find(
    (row) => row.status === "published"
  );
  if (published) published.status = "archived";
  db.tables.organization_policies.push({
    id: "policy-published-v4",
    organization_id: PILOT_ORG,
    policy_type: "relationship_admission",
    version: 4,
    status: "published",
    policy_jsonb: {
      excluded_categories: ["buy_residential"],
      auto_admit_clear_objectives: false,
      trusted_sources: [],
    },
    nl_intent_source: null,
    published_by: ADVISOR,
    published_at: "2026-09-06T00:00:00.000Z",
  });

  const retry = await runAdmission(request(db));
  assert.equal(retry.status, "evaluated");
  if (retry.status !== "evaluated") return;

  assert.equal(
    retry.outcome.decision.policy.version,
    3,
    "recovery attributes the ORIGINAL policy version, not the one in force now"
  );
  assert.equal(
    retry.outcome.decision.disposition,
    "admitted",
    "and does not re-decide under a policy that would now refuse"
  );
  const factValue = db.tables.case_facts.find(
    (fact) => fact.fact_key === "admission.disposition"
  )?.value_jsonb as { policy?: { version?: number } };
  assert.equal(
    factValue?.policy?.version,
    3,
    "the durable Case evidence carries the original version too"
  );
}

/** 6. Recovery after an expired claim, without any explicit failure. */
async function testExpiredClaimIsReclaimable(): Promise<void> {
  const db = harness();

  // A worker that claims and then vanishes: hold the interpreter open forever
  // and abandon the promise, which is what a process kill looks like from the
  // database's side.
  const stalled: AdmissionInterpreter = {
    interpret: () => new Promise(() => undefined),
  };
  void runAdmission(request(db, { interpreter: stalled, leaseSeconds: 0 })).catch(
    () => undefined
  );
  await new Promise((resolve) => setImmediate(resolve));

  const [inbox] = db.tables.source_events;
  assert.equal(inbox.status, "processing", "the dead worker still holds it");
  const epochBefore = inbox.claim_epoch;

  const retry = await runAdmission(request(db));
  assert.equal(
    retry.status,
    "evaluated",
    "an expired lease is reclaimable; a dead worker cannot poison the key"
  );
  if (retry.status !== "evaluated") return;
  assert.equal(retry.outcome.decision.disposition, "admitted");
  assert.ok(
    (db.tables.source_events[0].claim_epoch as number) > (epochBefore as number),
    "reclaiming bumps the fence, locking the previous owner out"
  );
  assert.equal(db.tables.source_events.length, 1);
  assert.equal(db.tables.operational_cases.length, 1);
}

/**
 * 7a. A stale worker whose event the new owner has ALREADY settled.
 *
 * It must not damage anything, and it must not fabricate: the canonical settled
 * outcome is the truthful answer, marked as a duplicate. Reporting `in_flight`
 * here would itself be false — the event is settled, not in flight.
 */
async function testStaleWorkerAfterSettlement(): Promise<void> {
  const db = harness();

  // A: claims with an already-expired lease, then blocks in the interpreter.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stalling: AdmissionInterpreter = {
    async interpret() {
      await held;
      return CLEAR_BUY;
    },
  };
  const stalePromise = runAdmission(
    request(db, { interpreter: stalling, leaseSeconds: 0 })
  );
  await new Promise((resolve) => setImmediate(resolve));

  // B: reclaims the expired lease and finishes the whole admission.
  const owner = await runAdmission(request(db));
  assert.equal(owner.status, "evaluated");
  if (owner.status !== "evaluated") return;
  const canonicalCaseId = owner.outcome.case_id;
  const settledAt = db.tables.source_events[0].completed_at;
  const factCount = db.tables.case_facts.length;
  const eventCount = db.tables.operational_case_events.length;

  // A now resumes and attempts to record, link and settle.
  release();
  const stale = await stalePromise;
  assert.equal(stale.status, "evaluated");
  if (stale.status !== "evaluated") return;
  assert.equal(
    stale.outcome.deduplicated,
    true,
    "the stale worker returns the canonical settled outcome, not one of its own"
  );
  assert.equal(stale.outcome.case_id, canonicalCaseId);

  // Nothing of B's was disturbed.
  const inbox = db.tables.source_events[0];
  assert.equal(inbox.status, "completed", "A did not revert the settled row");
  assert.equal(inbox.completed_at, settledAt, "A did not re-settle it");
  assert.equal(inbox.admitted_case_id, canonicalCaseId);
  assert.equal(
    db.tables.operational_cases.length,
    1,
    "A could not create a second Opportunity: the identity is structurally unique"
  );
  assert.equal(db.tables.case_facts.length, factCount, "A wrote no facts");
  assert.equal(
    db.tables.operational_case_events.length,
    eventCount,
    "A appended no timeline event"
  );
}

/**
 * 7b. A stale worker whose event the new owner has reclaimed but NOT settled.
 *
 * Here the honest answer is `in_flight` with `lostClaim` set: the outcome does
 * not exist yet, and this caller is no longer the one producing it.
 */
async function testStaleWorkerReportsLostClaim(): Promise<void> {
  const db = harness();

  const gate = () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interpreter: AdmissionInterpreter = {
      async interpret() {
        await held;
        return CLEAR_BUY;
      },
    };
    return { interpreter, release: () => release() };
  };

  // A claims with an expired lease and stalls.
  const a = gate();
  const aPromise = runAdmission(
    request(db, { interpreter: a.interpreter, leaseSeconds: 0 })
  );
  await new Promise((resolve) => setImmediate(resolve));

  // B reclaims and also stalls, so the event stays unsettled.
  const b = gate();
  const bPromise = runAdmission(request(db, { interpreter: b.interpreter }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.tables.source_events[0].claim_epoch, 2, "B holds epoch 2");

  // A resumes into a row it no longer owns.
  a.release();
  const stale = await aPromise;
  assert.equal(
    stale.status,
    "in_flight",
    "an unsettled event a caller no longer owns is reported, never guessed at"
  );
  if (stale.status === "in_flight") {
    assert.equal(
      stale.lostClaim,
      true,
      "and the caller can tell it lost the claim, rather than reading a no-op as success"
    );
  }
  assert.equal(
    db.tables.source_events[0].decision_jsonb,
    null,
    "A's fenced decision write did not land on B's row"
  );
  assert.equal(db.tables.operational_cases.length, 0);

  // B still completes normally afterwards.
  b.release();
  const owner = await bPromise;
  assert.equal(owner.status, "evaluated");
  if (owner.status !== "evaluated") return;
  assert.equal(owner.outcome.decision.disposition, "admitted");
  assert.equal(db.tables.operational_cases.length, 1);
  assert.equal(db.tables.source_events[0].status, "completed");
}

/**
 * 7c. The fenced helpers themselves report non-application, at the boundary.
 *
 * A conditional write that affected zero rows must never look like success —
 * this is the contract the executor's ClaimLost handling rests on.
 */
async function testFencedHelpersReportNonApplication(): Promise<void> {
  const db = harness();
  const recorded = await recordSourceEvent(db.client, {
    organizationId: PILOT_ORG,
    sourceSystem: "traditional_gu",
    eventKind: "inbound_prospect_message",
    dedupKey: "fence:direct",
  });
  const first = await claimSourceEvent(db.client, {
    organizationId: PILOT_ORG,
    sourceEventId: recorded.event.id,
    claimedBy: "worker-a",
    observedEpoch: recorded.event.claim_epoch,
    leaseSeconds: 0,
  });
  assert.ok(first);
  const second = await reclaimSourceEvent(db.client, {
    organizationId: PILOT_ORG,
    sourceEventId: recorded.event.id,
    claimedBy: "worker-b",
    observedEpoch: first.epoch,
  });
  assert.ok(second);
  assert.equal(second.epoch, first.epoch + 1, "the fence advanced");

  const staleArgs = {
    organizationId: PILOT_ORG,
    sourceEventId: recorded.event.id,
    epoch: first.epoch,
  };
  assert.equal(
    await recordSourceEventDecision(db.client, {
      ...staleArgs,
      decision: { disposition: "not_admitted" },
    }),
    false,
    "a stale owner cannot record a decision"
  );
  assert.equal(
    await linkAdmittedCase(db.client, { ...staleArgs, caseId: "case-x" }),
    false,
    "a stale owner cannot link a Case"
  );
  assert.equal(
    await settleSourceEvent(db.client, {
      ...staleArgs,
      decision: { disposition: "not_admitted" },
    }),
    false,
    "a stale owner cannot settle"
  );
  assert.equal(
    await failSourceEvent(db.client, { ...staleArgs, error: "stale" }),
    false,
    "a stale owner cannot fail the new owner's row"
  );
  assert.equal(
    db.tables.source_events[0].decision_jsonb,
    null,
    "and none of those attempts changed anything"
  );

  // The current owner still can.
  assert.equal(
    await settleSourceEvent(db.client, {
      organizationId: PILOT_ORG,
      sourceEventId: recorded.event.id,
      epoch: second.epoch,
      decision: { disposition: "not_admitted" },
    }),
    true,
    "the current owner's write applies"
  );
  // ...and a settled row is not revertible, by anyone.
  assert.equal(
    await failSourceEvent(db.client, {
      organizationId: PILOT_ORG,
      sourceEventId: recorded.event.id,
      epoch: second.epoch,
      error: "too late",
    }),
    false,
    "a completed event cannot be reverted to failed"
  );
  assert.equal(db.tables.source_events[0].status, "completed");
}

/**
 * 7d. THE mid-materialisation race.
 *
 * The other stale-worker tests lose the claim before the old worker enters
 * materialisation, so they never exercise two workers writing to the same Case
 * at once. This one holds A at its first fact write — after it recorded the
 * decision, created the Case AND successfully linked it under epoch 1 — then
 * lets B reclaim and complete the whole admission, then releases A.
 *
 * Everything A does from there must be absorbed: no second fact, no second
 * timeline event, no mutation of B's settled truth.
 */
async function testMidMaterialisationRaceConverges(): Promise<void> {
  let heldOnce = false;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const db = harness(
    {},
    {
      onWrite: async (table) => {
        // Hold ONLY A's first fact write. B's writes, which happen while A is
        // parked here, must proceed.
        if (table === "case_facts" && !heldOnce) {
          heldOnce = true;
          await held;
        }
      },
    }
  );

  // A takes an already-expired lease and walks into materialisation.
  const aPromise = runAdmission(request(db, { leaseSeconds: 0 }));
  await new Promise((resolve) => setImmediate(resolve));

  // A got far enough to link the Case before parking.
  assert.equal(
    db.tables.operational_cases.length,
    1,
    "A created the Case before stalling"
  );
  assert.ok(
    db.tables.source_events[0].admitted_case_id,
    "and linked it under its own epoch"
  );
  assert.equal(db.tables.source_events[0].claim_epoch, 1);

  // B reclaims the expired lease and completes everything.
  const owner = await runAdmission(request(db));
  assert.equal(owner.status, "evaluated");
  if (owner.status !== "evaluated") return;
  assert.equal(owner.outcome.decision.disposition, "admitted");
  assert.equal(db.tables.source_events[0].status, "completed");
  assert.equal(db.tables.source_events[0].claim_epoch, 2);
  const settledAt = db.tables.source_events[0].completed_at;
  const canonicalCaseId = owner.outcome.case_id;

  // A resumes into a Case that is already fully materialised and settled.
  release();
  const stale = await aPromise;

  assert.equal(
    db.tables.operational_cases.length,
    1,
    "still exactly one Opportunity Case"
  );

  for (const key of [
    "admission.disposition",
    "admission.source",
    "opportunity.objective",
  ]) {
    const rows = db.tables.case_facts.filter((fact) => fact.fact_key === key);
    assert.equal(
      rows.length,
      1,
      `exactly one ${key} evidence row survives the race (found ${rows.length})`
    );
    assert.equal(
      rows[0].superseded_by,
      null,
      `and it is the current value for ${key}`
    );
  }

  const admissionEvents = db.tables.operational_case_events.filter((entry) => {
    const payload = entry.payload_jsonb as Record<string, unknown>;
    return payload?.kind === "admission_disposition";
  });
  assert.equal(
    admissionEvents.length,
    1,
    "the admission is narrated once, not twice"
  );

  // B's settled truth is untouched.
  const inbox = db.tables.source_events[0];
  assert.equal(inbox.status, "completed");
  assert.equal(inbox.completed_at, settledAt, "A did not re-settle");
  assert.equal(inbox.admitted_case_id, canonicalCaseId);

  // And A reports the canonical result rather than one of its own.
  assert.equal(stale.status, "evaluated");
  if (stale.status !== "evaluated") return;
  assert.equal(stale.outcome.deduplicated, true);
  assert.equal(stale.outcome.case_id, canonicalCaseId);
}

/**
 * 7e. Admission's late evidence never displaces a newer legitimate fact.
 *
 * `opportunity.objective` is business truth other writers will own in later
 * Slices. A resume that arrives after one of them must record its historical
 * evidence WITHOUT rewriting the present — and the completion check must ask
 * "has THIS admission's evidence been written?", not "does the Case have any
 * fact with this key?".
 */
async function testLateAdmissionEvidenceDoesNotOverwriteNewerTruth(): Promise<void> {
  const db = harness();

  // Crash after the disposition fact, before the objective fact.
  db.failNextWrite("case_facts");
  db.failNextWrite("case_facts");
  db.failNextWrite("case_facts");
  await assert.rejects(() => runAdmission(request(db)), isInjectedFailure);
  const caseId = db.tables.operational_cases[0].id as string;
  assert.equal(
    db.tables.case_facts.length,
    0,
    "no admission fact landed before the crash"
  );

  // Another writer sets the current objective in the meantime, with its own
  // provenance — not admission's.
  await insertCaseFact(db.client, {
    userId: ADVISOR,
    caseId,
    factKey: "opportunity.objective",
    value: { objective: "Cambió a renta", category: "rent_residential" },
    sourceKind: "user",
    sourceRef: "advisor_correction",
  });

  const retry = await runAdmission(request(db));
  assert.equal(retry.status, "evaluated");

  const objectives = db.tables.case_facts.filter(
    (fact) => fact.fact_key === "opportunity.objective"
  );
  assert.equal(objectives.length, 2, "both evidence items exist in history");

  const current = objectives.filter((fact) => fact.superseded_by == null);
  assert.equal(current.length, 1, "exactly one is current");
  assert.equal(
    current[0].source_ref,
    "advisor_correction",
    "the newer legitimate fact stays current; admission does not rewrite the present"
  );

  const admissionEvidence = objectives.find((fact) =>
    String(fact.source_ref).startsWith("source_events:")
  );
  assert.ok(
    admissionEvidence,
    "admission's own provenance-bearing evidence is still recorded"
  );
  assert.ok(
    admissionEvidence?.superseded_by,
    "recorded as history, since it arrived after the current value"
  );

  // ...and the admission still completed: its owed evidence exists.
  assert.equal(db.tables.source_events[0].status, "completed");
}

/** 8. Across every path: one Case, and never two contradictory answers. */
async function testNoPathProducesTwoCasesOrTwoAnswers(): Promise<void> {
  const scenarios: Array<[string, (db: FakeDb) => Promise<void>]> = [
    [
      "clean redelivery x3",
      async (db) => {
        await runAdmission(request(db));
        await runAdmission(request(db));
        await runAdmission(request(db));
      },
    ],
    [
      "crash before the first fact, then two retries",
      async (db) => {
        db.failNextWrite("case_facts");
        await runAdmission(request(db)).catch(() => undefined);
        await runAdmission(request(db));
        await runAdmission(request(db));
      },
    ],
    [
      "crash before the timeline event, then two retries",
      async (db) => {
        db.failNextWrite("operational_case_events");
        await runAdmission(request(db)).catch(() => undefined);
        await runAdmission(request(db));
        await runAdmission(request(db));
      },
    ],
  ];

  for (const [label, run] of scenarios) {
    const db = harness();
    await run(db);

    assert.equal(
      db.tables.operational_cases.length,
      1,
      `${label}: exactly one Opportunity Case`
    );
    assert.equal(
      db.tables.source_events.length,
      1,
      `${label}: exactly one inbox row`
    );

    const settled = db.tables.source_events[0].decision_jsonb as {
      disposition?: string;
    } | null;
    assert.ok(settled, `${label}: the event settled`);
    assert.equal(
      settled?.disposition,
      "admitted",
      `${label}: the settled disposition matches the durable Case`
    );

    const dispositionFacts = db.tables.case_facts.filter(
      (fact) =>
        fact.fact_key === "admission.disposition" && fact.superseded_by == null
    );
    assert.equal(
      dispositionFacts.length,
      1,
      `${label}: exactly one current disposition fact`
    );
    assert.equal(
      (dispositionFacts[0].value_jsonb as { disposition?: string }).disposition,
      "admitted",
      `${label}: Case and inbox never disagree`
    );
  }
}

/** A genuinely different event about the same lead is not a duplicate. */
async function testDistinctEventsAreNotDeduplicated(): Promise<void> {
  const db = harness();
  await runAdmission(request(db, { dedupKey: "traditional_gu:msg:lead:one" }));
  const second = await runAdmission(
    request(db, { dedupKey: "traditional_gu:msg:lead:two" })
  );
  assert.equal(second.status, "evaluated");
  if (second.status !== "evaluated") return;
  assert.equal(second.outcome.deduplicated, false);
  assert.equal(db.tables.source_events.length, 2);
}

// ============================================================
// SA-2.5 — a platform hard bound beats policy and model confidence
// ============================================================

async function testHardBoundWins(): Promise<void> {
  const db = harness({
    // A maximally permissive published policy: nothing excluded, auto-admit on.
    publishedPolicy: {
      excluded_categories: [],
      auto_admit_clear_objectives: true,
      trusted_sources: ["portal_gu"],
    },
  });
  const result = await runAdmission(
    request(db, {
      // ...and a maximally confident model judgment.
      interpreter: fixedInterpreter(CLEAR_BUY),
      hardBounds: blockedBounds,
    })
  );

  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "not_admitted");
  assert.equal(result.outcome.decision.reason, "platform_hard_bound");
  assert.equal(result.outcome.decision.hard_bound, "prospect_blocked");
  assert.equal(result.outcome.decision.policy.source, "platform_hard_bound");
  assert.equal(db.tables.operational_cases.length, 0, "EC-02: no Case");
}

// ============================================================
// SA-2.6 — an excluded category is not auto-admitted
// ============================================================

async function testExcludedCategory(): Promise<void> {
  const db = harness({
    publishedPolicy: {
      excluded_categories: ["buy_residential"],
      auto_admit_clear_objectives: true,
      trusted_sources: [],
    },
  });
  const result = await runAdmission(request(db));

  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "not_admitted");
  assert.equal(result.outcome.decision.reason, "policy_excluded_category");
  assert.equal(result.outcome.decision.policy.source, "organization_published");
  assert.equal(result.outcome.decision.policy.version, 3);
  assert.equal(db.tables.operational_cases.length, 0);
}

/** A trusted source must not carry an excluded objective past the exclusion. */
async function testTrustedSourceCannotBypassExclusion(): Promise<void> {
  const db = harness({
    publishedPolicy: {
      excluded_categories: ["buy_residential"],
      auto_admit_clear_objectives: true,
      trusted_sources: ["portal_gu"],
    },
  });
  const result = await runAdmission(request(db, { sourceLabel: "portal_gu" }));
  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.reason, "policy_excluded_category");
  assert.equal(db.tables.operational_cases.length, 0);
}

// ============================================================
// SA-2.7 — policy resolution and version attribution
// ============================================================

async function testPlatformBaselineApplies(): Promise<void> {
  const db = harness();
  const effective = await resolveEffectiveAdmissionPolicy(db.client, PILOT_ORG);
  assert.equal(effective.status, "resolved");
  if (effective.status !== "resolved") return;
  assert.equal(effective.attribution.source, "platform_default");
  assert.equal(effective.attribution.policy_id, PLATFORM_DEFAULT_POLICY_ID);
  assert.equal(effective.attribution.version, 1);

  // ...and it is NOT zero admission (S1 §8.4.3).
  const result = await runAdmission(request(db));
  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "admitted");
  assert.equal(
    result.outcome.decision.policy.policy_id,
    PLATFORM_DEFAULT_POLICY_ID,
    "the effective version is attributed on the disposition"
  );
}

async function testDraftPolicyIsNeverAuthority(): Promise<void> {
  const db = harness({
    // A draft that would forbid this admission, and nothing published.
    draftPolicy: {
      excluded_categories: ["buy_residential"],
      auto_admit_clear_objectives: false,
      trusted_sources: [],
    },
  });
  const effective = await resolveEffectiveAdmissionPolicy(db.client, PILOT_ORG);
  assert.equal(effective.status, "resolved");
  if (effective.status !== "resolved") return;
  assert.equal(
    effective.attribution.source,
    "platform_default",
    "a draft row never resolves; the baseline applies instead"
  );

  const result = await runAdmission(request(db));
  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "admitted");
}

async function testInvalidPolicyFailsClosed(): Promise<void> {
  const db = harness({
    publishedPolicy: { excluded_categories: "not-an-array" },
  });
  const effective = await resolveEffectiveAdmissionPolicy(db.client, PILOT_ORG);
  assert.equal(effective.status, "unavailable");
  if (effective.status !== "unavailable") return;
  assert.equal(
    effective.attribution.matched_rule,
    "invalid_published_policy_fail_closed"
  );

  const result = await runAdmission(request(db));
  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.disposition, "not_admitted");
  assert.equal(result.outcome.decision.reason, "policy_unavailable");
  assert.equal(
    db.tables.operational_cases.length,
    0,
    "invalid policy narrows; it does not fall back to the permissive baseline"
  );
}

function testPolicyParserRejectsPartialShapes(): void {
  assert.equal(parseAdmissionPolicy(null), null);
  assert.equal(parseAdmissionPolicy([]), null);
  assert.equal(parseAdmissionPolicy({}), null);
  assert.equal(
    parseAdmissionPolicy({
      excluded_categories: [],
      auto_admit_clear_objectives: "yes",
      trusted_sources: [],
    }),
    null,
    "a truthy non-boolean must not read as permission"
  );
  assert.deepEqual(
    parseAdmissionPolicy({
      excluded_categories: ["land"],
      auto_admit_clear_objectives: false,
      trusted_sources: ["portal_gu"],
    }),
    {
      excluded_categories: ["land"],
      auto_admit_clear_objectives: false,
      trusted_sources: ["portal_gu"],
    }
  );
}

/** Policy that requires a human touch does not admit, and creates no Case. */
async function testManualAdmissionRequired(): Promise<void> {
  const db = harness({
    publishedPolicy: {
      excluded_categories: [],
      auto_admit_clear_objectives: false,
      trusted_sources: [],
    },
  });
  const result = await runAdmission(request(db));
  assert.equal(result.status, "evaluated");
  if (result.status !== "evaluated") return;
  assert.equal(result.outcome.decision.reason, "manual_admission_required");
  assert.equal(db.tables.operational_cases.length, 0);
}

// ============================================================
// SA-2.8 — the Organization gate precedes every read
// ============================================================

async function testCrossOrganizationLeadIsRefusedWithoutReads(): Promise<void> {
  const db = harness();
  await expectRefusal(
    () => runAdmission(request(db, { lead: OTHER_ORG_LEAD })),
    "belongs_to_another_organization"
  );

  // "Zero reads recorded" means zero *source* reads and zero durable writes.
  assert.equal(db.tables.source_events.length, 0, "no inbox row");
  assert.equal(db.tables.operational_cases.length, 0);
  assert.equal(db.tables.case_facts.length, 0);
  assert.deepEqual(db.writes, [], "a refused admission writes nothing at all");
}

async function testUnboundOrganizationIsRefused(): Promise<void> {
  const db = harness();
  db.tables.external_identity_bindings =
    db.tables.external_identity_bindings.filter(
      (row) => row.binding_kind !== "legacy_organization_key"
    );
  await expectRefusal(
    () => runAdmission(request(db)),
    "organization_not_bound_to_source"
  );
  assert.deepEqual(db.writes, []);
}

// ============================================================
// SA-2.9 — flags off ⇒ fully inert
// ============================================================

async function testFlagOffIsInert(): Promise<void> {
  const db = harness({ relationshipOps: false });
  const result = await runAdmission(request(db));

  assert.equal(result.status, "inert");
  if (result.status !== "inert") return;
  assert.equal(result.reason, "relationship_ops_disabled");
  assert.equal(db.tables.source_events.length, 0);
  assert.equal(db.tables.operational_cases.length, 0);
  assert.deepEqual(db.writes, [], "no disposition, no Case, no write");
}

/** A mode this Slice does not implement is inert, not treated as shadow. */
async function testUnimplementedModeIsInert(): Promise<void> {
  const db = harness({ admissionMode: "live" });
  const result = await runAdmission(request(db));
  assert.equal(result.status, "inert");
  if (result.status !== "inert") return;
  assert.equal(result.reason, "admission_mode_disabled");
  assert.deepEqual(db.writes, []);
}

// ============================================================
// SA-2.10 — no prospect-facing effect is reachable
// ============================================================

async function testNoProspectFacingEffectIsReachable(): Promise<void> {
  // Asserted structurally rather than assumed: the module's own source is the
  // evidence. A future edit that reaches a send path fails here.
  const sources = [
    "admit.ts",
    "policy.ts",
    "hard-bounds.ts",
    "interpreter.ts",
    "index.ts",
  ].map((file) => readFileSync(path.join(__dirname, file), "utf8"));

  const forbidden = [
    /sendWhatsApp/i,
    /sendMessage\s*\(/,
    /external_effect_operations/,
    /bypass_bot/,
    /\btwilio\b/i,
    /\bwhatsapp\b/i,
    /notify[A-Z]/,
  ];
  for (const source of sources) {
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(source),
        `admission must not reference a prospect-facing effect (${pattern})`
      );
    }
  }

  // And behaviorally: a full admitted run writes only Gu OS rows.
  const db = harness();
  await runAdmission(request(db));
  const written = new Set(db.writes);
  const allowed = new Set([
    "source_events",
    "operational_cases",
    "operational_case_events",
    "case_facts",
  ]);
  for (const table of written) {
    assert.ok(
      allowed.has(table),
      `admission wrote to an unexpected table: ${table}`
    );
  }
}

// ============================================================
// Interpreter boundary — the model proposes, it never decides
// ============================================================

function testProposalCarriesNoDecision(): void {
  const proposal = normalizeProposal({
    has_actionable_objective: true,
    objective: "renta depa",
    objective_category: "rent_residential",
    confidence: "high",
    rationale: "explicit",
    // A model trying to decide is simply not represented in the contract.
    disposition: "admitted",
    admit: true,
  });
  assert.ok(proposal);
  assert.equal(
    Object.prototype.hasOwnProperty.call(proposal, "disposition"),
    false
  );
  assert.equal(Object.prototype.hasOwnProperty.call(proposal, "admit"), false);
}

function testUnknownCategoryNormalizes(): void {
  const proposal = normalizeProposal({
    has_actionable_objective: true,
    objective: "algo",
    objective_category: "invented_category",
    confidence: "low",
    rationale: "r",
  });
  assert.ok(proposal);
  assert.equal(
    proposal.objective_category,
    "other",
    "an invented category must not slip past every policy exclusion"
  );
}

function testPurePolicyApplication(): void {
  // The pure seam the eval set drives, exercised directly.
  const attribution = {
    source: "platform_default" as const,
    policy_id: PLATFORM_DEFAULT_POLICY_ID,
    version: 1,
    matched_rule: "test",
  };
  const admitted = applyPolicyToProposal({
    policy: {
      excluded_categories: [],
      auto_admit_clear_objectives: true,
      trusted_sources: [],
    },
    attribution,
    proposal: CLEAR_BUY,
    sourceLabel: null,
  });
  assert.equal(admitted.disposition, "admitted");

  const trusted = applyPolicyToProposal({
    policy: {
      excluded_categories: [],
      auto_admit_clear_objectives: false,
      trusted_sources: ["portal_gu"],
    },
    attribution,
    proposal: AMBIGUOUS,
    sourceLabel: "portal_gu",
  });
  assert.equal(
    trusted.disposition,
    "admitted",
    "S1 §8.4.4: a trusted source event can be sufficient on its own"
  );
  assert.equal(trusted.reason, "trusted_source");
}

// ============================================================
// Ingestion — a poll must not admit the same lead twice
// ============================================================

function testDedupKeyPrefersProviderId(): void {
  const key = deriveDedupKey({
    legacyLeadId: PILOT_LEAD,
    message: {
      thread: { kind: "gu", threadId: "t", advisorEndpoint: null },
      wamid: "wamid.HBg1",
      direction: "inbound",
      source: null,
      authorLabel: null,
      text: "hola",
      timestamp: "2026-09-05T10:00:00.000Z",
      deliveryStatus: "unknown",
      deliveryErrorCode: null,
    },
    leadUpdatedAt: "2026-09-05T11:00:00.000Z",
  });
  assert.equal(
    key,
    `traditional_gu:inbound_prospect_message:${PILOT_LEAD}:wamid.HBg1`
  );
}

function testDedupKeyIsStableAcrossPolls(): void {
  // The property that makes polling safe: the same unchanged lead, polled
  // twice, derives the SAME key — so the second poll collides instead of
  // admitting again. A per-call value here (a timestamp of "now", a random id)
  // would silently defeat AC-05 for the poll path only.
  const args = {
    legacyLeadId: PILOT_LEAD,
    message: null,
    leadUpdatedAt: "2026-09-05T11:00:00.000Z",
  };
  assert.equal(deriveDedupKey(args), deriveDedupKey(args));
  assert.notEqual(
    deriveDedupKey(args),
    deriveDedupKey({ ...args, leadUpdatedAt: "2026-09-05T12:00:00.000Z" }),
    "a genuinely newer lead state is a different event"
  );
}

function testLatestInboundIgnoresOutbound(): void {
  const item = (
    direction: "inbound" | "outbound",
    text: string
  ) => ({
    thread: { kind: "gu" as const, threadId: "t", advisorEndpoint: null },
    wamid: null,
    direction,
    source: null,
    authorLabel: null,
    text,
    timestamp: null,
    deliveryStatus: "unknown" as const,
    deliveryErrorCode: null,
  });
  const latest = latestInboundMessage({
    legacyLeadId: PILOT_LEAD,
    threads: [],
    items: [item("inbound", "primero"), item("outbound", "respuesta del asesor")],
    truncated: false,
  });
  assert.equal(
    latest?.text,
    "primero",
    "Gu's own outbound message is not a prospect signal"
  );
}

// ============================================================
// Correlation coverage (Technical Plan §7 (a)) — applies from SL-2
// ============================================================

/**
 * The correlation-coverage check the shared baseline adds from SL-2 onward
 * (Technical Plan §7 (a)).
 *
 * Asserting that `insertAiUsageEvent` persists the column would prove the
 * column exists, not that the admission path uses it. What actually decides
 * coverage is whether the model call runs inside a bound ambient context: with
 * none, the meter drops the event entirely and the column stays empty forever.
 * So this drives the REAL executor and captures what the meter would have
 * written.
 */
async function testAdmissionModelCallIsCorrelated(): Promise<void> {
  const captured: AiUsageEventInput[] = [];
  setAiUsageRecorder((event) => {
    captured.push(event);
  });
  try {
    const db = harness();
    // An interpreter that meters exactly the way the production one does. What
    // is under test is the CONTEXT admission binds around it, not the metering
    // call itself.
    const metering: AdmissionInterpreter = {
      async interpret() {
        await recordOpenRouterCallUsage({
          modelId: "openai/gpt-5.4-mini",
          modelRole: "relationship_admission_interpreter",
          operation: "classification",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        return CLEAR_BUY;
      },
    };
    const result = await runAdmission(
      request(db, { interpreter: metering })
    );
    assert.equal(result.status, "evaluated");

    assert.equal(
      captured.length,
      1,
      "the admission model call is metered, not dropped for want of a context"
    );
    assert.equal(
      captured[0].organizationId,
      PILOT_ORG,
      "an Organization-scoped model call correlates to its Organization"
    );
    assert.equal(captured[0].userId, ADVISOR);
    assert.equal(
      captured[0].modelRole,
      "relationship_admission_interpreter",
      "the admission interpreter is attributable as its own role"
    );
    assert.equal(
      captured[0].operationalCaseId ?? null,
      null,
      "no Case exists yet at interpretation time — which is exactly why the Organization dimension had to land at SL-2"
    );
  } finally {
    setAiUsageRecorder(null);
  }
}

async function testUsageCorrelationCoverage(): Promise<void> {
  const db = createFakeDb({ tables: { ai_usage_events: [] } });
  await insertAiUsageEvent(db.client as DbClient, {
    userId: ADVISOR,
    organizationId: PILOT_ORG,
    operation: "classification",
    modelId: "openai/gpt-5.4-mini",
    modelRole: "relationship_admission_interpreter",
  });
  const [event] = db.tables.ai_usage_events;
  assert.equal(
    event.organization_id,
    PILOT_ORG,
    "an Organization-scoped model call must correlate to its Organization"
  );
  assert.equal(
    event.model_role,
    "relationship_admission_interpreter",
    "the admission interpreter is attributable as its own role"
  );
}

// ============================================================
// Eval-set integrity — the bar exists before implementation closes
// ============================================================

function testEvalSetIsWellFormed(): void {
  assert.ok(
    typeof evalSet.failure_rate_bar === "number" &&
      evalSet.failure_rate_bar > 0 &&
      evalSet.failure_rate_bar < 1,
    "the failure-rate bar is stated as a number, not left implicit"
  );
  assert.ok(
    evalSet.scenarios.length >= 12,
    "the scenario set is large enough for the bar to mean something"
  );
  assert.ok(
    evalSet.scenarios.some((scenario) => scenario.adversarial),
    "adversarial cases are present (SA-2.6)"
  );
  const ids = new Set<string>();
  for (const scenario of evalSet.scenarios) {
    assert.ok(!ids.has(scenario.id), `duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    if (scenario.expected.objective_category !== null) {
      assert.ok(
        (ADMISSION_OBJECTIVE_CATEGORIES as readonly string[]).includes(
          scenario.expected.objective_category
        ),
        `${scenario.id}: expected category must be in the closed list`
      );
    }
    if (!scenario.expected.has_actionable_objective) {
      assert.equal(
        scenario.expected.objective_category,
        null,
        `${scenario.id}: no objective means no category`
      );
    }
  }
}

// ============================================================
// Runner
// ============================================================

const tests: Array<[string, () => void | Promise<void>]> = [
  ["SA-2.2 an admitted lead materialises exactly one Case", testAdmittedMaterialisesOneCase],
  ["SA-2.3 an ambiguous opener creates no Case", testAmbiguousCreatesNoCase],
  ["SA-2.3 an absent judgment behaves as ambiguity", testNoJudgmentIsAmbiguity],
  ["SA-2.4 duplicate after a completed admission returns the same Case", testDuplicateAfterCompletedAdmission],
  ["SA-2.4 duplicate after a completed refusal returns that refusal", testDuplicateAfterCompletedRefusal],
  ["SA-2.4 duplicate while in flight does not decide", testDuplicateWhileInFlight],
  ["SA-2.4 crash before any decision is reclaimable", testCrashBeforeDecision],
  ["SA-2.4 every materialisation crash boundary converges", testEveryMaterialisationCrashBoundaryConverges],
  ["SA-2.4 the original policy attribution survives a policy change", testOriginalPolicyAttributionSurvivesPolicyChange],
  ["SA-2.4 an expired claim is reclaimable", testExpiredClaimIsReclaimable],
  ["SA-2.4 a stale worker after settlement returns the canonical outcome", testStaleWorkerAfterSettlement],
  ["SA-2.4 a stale worker on an unsettled event reports lost claim", testStaleWorkerReportsLostClaim],
  ["SA-2.4 fenced helpers report non-application", testFencedHelpersReportNonApplication],
  ["SA-2.4 a mid-materialisation race converges to one artifact set", testMidMaterialisationRaceConverges],
  ["SA-2.4 late admission evidence does not overwrite newer truth", testLateAdmissionEvidenceDoesNotOverwriteNewerTruth],
  ["SA-2.4 no path yields two Cases or two contradictory answers", testNoPathProducesTwoCasesOrTwoAnswers],
  ["SA-2.4 distinct events are not deduplicated", testDistinctEventsAreNotDeduplicated],
  ["SA-2.5 a hard bound beats policy and confidence", testHardBoundWins],
  ["SA-2.6 an excluded category is not auto-admitted", testExcludedCategory],
  ["SA-2.6 a trusted source cannot bypass an exclusion", testTrustedSourceCannotBypassExclusion],
  ["SA-2.7 the platform baseline applies and is attributed", testPlatformBaselineApplies],
  ["SA-2.7 a draft policy is never runtime authority", testDraftPolicyIsNeverAuthority],
  ["SA-2.7 an invalid published policy fails closed", testInvalidPolicyFailsClosed],
  ["SA-2.7 the policy parser rejects partial shapes", testPolicyParserRejectsPartialShapes],
  ["SA-2.7 policy may require manual admission", testManualAdmissionRequired],
  ["SA-2.8 a cross-Organization lead is refused with zero writes", testCrossOrganizationLeadIsRefusedWithoutReads],
  ["SA-2.8 an unbound Organization is refused", testUnboundOrganizationIsRefused],
  ["SA-2.9 relationship_ops off is fully inert", testFlagOffIsInert],
  ["SA-2.9 an unimplemented mode is inert", testUnimplementedModeIsInert],
  ["SA-2.10 no prospect-facing effect is reachable", testNoProspectFacingEffectIsReachable],
  ["the proposal carries no decision field", testProposalCarriesNoDecision],
  ["an unknown category normalizes to other", testUnknownCategoryNormalizes],
  ["policy application is pure and testable", testPurePolicyApplication],
  ["a dedup key prefers the provider message id", testDedupKeyPrefersProviderId],
  ["a dedup key is stable across polls", testDedupKeyIsStableAcrossPolls],
  ["the latest inbound message ignores outbound", testLatestInboundIgnoresOutbound],
  ["the admission model call is correlated, not dropped", testAdmissionModelCallIsCorrelated],
  ["usage correlation persists the Organization", testUsageCorrelationCoverage],
  ["the eval set is well formed and has a stated bar", testEvalSetIsWellFormed],
];

async function main(): Promise<void> {
  let passed = 0;
  for (const [name, run] of tests) {
    await run();
    console.log(`  ok  ${name}`);
    passed += 1;
  }
  console.log(`relationship-admission selftest: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
