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
  insertAiUsageEvent,
  type DbClient,
} from "@agents/db";
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
  overrides: Parameters<typeof baseTables>[0] = {}
): FakeDb {
  return createFakeDb({
    tables: baseTables(overrides),
    uniqueIndexes: [
      { table: "source_events", columns: ["organization_id", "dedup_key"] },
    ],
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
// SA-2.4 — the same event twice yields one effective outcome
// ============================================================

async function testDuplicateSourceEvent(): Promise<void> {
  const db = harness();
  const first = await runAdmission(request(db));
  const second = await runAdmission(request(db));

  assert.equal(first.status, "evaluated");
  assert.equal(second.status, "evaluated");
  if (first.status !== "evaluated" || second.status !== "evaluated") return;

  assert.equal(first.outcome.deduplicated, false);
  assert.equal(second.outcome.deduplicated, true, "the collision is observable");

  // One inbox row, one Case, one disposition — however many deliveries arrive.
  assert.equal(db.tables.source_events.length, 1);
  assert.equal(db.tables.operational_cases.length, 1);
  assert.equal(second.outcome.case_id, null, "no second Case");
  assert.deepEqual(
    second.outcome.decision.disposition,
    first.outcome.decision.disposition,
    "the redelivery returns the original outcome, it does not decide again"
  );
  assert.equal(
    second.outcome.source_event_id,
    first.outcome.source_event_id,
    "both deliveries resolve to the same inbox row"
  );
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
  ["SA-2.4 the same event twice yields one outcome", testDuplicateSourceEvent],
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
  ["usage correlation covers the Organization", testUsageCorrelationCoverage],
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
