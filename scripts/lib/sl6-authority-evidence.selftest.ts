/**
 * Local selftests for the SL-6 T7-1 hosted-authority evidence harness.
 *
 * These prove the evaluator and runner contracts without staging, legacy
 * credentials, network, or product-state mutation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorityResolution, OperationalCase } from "@agents/types";
import {
  AUTO_SELECT_FLAGS,
  SL6_CANONICAL_BINDING_HELPER,
  SL6_EXPECTED_STAGING_PRODUCT_SHA,
  SL6_HOSTED_ENVIRONMENT,
  SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
  SL6_PRODUCT_SHA_PROVENANCE,
  SL6_STAGING_PROJECT_REF,
  attachEvidenceHygiene,
  bindingIdentityDigest,
  buildDiscoveryReport,
  buildDurableEvidence,
  DISCOVERY_INVENTORY_BANNER,
  DISCOVERY_NOT_RS2_BANNER,
  evaluateAssertionCountCoherence,
  evaluateBindingDiscovery,
  evaluateBoundedPlacementProbeObservation,
  evaluateCapabilityBookkeepingState,
  evaluateDiscoveryHygiene,
  evaluateEvidenceHygiene,
  evaluateOrganizationLegacyTargetBinding,
  evaluateSafeRawFailureDiagnostic,
  evaluateEvidencePins,
  finalizeAssertionCounts,
  evaluateFailSafePersistAdmission,
  evaluateFrozenMemberPins,
  evaluateGenuineFailSafeCandidate,
  evaluateGovernedAdmissionObservation,
  evaluateIndependentEquivalence,
  evaluateOracleIndependenceSources,
  evaluatePlacementProbeAdmission,
  planDiscoverPlacementProbes,
  evaluatePortfolioAuthorityConflictReadback,
  evaluateProductShaProvenance,
  evaluateRequiredRs2Satisfaction,
  evaluateRs2Items,
  evaluateSl6EvaluatorSourceContract,
  evaluateSl6HostedSafetyGate,
  evaluateSl6VerifierSourceContract,
  evaluateSourcePlacementObservation,
  expectedFirestoreProjectForLegacyEnv,
  organizationLegacyTargetAllowsCapability,
  evaluateTrackedTreeMatchesHead,
  evaluateVerifierSha,
  evidenceDigest,
  frozenConversationSetDigest,
  parseFrozenConversationManifest,
  parseSl6AuthorityArgs,
  productSourceForContract,
  type FrozenConversationMember,
  type PersistAdmissionInput,
  type ProductAuthorityObservation,
  type Sl6DiscoveryCandidateReport,
} from "./sl6-authority-evidence";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const ORG = "11111111-1111-1111-1111-111111111111";
const CASE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LEAD_A = "synthetic-lead-alpha";
const LEAD_B = "synthetic-lead-bravo";
const VERIFIER_SHA = "83ee7899779a05355299570563a1b3ad2f2fb385";
const OTHER_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function member(
  caseId: string,
  lead: string,
  overrides: Partial<FrozenConversationMember> = {}
): FrozenConversationMember {
  const observed = {
    organizationId: ORG,
    caseId,
    opaqueLeadRef: lead,
    provider: "whatsapp_business",
    threadKind: "gu",
    status: "active",
  };
  return {
    organizationId: ORG,
    caseId,
    opaqueLeadRef: lead,
    expectedOrganizationDigest: evidenceDigest(ORG),
    expectedCaseDigest: evidenceDigest(caseId),
    expectedLeadDigest: evidenceDigest(lead),
    expectedBindingDigest: bindingIdentityDigest(observed),
    ...overrides,
  };
}

function frozenSet() {
  return {
    version: 1 as const,
    organizationId: ORG,
    members: [member(CASE_A, LEAD_A), member(CASE_B, LEAD_B)],
  };
}

function discoverArgv(overrides: string[] = []): string[] {
  return [
    "--phase",
    "discover",
    "--env-file",
    ".env.staging.local",
    "--env",
    SL6_HOSTED_ENVIRONMENT,
    "--legacy-env",
    "stage",
    "--organization",
    ORG,
    "--case-id",
    CASE_A,
    ...overrides,
  ];
}

function evidenceArgv(overrides: string[] = []): string[] {
  return [
    "--phase",
    "evidence",
    "--env-file",
    ".env.staging.local",
    "--env",
    SL6_HOSTED_ENVIRONMENT,
    "--legacy-env",
    "stage",
    "--organization",
    ORG,
    "--conversations-file",
    "operator-local-conversations.json",
    "--product-sha",
    SL6_EXPECTED_STAGING_PRODUCT_SHA,
    ...overrides,
  ];
}

function product(
  overrides: Partial<ProductAuthorityObservation> = {}
): ProductAuthorityObservation {
  return {
    conversationAuthority: "gu",
    humanActive: false,
    observedOwnerRef: "synthetic-owner",
    answeredFrom: "legacy_conversation_authority_get",
    failSafeReason: null,
    ...overrides,
  };
}

function persistInput(
  overrides: Partial<PersistAdmissionInput> = {}
): PersistAdmissionInput {
  return {
    phase: "evidence",
    productVerdict: "unknown",
    frozenMember: true,
    observedOwnerRef: "synthetic-owner",
    acknowledgeDurableWrite: true,
    acknowledgeFailSafePersist: true,
    ...overrides,
  };
}

function operationalCase(caseId = CASE_A): OperationalCase {
  return {
    id: caseId,
    user_id: "00000000-0000-0000-0000-000000000001",
    case_type_id: "lead_opportunity",
    case_type: "lead_opportunity",
    status: "active",
    current_step: null,
    assigned_to_user_id: null,
    external_contact_jsonb: {},
    next_action_at: null,
    due_at: null,
    context_jsonb: {},
    version: 1,
    workflow_definition_id: null,
    workflow_definition_version: null,
    organization_id: ORG,
    runtime_authority: "legacy",
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
  };
}

function resolutionRow(state: "unknown" | "conflicting"): AuthorityResolution {
  return {
    id: "resolution-synthetic-1",
    organization_id: ORG,
    case_id: CASE_A,
    external_conversation_ref: LEAD_A,
    state,
    detected_at: "2026-09-18T12:00:00.000Z",
    fail_safe_reason: "synthetic",
    provenance_jsonb: {},
    runtime_authority_observed: "legacy",
    provider_message_id: null,
    resolved_at: null,
    resolved_as: null,
    created_at: "2026-09-18T12:00:00.000Z",
  };
}

function testPhaseSafety(): void {
  const discover = parseSl6AuthorityArgs(discoverArgv());
  assert.equal(discover.ok, true);
  assert.equal(discover.phase, "discover");
  assert.deepEqual(discover.inventoryCaseIds, [CASE_A]);
  assert.equal(
    evaluateFailSafePersistAdmission(persistInput({ phase: "discover" })).admitted,
    false
  );

  const missingManifest = parseSl6AuthorityArgs([
    "--phase",
    "evidence",
    "--organization",
    ORG,
  ]);
  assert.equal(missingManifest.ok, false);
  assert.match(missingManifest.reason, /conversations-file/);

  for (const flag of AUTO_SELECT_FLAGS) {
    const parsed = parseSl6AuthorityArgs(evidenceArgv([flag]));
    assert.equal(parsed.ok, false, flag);
    assert.match(parsed.reason, /never auto-selects/);
  }

  const mixed = parseSl6AuthorityArgs(evidenceArgv(["--case-id", CASE_A]));
  assert.equal(mixed.ok, false);
  const discoverJson = parseSl6AuthorityArgs(discoverArgv(["--json", "out.json"]));
  assert.equal(discoverJson.ok, false);
  assert.match(discoverJson.reason, /not RS-2 evidence/);
  console.log("  ok  phase safety: discover cannot persist; evidence requires frozen set; auto-select refused");
}

function testManifest(): void {
  const parsed = parseFrozenConversationManifest(frozenSet());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.reason);
  assert.equal(parsed.manifest.members.length, 2);
  const first = parsed.manifest.members[0];
  const pins = evaluateFrozenMemberPins(first, {
    organizationId: ORG,
    caseId: CASE_A,
    opaqueLeadRef: LEAD_A,
    provider: "whatsapp_business",
    threadKind: "gu",
    status: "active",
  });
  assert.equal(pins.ok, true);
  assert.equal(frozenConversationSetDigest(parsed.manifest.members), frozenConversationSetDigest(parsed.manifest.members));

  assert.equal(parseFrozenConversationManifest(null).ok, false);
  assert.equal(parseFrozenConversationManifest({ version: 1, organizationId: ORG, members: [] }).ok, false);
  assert.equal(
    parseFrozenConversationManifest({
      version: 1,
      organizationId: ORG,
      members: [member(CASE_A, LEAD_A), member(CASE_A, LEAD_B)],
    }).ok,
    false
  );
  assert.equal(
    parseFrozenConversationManifest({
      version: 1,
      organizationId: ORG,
      members: [{ ...member(CASE_A, LEAD_A), organizationId: CASE_B }],
    }).ok,
    false
  );
  const changed = evaluateFrozenMemberPins(first, {
    organizationId: ORG,
    caseId: CASE_A,
    opaqueLeadRef: LEAD_A,
    provider: "whatsapp_business",
    threadKind: "gu",
    status: "ended",
  });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /digest\/pin changed/);
  console.log("  ok  manifest: valid synthetic set accepted; malformed/duplicate/changed pin rejected");
}

function testOracleIndependence(): void {
  const takeoverFalse = {
    leadTakeoverActive: false,
    lastOwnerInteractionAt: null,
    numberKillSwitchActive: false,
    observedAt: "2026-09-18T12:00:00.000Z",
  };
  const productSaysHuman = product({
    conversationAuthority: "human_active",
    humanActive: true,
  });
  const result = evaluateIndependentEquivalence({
    id: "synthetic",
    product: productSaysHuman,
    oracleInputs: takeoverFalse,
  });
  assert.equal(result.oracle.humanActive, false);
  assert.equal(result.equivalence.agreed, false);
  assert.equal(result.equivalence.resolverHumanActive, true);
  assert.equal(result.equivalence.oracleHumanActive, false);

  const aligned = evaluateIndependentEquivalence({
    id: "aligned",
    product: product(),
    oracleInputs: takeoverFalse,
  });
  assert.equal(aligned.equivalence.agreed, true);
  console.log("  ok  oracle independence: product verdict does not become oracle input");
}

function testPersistenceGating(): void {
  assert.equal(evaluateFailSafePersistAdmission(persistInput()).admitted, true);
  assert.equal(
    evaluateFailSafePersistAdmission(persistInput({ productVerdict: "gu" })).admitted,
    false
  );
  assert.equal(
    evaluateFailSafePersistAdmission(
      persistInput({ productVerdict: "human_active" })
    ).admitted,
    false
  );
  assert.equal(
    evaluateFailSafePersistAdmission(persistInput({ phase: "discover" })).admitted,
    false
  );
  assert.equal(
    evaluateFailSafePersistAdmission(persistInput({ frozenMember: false })).admitted,
    false
  );
  assert.equal(
    evaluateFailSafePersistAdmission(persistInput({ observedOwnerRef: null })).admitted,
    false
  );
  assert.equal(
    evaluateFailSafePersistAdmission(
      persistInput({ acknowledgeDurableWrite: false })
    ).admitted,
    false
  );
  assert.equal(
    evaluateFailSafePersistAdmission(
      persistInput({ acknowledgeFailSafePersist: false })
    ).admitted,
    false
  );
  assert.equal(
    evaluateFailSafePersistAdmission(persistInput({ productVerdict: "conflicting" }))
      .admitted,
    true
  );
  console.log("  ok  persist gate: unknown/conflicting+requirements admit; agreement/takeover/discover/acks refuse");
}

function testPortfolioReadback(): void {
  const ok = evaluatePortfolioAuthorityConflictReadback({
    persistHelperReturnedId: "helper-return-is-not-proof",
    caseRow: operationalCase(),
    readBackResolutions: [resolutionRow("unknown")],
    now: new Date("2026-09-18T13:00:00.000Z"),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.usedPersistReturnValueAlone, false);
  assert.equal(ok.mustSurfaceAuthorityConflict, true);

  const helperOnly = evaluatePortfolioAuthorityConflictReadback({
    persistHelperReturnedId: "helper-return-is-not-proof",
    caseRow: operationalCase(),
    readBackResolutions: [],
    now: new Date("2026-09-18T13:00:00.000Z"),
  });
  assert.equal(helperOnly.ok, false);
  assert.match(helperOnly.reason, /not Portfolio proof/);
  console.log("  ok  Portfolio proof is persisted-state read-back, not the persist helper return");
}

function testRs2Semantics(): void {
  const allRequired = evaluateRs2Items({
    namedEquivalenceRecords: 2,
    unexplainedMissingEquivalence: false,
    takeoverHumanActiveObserved: true,
    unknownOrConflictingPersistedAndSurfaced: true,
    containmentHolds: true,
  });
  const allOk = evaluateRequiredRs2Satisfaction({
    executionCompleted: true,
    items: allRequired,
  });
  assert.equal(allOk.requiredRs2FullySatisfied, true);
  assert.equal(allOk.sliceDoneClaim, "not_claimed");

  const noTakeover = evaluateRs2Items({
    namedEquivalenceRecords: 2,
    unexplainedMissingEquivalence: false,
    takeoverHumanActiveObserved: false,
    unknownOrConflictingPersistedAndSurfaced: true,
    containmentHolds: true,
  });
  assert.equal(
    noTakeover.find((item) => item.id === "rs2_2_takeover_variation")?.status,
    "CONDITIONED_UNAVAILABLE"
  );
  assert.match(
    noTakeover.find((item) => item.id === "rs2_2_takeover_variation")?.detail ?? "",
    /must not be overstated/
  );
  assert.equal(
    evaluateRequiredRs2Satisfaction({ executionCompleted: true, items: noTakeover })
      .requiredRs2FullySatisfied,
    true
  );

  const unmet3 = evaluateRs2Items({
    namedEquivalenceRecords: 2,
    unexplainedMissingEquivalence: false,
    takeoverHumanActiveObserved: true,
    unknownOrConflictingPersistedAndSurfaced: false,
    containmentHolds: true,
  });
  const unmet3Overall = evaluateRequiredRs2Satisfaction({
    executionCompleted: true,
    items: unmet3,
  });
  assert.equal(
    unmet3.find((item) => item.id === "rs2_3_unknown_conflicting")?.status,
    "UNMET"
  );
  assert.equal(unmet3Overall.requiredRs2FullySatisfied, false);
  assert.match(unmet3Overall.reason, /item #3/);

  const unmet1 = evaluateRequiredRs2Satisfaction({
    executionCompleted: true,
    items: evaluateRs2Items({
      namedEquivalenceRecords: 0,
      unexplainedMissingEquivalence: true,
      takeoverHumanActiveObserved: true,
      unknownOrConflictingPersistedAndSurfaced: true,
      containmentHolds: true,
    }),
  });
  assert.equal(unmet1.requiredRs2FullySatisfied, false);

  const unmet4 = evaluateRequiredRs2Satisfaction({
    executionCompleted: true,
    items: evaluateRs2Items({
      namedEquivalenceRecords: 1,
      unexplainedMissingEquivalence: false,
      takeoverHumanActiveObserved: true,
      unknownOrConflictingPersistedAndSurfaced: true,
      containmentHolds: false,
    }),
  });
  assert.equal(unmet4.requiredRs2FullySatisfied, false);

  const incomplete = evaluateRequiredRs2Satisfaction({
    executionCompleted: false,
    items: allRequired,
  });
  assert.equal(incomplete.requiredRs2FullySatisfied, false);
  console.log("  ok  RS-2: completed run != PASS; #3 UNMET cannot fully satisfy; #2 is availability-conditioned");
}

function testHygieneAndArtifact(): void {
  const evidence = buildDurableEvidence({
    ranAt: "2026-09-18T14:00:00.000Z",
    productSha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    verifierSha: VERIFIER_SHA,
    guOsEnvironment: SL6_HOSTED_ENVIRONMENT,
    projectRef: SL6_STAGING_PROJECT_REF,
    legacyEnvironment: "stage",
    frozenConversationSetDigest: frozenConversationSetDigest(frozenSet().members),
    conversations: [
      {
        organizationDigest: evidenceDigest(ORG),
        caseDigest: evidenceDigest(CASE_A),
        leadDigest: evidenceDigest(LEAD_A),
        bindingDigest: member(CASE_A, LEAD_A).expectedBindingDigest,
        productVerdict: "unknown",
        oracleVerdict: null,
        oracleReason: "lead_takeover_not_boolean",
        agreed: true,
        takeoverHumanActiveObserved: false,
        unknownOrConflictingObserved: true,
        persistenceAdmitted: true,
        persistenceExercised: true,
        portfolioMustSurfaceAuthorityConflict: true,
        sourcePath: "gu2.users",
        adapter: "bootstrap_direct",
      },
    ],
    observedPlacement: ["gu2.users"],
    runtimeAuthorityMutated: false,
    checks: [{ assertion: "SA-6.9", label: "equivalence recorded", ok: true }],
    executionCompleted: true,
    namedEquivalenceRecords: 1,
    unexplainedMissingEquivalence: false,
    takeoverHumanActiveObserved: false,
    unknownOrConflictingPersistedAndSurfaced: true,
  });
  const hygiene = evaluateEvidenceHygiene(evidence);
  assert.equal(hygiene.ok, true);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(LEAD_A), false);
  assert.equal(serialized.includes(CASE_A), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(evidence.rs2.sliceDoneClaim, "not_claimed");
  assert.equal(evidence.sourcePlacement.conclusion, "not_concluded");
  assert.equal(evidence.containment.traditionalGuWrites.basis, "structural");
  assert.equal(evaluateEvidenceHygiene({ password: "secret" }).ok, false);
  console.log("  ok  hygiene: durable evidence uses digests and omits prohibited raw data");
}

function fixtureEvidenceChecks(checks: Parameters<typeof buildDurableEvidence>[0]["checks"]) {
  return buildDurableEvidence({
    ranAt: "2026-09-19T14:00:00.000Z",
    productSha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    verifierSha: VERIFIER_SHA,
    guOsEnvironment: SL6_HOSTED_ENVIRONMENT,
    projectRef: SL6_STAGING_PROJECT_REF,
    legacyEnvironment: "stage",
    frozenConversationSetDigest: frozenConversationSetDigest(frozenSet().members),
    conversations: [
      {
        organizationDigest: evidenceDigest(ORG),
        caseDigest: evidenceDigest(CASE_A),
        leadDigest: evidenceDigest(LEAD_A),
        bindingDigest: member(CASE_A, LEAD_A).expectedBindingDigest,
        productVerdict: "unknown",
        oracleVerdict: null,
        oracleReason: "lead_takeover_not_boolean",
        agreed: true,
        takeoverHumanActiveObserved: false,
        unknownOrConflictingObserved: true,
        persistenceAdmitted: true,
        persistenceExercised: true,
        portfolioMustSurfaceAuthorityConflict: true,
        sourcePath: "gu2.users",
        adapter: "bootstrap_direct",
      },
    ],
    observedPlacement: null,
    runtimeAuthorityMutated: false,
    checks,
    executionCompleted: true,
    namedEquivalenceRecords: 1,
    unexplainedMissingEquivalence: false,
    takeoverHumanActiveObserved: false,
    unknownOrConflictingPersistedAndSurfaced: true,
  });
}

function testAssertionCountCoherence(): void {
  const priorChecks = [
    { assertion: "legacy-target", label: "legacy target bound", ok: true },
    {
      assertion: "placement",
      label: "configured allowlist recorded; placement is not concluded",
      ok: true,
    },
    { assertion: "SA-6.11", label: "runtime_authority is unchanged", ok: true },
  ];

  // Historical defect: counters were computed, then hygiene was appended to the
  // same results array. That serialized four passing rows with passed/total = 3.
  const historicalStale = {
    passed: 3,
    failed: 0,
    total: 3,
    results: [
      ...priorChecks,
      {
        assertion: "hygiene",
        label: "durable evidence omits prohibited raw data",
        ok: true,
        detail: "durable evidence omits prohibited raw data",
      },
    ],
  };
  assert.equal(historicalStale.results.length, 4);
  assert.equal(historicalStale.total, 3);
  assert.equal(evaluateAssertionCountCoherence(historicalStale).ok, false);

  const evidence = fixtureEvidenceChecks(priorChecks);
  const hygiene = evaluateEvidenceHygiene(evidence);
  assert.equal(hygiene.ok, true);
  attachEvidenceHygiene(evidence, hygiene);

  assert.equal(
    evidence.assertions.results.some((result) => result.assertion === "hygiene"),
    true
  );
  assert.equal(evidence.assertions.results.length, evidence.assertions.total);
  assert.equal(
    evidence.assertions.passed + evidence.assertions.failed,
    evidence.assertions.total
  );
  assert.equal(evidence.assertions.failed, 0);
  assert.equal(evidence.assertions.passed, evidence.assertions.total);
  assert.equal(evidence.assertions.total, 4);
  assert.equal(evaluateAssertionCountCoherence(evidence.assertions).ok, true);

  const repaired = finalizeAssertionCounts({
    ...evidence,
    assertions: {
      passed: 3,
      failed: 0,
      total: 3,
      results: evidence.assertions.results.slice(),
    },
  });
  assert.equal(evaluateAssertionCountCoherence(repaired.assertions).ok, true);
  assert.equal(repaired.assertions.total, repaired.assertions.results.length);
  console.log(
    "  ok  assertion counts: hygiene included and counters match results after seal"
  );
}

function testProvenance(): void {
  assert.equal(evaluateVerifierSha("abc").ok, false);
  assert.equal(evaluateVerifierSha(VERIFIER_SHA).ok, true);
  const pinOk = evaluateProductShaProvenance({
    declaredProductSha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    observedLatestRelevantDeliverySha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    deliveryWorkflowId: SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
  });
  assert.equal(pinOk.ok, true);
  assert.equal(pinOk.hostedEvidenceReady, true);
  assert.equal(pinOk.provenanceClassification, SL6_PRODUCT_SHA_PROVENANCE);
  assert.notEqual(pinOk.productSha, VERIFIER_SHA);

  const newer = evaluateProductShaProvenance({
    declaredProductSha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    observedLatestRelevantDeliverySha: OTHER_SHA,
    deliveryWorkflowId: SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
  });
  assert.equal(newer.ok, false);
  assert.equal(newer.deliveryObservation, "newer_than_expected_pin");

  const wrongPin = evaluateProductShaProvenance({
    declaredProductSha: OTHER_SHA,
    observedLatestRelevantDeliverySha: OTHER_SHA,
    deliveryWorkflowId: SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
  });
  assert.equal(wrongPin.ok, false);

  const pins = evaluateEvidencePins({
    productSha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    verifierSha: VERIFIER_SHA,
    environment: SL6_HOSTED_ENVIRONMENT,
    projectRef: SL6_STAGING_PROJECT_REF,
    ranAt: "2026-09-18T14:00:00.000Z",
    productShaProvenance: SL6_PRODUCT_SHA_PROVENANCE,
  });
  assert.equal(pins.ok, true);
  assert.equal(
    evaluateEvidencePins({
      productSha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
      verifierSha: "short",
      environment: SL6_HOSTED_ENVIRONMENT,
      projectRef: SL6_STAGING_PROJECT_REF,
      ranAt: "2026-09-18T14:00:00.000Z",
      productShaProvenance: SL6_PRODUCT_SHA_PROVENANCE,
    }).ok,
    false
  );
  console.log("  ok  provenance: full verifier SHA required; product/verifier distinct; newer delivery fails closed");
}

function testHostedSafetyGate(): void {
  const happy = evaluateSl6HostedSafetyGate({
    argv: evidenceArgv(["--acknowledge-durable-write", "--acknowledge-fail-safe-persist"]),
    targetName: SL6_HOSTED_ENVIRONMENT,
    targetProjectRef: SL6_STAGING_PROJECT_REF,
  });
  assert.equal(happy.ok, true);

  assert.equal(
    evaluateSl6HostedSafetyGate({
      argv: evidenceArgv(),
      targetName: "production",
      targetProjectRef: SL6_STAGING_PROJECT_REF,
    }).ok,
    false
  );
  assert.equal(
    evaluateSl6HostedSafetyGate({
      argv: evidenceArgv(),
      targetName: SL6_HOSTED_ENVIRONMENT,
      targetProjectRef: "aaaaaaaaaaaaaaaaaaaa",
    }).ok,
    false
  );
  const noLegacy = evaluateSl6HostedSafetyGate({
    argv: [
      "--phase",
      "evidence",
      "--env",
      SL6_HOSTED_ENVIRONMENT,
      "--organization",
      ORG,
      "--conversations-file",
      "x.json",
    ],
    targetName: SL6_HOSTED_ENVIRONMENT,
    targetProjectRef: SL6_STAGING_PROJECT_REF,
  });
  assert.equal(noLegacy.ok, false);
  assert.match(noLegacy.reason, /legacy-env/);

  const prodLegacy = evaluateSl6HostedSafetyGate({
    argv: evidenceArgv().map((arg) => (arg === "stage" ? "prod" : arg)),
    targetName: SL6_HOSTED_ENVIRONMENT,
    targetProjectRef: SL6_STAGING_PROJECT_REF,
  });
  assert.equal(prodLegacy.ok, false);

  const discoverNoCases = evaluateSl6HostedSafetyGate({
    argv: [
      "--phase",
      "discover",
      "--env",
      SL6_HOSTED_ENVIRONMENT,
      "--legacy-env",
      "stage",
      "--organization",
      ORG,
    ],
    targetName: SL6_HOSTED_ENVIRONMENT,
    targetProjectRef: SL6_STAGING_PROJECT_REF,
  });
  assert.equal(discoverNoCases.ok, false);
  console.log("  ok  hosted safety gate: staging-only, expected ref, explicit legacy-env, no auto-select");
}

function testSourceContractsAndBinding(): void {
  const evaluatorSource = readFileSync(join(HERE, "sl6-authority-evidence.ts"), "utf8");
  const runnerSource = readFileSync(join(REPO, "scripts", "verify-sl6-authority.ts"), "utf8");
  const oracleSource = readFileSync(
    join(REPO, "apps", "web", "src", "lib", "authority-equivalence", "oracle.ts"),
    "utf8"
  );
  const resolverSource = readFileSync(
    join(REPO, "apps", "web", "src", "lib", "relationship-authority", "resolve.ts"),
    "utf8"
  );

  const evaluatorChecks = evaluateSl6EvaluatorSourceContract(evaluatorSource);
  assert.ok(
    evaluatorChecks.every((check) => check.ok),
    evaluatorChecks.filter((check) => !check.ok).map((check) => check.label).join("; ")
  );
  const runnerChecks = evaluateSl6VerifierSourceContract(runnerSource);
  assert.ok(
    runnerChecks.every((check) => check.ok),
    runnerChecks.filter((check) => !check.ok).map((check) => check.label).join("; ")
  );
  const independence = evaluateOracleIndependenceSources({
    evaluatorSource,
    runnerSource,
    oracleSource,
    resolverSource,
  });
  assert.ok(
    independence.every((check) => check.ok),
    independence.filter((check) => !check.ok).map((check) => check.label).join("; ")
  );

  assert.equal(
    /attachExternalConversationBinding\s*\(/.test(evaluatorSource),
    false
  );
  assert.equal(/attachExternalConversationBinding\s*\(/.test(runnerSource), false);
  assert.equal(/backfillAdmittedLegacyLeadIdentity\s*\(/.test(runnerSource), false);
  assert.equal(/recordAuthorityResolutionObservation\s*\(/.test(runnerSource), false);
  assert.equal(SL6_CANONICAL_BINDING_HELPER, "backfillAdmittedLegacyLeadIdentity");
  assert.match(runnerSource, /prepareGatewayProcessEnv/);
  assert.match(runnerSource, /planDiscoverPlacementProbes/);
  assert.match(runnerSource, /openHostedLegacyTargetAfterProbeAdmission/);
  assert.equal(runnerSource.includes("probeCandidates[0]"), false);
  assert.match(runnerSource, /not RS-2 evidence/);
  console.log("  ok  source contracts: oracle independence, gated clients, no second attach caller");
}

function testPlacementAndTree(): void {
  const placement = evaluateSourcePlacementObservation({ observedPlacement: null });
  assert.equal(placement.conclusion, "not_concluded");
  assert.deepEqual(placement.configuredAllowlist, ["gu2.users", "gu2.gunumbers"]);
  assert.deepEqual(placement.comparisonPaths, ["bot.users"]);
  assert.equal(
    evaluateSourcePlacementObservation({
      observedPlacement: ["gu2.users"],
    }).conclusion,
    "not_concluded"
  );
  const confirmed = evaluateSourcePlacementObservation({
    observedPlacement: null,
    capabilitySucceeded: true,
    fieldContributions: [{ field: "leadTakeoverActive", sourcePath: "gu2.users" }],
  });
  assert.equal(confirmed.conclusion, "confirmed");
  const mismatch = evaluateSourcePlacementObservation({
    observedPlacement: null,
    capabilitySucceeded: true,
    fieldContributions: [{ field: "leadTakeoverActive", sourcePath: "bot.users" }],
  });
  assert.equal(mismatch.conclusion, "mismatch");
  const missingField = evaluateSourcePlacementObservation({
    observedPlacement: ["gu2.users"],
    capabilitySucceeded: true,
    fieldContributions: [],
  });
  assert.equal(missingField.conclusion, "not_concluded");
  assert.equal(
    evaluateTrackedTreeMatchesHead({ unstagedStatus: 1, stagedStatus: 0 }).ok,
    false
  );
  assert.equal(
    evaluateTrackedTreeMatchesHead({ unstagedStatus: 0, stagedStatus: 0 }).ok,
    true
  );
  console.log("  ok  placement: capability provenance confirms, mismatch, or stays not_concluded");
}

function admittedObservation(
  overrides: Partial<Parameters<typeof evaluateGovernedAdmissionObservation>[0]> = {}
) {
  return evaluateGovernedAdmissionObservation({
    caseFound: true,
    caseInOrganization: true,
    caseId: CASE_A,
    caseType: "lead_opportunity",
    contextLegacyLeadId: LEAD_A,
    contextSourceEventId: "source-event-synthetic",
    sourceEventFound: true,
    sourceSystem: "traditional_gu",
    sourceEventStatus: "completed",
    disposition: "admitted",
    admittedCaseId: CASE_A,
    externalLeadRef: LEAD_A,
    ...overrides,
  });
}

function boundRow() {
  return {
    provider: "whatsapp_business",
    threadKind: "gu",
    status: "active",
    organizationId: ORG,
    caseId: CASE_A,
    opaqueLeadRef: LEAD_A,
  };
}

function testAdmissionAndBinding(): void {
  const admitted = admittedObservation();
  assert.equal(admitted.classification, "admitted");
  assert.equal(admitted.admittedEligible, true);

  assert.equal(admittedObservation({ caseFound: false }).classification, "missing");
  assert.equal(
    admittedObservation({ caseInOrganization: false }).classification,
    "invalid"
  );
  const notAdmitted = admittedObservation({ disposition: "rejected" });
  assert.equal(notAdmitted.classification, "not_admitted");
  assert.equal(notAdmitted.admittedEligible, false);

  const bound = evaluateBindingDiscovery({
    admittedEligible: true,
    bindings: [boundRow()],
  });
  assert.equal(bound.bound, true);
  assert.equal(bound.t7_3Candidate, false);

  const unbound = evaluateBindingDiscovery({
    admittedEligible: true,
    bindings: [],
  });
  assert.equal(unbound.bound, false);
  assert.equal(unbound.t7_3Candidate, true);
  assert.equal(
    evaluateGenuineFailSafeCandidate({
      bindingPresent: false,
      bound: false,
      legacyReadSucceeded: false,
      productVerdict: "conflicting",
    }).genuineUnknownOrConflictingCandidate,
    false
  );

  const notAdmittedUnbound = evaluateBindingDiscovery({
    admittedEligible: false,
    bindings: [],
  });
  assert.equal(notAdmittedUnbound.t7_3Candidate, false);
  console.log("  ok  admission/binding: admitted+bound is discoverable; unbound is T7-3 and not RS-2 #3");
}

function testDiscoveryClassification(): void {
  const agreement = evaluateIndependentEquivalence({
    id: "agreement",
    product: product(),
    oracleInputs: {
      leadTakeoverActive: false,
      lastOwnerInteractionAt: null,
      numberKillSwitchActive: false,
      observedAt: "2026-09-18T12:00:00.000Z",
    },
  });
  assert.equal(agreement.equivalence.agreed, true);
  assert.equal(agreement.oracle.humanActive, false);

  const takeover = evaluateIndependentEquivalence({
    id: "takeover",
    product: product({
      conversationAuthority: "human_active",
      humanActive: true,
    }),
    oracleInputs: {
      leadTakeoverActive: true,
      lastOwnerInteractionAt: "2026-09-18T11:58:00.000Z",
      numberKillSwitchActive: null,
      observedAt: "2026-09-18T12:00:00.000Z",
    },
  });
  assert.equal(takeover.oracle.humanActive, true);
  assert.equal(takeover.equivalence.agreed, true);

  const unknown = evaluateGenuineFailSafeCandidate({
    bindingPresent: true,
    bound: true,
    legacyReadSucceeded: true,
    productVerdict: "unknown",
  });
  assert.equal(unknown.genuineUnknownOrConflictingCandidate, true);
  const conflicting = evaluateGenuineFailSafeCandidate({
    bindingPresent: true,
    bound: true,
    legacyReadSucceeded: true,
    productVerdict: "conflicting",
  });
  assert.equal(conflicting.genuineUnknownOrConflictingCandidate, true);
  assert.equal(
    evaluateGenuineFailSafeCandidate({
      bindingPresent: true,
      bound: true,
      legacyReadSucceeded: false,
      productVerdict: "unknown",
    }).genuineUnknownOrConflictingCandidate,
    false
  );
  console.log("  ok  discovery classification: agreement, takeover, genuine fail-safe, failed-read exclusion");
}

function happyProbeAdmission(
  overrides: Partial<Parameters<typeof evaluatePlacementProbeAdmission>[0]> = {}
) {
  return evaluatePlacementProbeAdmission({
    phase: "discover",
    safetyGateOk: true,
    targetName: SL6_HOSTED_ENVIRONMENT,
    targetProjectRef: SL6_STAGING_PROJECT_REF,
    legacyEnv: "stage",
    organizationId: ORG,
    namedCaseCount: 1,
    trackedTreeMatchesHead: true,
    verifierShaOk: true,
    capabilityAttempted: true,
    placementConclusion: "not_concluded",
    capabilityFailureKind: "not_found",
    readOnly: true,
    ...overrides,
  });
}

function testPlacementProbeGate(): void {
  assert.equal(happyProbeAdmission().admitted, true);
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: "unconfirmed_fields" }).admitted,
    true
  );
  assert.equal(happyProbeAdmission({ capabilityAttempted: false }).admitted, false);
  assert.equal(happyProbeAdmission({ legacyEnv: null }).admitted, false);
  assert.equal(happyProbeAdmission({ legacyEnv: "prod" }).admitted, false);
  assert.equal(happyProbeAdmission({ namedCaseCount: 0 }).admitted, false);
  assert.equal(happyProbeAdmission({ trackedTreeMatchesHead: false }).admitted, false);
  assert.equal(happyProbeAdmission({ verifierShaOk: false }).admitted, false);
  assert.equal(happyProbeAdmission({ phase: "evidence" }).admitted, false);
  assert.equal(
    happyProbeAdmission({ placementConclusion: "confirmed" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ placementConclusion: "mismatch" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: "capability_failed" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: "other" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: null }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: "no_usable_credential" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: "gateway_disabled" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: "missing_binding" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({ capabilityFailureKind: "ambiguous_binding" }).admitted,
    false
  );
  assert.equal(
    happyProbeAdmission({
      placementConclusion: "mismatch",
      capabilityFailureKind: "not_found",
    }).admitted,
    false
  );

  const configured = evaluateBoundedPlacementProbeObservation({
    paths: [
      {
        path: "gu2.users",
        collectionExists: true,
        namedLeadExists: true,
        takeoverFieldPresent: true,
        lastOwnerFieldPresent: true,
        boundedCount: 1,
      },
      {
        path: "bot.users",
        collectionExists: true,
        namedLeadExists: false,
        takeoverFieldPresent: false,
        lastOwnerFieldPresent: false,
        boundedCount: 0,
      },
    ],
  });
  assert.equal(configured.conclusion, "confirmed");
  const comparisonOnly = evaluateBoundedPlacementProbeObservation({
    paths: [
      {
        path: "gu2.users",
        collectionExists: true,
        namedLeadExists: false,
        takeoverFieldPresent: false,
        lastOwnerFieldPresent: false,
        boundedCount: 0,
      },
      {
        path: "bot.users",
        collectionExists: true,
        namedLeadExists: true,
        takeoverFieldPresent: true,
        lastOwnerFieldPresent: true,
        boundedCount: 1,
      },
    ],
  });
  assert.equal(comparisonOnly.conclusion, "mismatch");
  console.log("  ok  placement-probe gate: capability-first, stage-only, named Cases, clean tree; no auto-correction");
}

function probePlanGates(
  overrides: Partial<Parameters<typeof planDiscoverPlacementProbes>[0]> = {}
) {
  return planDiscoverPlacementProbes({
    candidates: [],
    phase: "discover",
    safetyGateOk: true,
    targetName: SL6_HOSTED_ENVIRONMENT,
    targetProjectRef: SL6_STAGING_PROJECT_REF,
    legacyEnv: "stage",
    organizationId: ORG,
    namedCaseCount: 2,
    trackedTreeMatchesHead: true,
    verifierShaOk: true,
    readOnly: true,
    ...overrides,
  });
}

function probeFacts(
  candidateKey: string,
  overrides: Partial<Parameters<typeof planDiscoverPlacementProbes>[0]["candidates"][number]> = {}
) {
  return {
    candidateKey,
    capabilityAttempted: true,
    capabilityFailureKind: "not_found" as const,
    placementConclusion: "not_concluded" as const,
    probeLeadRef: `opaque-${candidateKey}`,
    ...overrides,
  };
}

function testPlacementProbeCandidateIsolation(): void {
  const eligibleThenOwnership = probePlanGates({
    candidates: [
      probeFacts("A"),
      probeFacts("B", { capabilityFailureKind: "capability_failed" }),
    ],
  });
  assert.deepEqual(eligibleThenOwnership.admittedKeys, ["A"]);
  assert.equal(eligibleThenOwnership.openTarget, true);
  assert.equal(
    eligibleThenOwnership.refused.some((row) => row.candidateKey === "B"),
    true
  );

  const eligibleThenCredential = probePlanGates({
    candidates: [
      probeFacts("A", { capabilityFailureKind: "unconfirmed_fields" }),
      probeFacts("B", { capabilityFailureKind: "no_usable_credential" }),
    ],
  });
  assert.deepEqual(eligibleThenCredential.admittedKeys, ["A"]);
  assert.equal(
    eligibleThenCredential.refused.some((row) => row.candidateKey === "B"),
    true
  );

  const eligibleThenMismatch = probePlanGates({
    candidates: [
      probeFacts("A"),
      probeFacts("B", {
        capabilityFailureKind: null,
        placementConclusion: "mismatch",
      }),
    ],
  });
  assert.deepEqual(eligibleThenMismatch.admittedKeys, ["A"]);
  assert.equal(
    eligibleThenMismatch.refused.some((row) => row.candidateKey === "B"),
    true
  );

  const ineligibleFirstDoesNotSuppress = probePlanGates({
    candidates: [
      probeFacts("B", { capabilityFailureKind: "capability_failed" }),
      probeFacts("A"),
    ],
  });
  assert.deepEqual(ineligibleFirstDoesNotSuppress.admittedKeys, ["A"]);
  assert.equal(ineligibleFirstDoesNotSuppress.openTarget, true);

  const mismatchAndCredentialAlone = probePlanGates({
    candidates: [
      probeFacts("mismatch", {
        capabilityFailureKind: null,
        placementConclusion: "mismatch",
      }),
      probeFacts("credential", { capabilityFailureKind: "no_usable_credential" }),
      probeFacts("other", { capabilityFailureKind: "other" }),
    ],
  });
  assert.deepEqual(mismatchAndCredentialAlone.admittedKeys, []);
  assert.equal(mismatchAndCredentialAlone.openTarget, false);

  console.log(
    "  ok  placement-probe isolation: candidate A eligibility cannot authorize candidate B"
  );
}

function discoveryCandidate(
  overrides: Partial<Sl6DiscoveryCandidateReport> = {}
): Sl6DiscoveryCandidateReport {
  return {
    caseDigest: evidenceDigest(CASE_A),
    leadDigest: evidenceDigest(LEAD_A),
    bindingDigest: bindingIdentityDigest(boundRow()),
    admittedEligible: true,
    admissionClassification: "admitted",
    bindingPresent: true,
    t73Candidate: false,
    legacyReadSucceeded: true,
    legacyReadFailureKind: null,
    legacyReadFailureFamily: null,
    legacyReadErrorName: null,
    legacyReadErrorCode: null,
    placementConclusion: "confirmed",
    placementReason: "capability provenance confirms the configured takeover source",
    takeoverHumanActiveObserved: false,
    killSwitchObserved: false,
    productOutcome: "gu",
    oracleOutcome: false,
    oracleReason: "legacy_bypass_bot_false",
    agreed: true,
    genuineUnknownOrConflictingCandidate: false,
    incidentalCredentialUsageBookkeeping: "possible",
    ...overrides,
  };
}

function boundOrgTargetInput(
  overrides: Partial<Parameters<typeof evaluateOrganizationLegacyTargetBinding>[0]> = {}
) {
  return {
    declaredLegacyEnv: "stage",
    firestorePresent: true,
    firestoreStatus: "active",
    firestoreProjectId: "unggafb",
    firestoreClientEmail: "gu-os-sl1-reader@unggafb.iam.gserviceaccount.com",
    mongoPresent: true,
    mongoStatus: "active",
    ...overrides,
  };
}

function boundOrgTarget(
  overrides: Partial<Parameters<typeof evaluateOrganizationLegacyTargetBinding>[0]> = {}
) {
  return evaluateOrganizationLegacyTargetBinding(boundOrgTargetInput(overrides));
}

function testOrganizationLegacyTargetBinding(): void {
  assert.equal(expectedFirestoreProjectForLegacyEnv("stage"), "unggafb");
  assert.equal(expectedFirestoreProjectForLegacyEnv("prod"), "ungga-full");
  assert.equal(expectedFirestoreProjectForLegacyEnv("production"), null);
  assert.equal(expectedFirestoreProjectForLegacyEnv(null), null);

  const stageBound = boundOrgTarget();
  assert.equal(stageBound.classification, "bound");
  assert.equal(organizationLegacyTargetAllowsCapability(stageBound), true);
  assert.equal(stageBound.expectedFirestoreProject, "unggafb");
  assert.equal(stageBound.configuredFirestoreProject, "unggafb");

  const knownMismatch = boundOrgTarget({ firestoreProjectId: "ungga-full" });
  assert.equal(knownMismatch.classification, "target_mismatch");
  assert.equal(organizationLegacyTargetAllowsCapability(knownMismatch), false);
  assert.equal(knownMismatch.expectedFirestoreProject, "unggafb");
  assert.equal(knownMismatch.configuredFirestoreProject, "ungga-full");

  const missingProvider = boundOrgTarget({ firestorePresent: false, firestoreProjectId: null });
  assert.equal(missingProvider.classification, "missing");
  assert.equal(organizationLegacyTargetAllowsCapability(missingProvider), false);

  const inactive = boundOrgTarget({ firestoreStatus: "inactive" });
  assert.equal(inactive.classification, "inactive_or_unusable");
  assert.equal(organizationLegacyTargetAllowsCapability(inactive), false);

  const incomplete = boundOrgTarget({ firestoreProjectId: null });
  assert.equal(incomplete.classification, "missing");

  const unknownEnv = boundOrgTarget({ declaredLegacyEnv: "production" });
  assert.equal(unknownEnv.classification, "missing");
  assert.equal(organizationLegacyTargetAllowsCapability(unknownEnv), false);

  const prodBound = boundOrgTarget({
    declaredLegacyEnv: "prod",
    firestoreProjectId: "ungga-full",
    firestoreClientEmail: "gu-os-sl1-reader@ungga-full.iam.gserviceaccount.com",
  });
  assert.equal(prodBound.classification, "bound");
  assert.equal(prodBound.expectedFirestoreProject, "ungga-full");
  assert.equal(organizationLegacyTargetAllowsCapability(prodBound), true);

  const prodMismatch = boundOrgTarget({
    declaredLegacyEnv: "prod",
    firestoreProjectId: "unggafb",
  });
  assert.equal(prodMismatch.classification, "target_mismatch");

  const missingMongo = boundOrgTarget({ mongoPresent: false, mongoStatus: null });
  assert.equal(missingMongo.classification, "missing");
  const inactiveMongo = boundOrgTarget({ mongoStatus: "error" });
  assert.equal(inactiveMongo.classification, "inactive_or_unusable");
  assert.equal(
    boundOrgTarget().reason.includes("Mongo") || boundOrgTarget().classification === "bound",
    true
  );
  console.log(
    "  ok  Organization target binding: stage->unggafb, stage+ungga-full mismatch, fail-closed incomplete"
  );
}

function testCapabilityBookkeepingState(): void {
  assert.equal(
    evaluateCapabilityBookkeepingState({ capabilityInvocationBegan: false }),
    "not_attempted"
  );
  assert.equal(
    evaluateCapabilityBookkeepingState({ capabilityInvocationBegan: true }),
    "possible"
  );

  const notAttempted = buildDiscoveryReport(
    [
      discoveryCandidate({
        legacyReadSucceeded: false,
        incidentalCredentialUsageBookkeeping: "not_attempted",
      }),
    ],
    boundOrgTarget({ firestoreProjectId: "ungga-full" })
  );
  assert.equal(notAttempted.incidentalCredentialUsageBookkeeping, "not_attempted");
  assert.equal(notAttempted.organizationLegacyTarget.classification, "target_mismatch");

  const succeeded = buildDiscoveryReport(
    [discoveryCandidate({ incidentalCredentialUsageBookkeeping: "possible" })],
    boundOrgTarget()
  );
  assert.equal(succeeded.incidentalCredentialUsageBookkeeping, "possible");

  const rawFailed = buildDiscoveryReport(
    [
      discoveryCandidate({
        legacyReadSucceeded: false,
        legacyReadFailureKind: "other",
        legacyReadFailureFamily: "mongo_driver",
        legacyReadErrorName: "MongoServerSelectionError",
        incidentalCredentialUsageBookkeeping: "possible",
      }),
    ],
    boundOrgTarget()
  );
  assert.equal(rawFailed.incidentalCredentialUsageBookkeeping, "possible");
  assert.equal(rawFailed.candidates[0]?.legacyReadFailureKind, "other");
  console.log(
    "  ok  bookkeeping: not_attempted until capability begins; raw failure does not reset it"
  );
}

function testSafeRawFailureDiagnostics(): void {
  const mongoSelection = evaluateSafeRawFailureDiagnostic(
    Object.assign(new Error("mongodb+srv://user:hunter2@cluster.example/gu2"), {
      name: "MongoServerSelectionError",
      code: undefined,
    })
  );
  assert.equal(mongoSelection.family, "mongo_driver");
  assert.equal(mongoSelection.errorName, "MongoServerSelectionError");
  assert.equal(mongoSelection.errorCode, null);
  assert.equal("message" in mongoSelection, false);
  assert.equal("stack" in mongoSelection, false);

  const mongoCoded = evaluateSafeRawFailureDiagnostic(
    Object.assign(new Error("connection refused"), {
      name: "MongoNetworkError",
      code: 50,
    })
  );
  assert.equal(mongoCoded.family, "mongo_driver");
  assert.equal(mongoCoded.errorCode, 50);

  const firestore = evaluateSafeRawFailureDiagnostic(
    Object.assign(new Error("7 PERMISSION_DENIED"), { name: "FirestoreError" })
  );
  assert.equal(firestore.family, "firestore_driver");
  assert.equal(firestore.errorName, "FirestoreError");

  const grpc = evaluateSafeRawFailureDiagnostic(
    Object.assign(new Error("14 UNAVAILABLE"), { name: "GrpcError" })
  );
  assert.equal(grpc.family, "firestore_driver");

  const moduleLoad = evaluateSafeRawFailureDiagnostic(
    Object.assign(new Error("Cannot find package mongodb"), {
      name: "Error",
      code: "ERR_MODULE_NOT_FOUND",
    })
  );
  assert.equal(moduleLoad.family, "module_load");
  assert.equal(moduleLoad.errorCode, "ERR_MODULE_NOT_FOUND");

  const generic = evaluateSafeRawFailureDiagnostic(new Error("unexpected boom"));
  assert.equal(generic.family, "unexpected");
  assert.equal(generic.errorName, "Error");

  const thrownObject = evaluateSafeRawFailureDiagnostic({
    name: "WeirdDriver",
    message: "mongodb+srv://secret",
    stack: "secret-stack",
    uri: "mongodb+srv://cluster",
  });
  assert.equal(thrownObject.family, "unexpected");
  assert.equal(thrownObject.errorName, "WeirdDriver");
  assert.equal(JSON.stringify(thrownObject).includes("mongodb"), false);
  assert.equal(JSON.stringify(thrownObject).includes("secret"), false);

  const primitive = evaluateSafeRawFailureDiagnostic(
    "mongodb+srv://user:password@cluster.example/gu2"
  );
  assert.equal(primitive.family, "unexpected");
  assert.equal(primitive.errorName, null);
  assert.equal(primitive.errorCode, null);
  assert.equal(JSON.stringify(primitive).includes("mongodb"), false);
  assert.equal(JSON.stringify(primitive).includes("password"), false);

  const hygiene = evaluateDiscoveryHygiene(
    buildDiscoveryReport(
      [
        discoveryCandidate({
          legacyReadSucceeded: false,
          legacyReadFailureKind: "other",
          legacyReadFailureFamily: mongoSelection.family,
          legacyReadErrorName: mongoSelection.errorName,
          legacyReadErrorCode: mongoSelection.errorCode,
          incidentalCredentialUsageBookkeeping: "possible",
        }),
      ],
      boundOrgTarget()
    )
  );
  assert.equal(hygiene.ok, true);

  const poisoned = evaluateEvidenceHygiene({
    ...buildDiscoveryReport([discoveryCandidate()], boundOrgTarget()),
    message: "raw driver text",
    stack: "at secret",
  });
  assert.equal(poisoned.ok, false);
  console.log("  ok  raw-failure diagnostics: metadata-only, no message/stack/URI/secrets");
}

function testCapabilityOrderingSourceContract(): void {
  const runnerSource = readFileSync(join(REPO, "scripts", "verify-sl6-authority.ts"), "utf8");
  const checks = evaluateSl6VerifierSourceContract(runnerSource);
  const ordering = checks.find(
    (check) =>
      check.label ===
      "prepares process-local encryption key after Organization legacy-target binding"
  );
  const gated = checks.find(
    (check) =>
      check.label === "capability reads are gated by capabilityAuthorized after target binding"
  );
  assert.equal(ordering?.ok, true, ordering?.detail);
  assert.equal(gated?.ok, true, gated?.detail);

  const movedRead = runnerSource.replace(
    "binding.bound && binding.opaqueLeadRef && params.capabilityAuthorized",
    "binding.bound && binding.opaqueLeadRef"
  );
  assert.equal(
    evaluateSl6VerifierSourceContract(movedRead).some(
      (check) =>
        check.label ===
          "capability reads are gated by capabilityAuthorized after target binding" &&
        !check.ok
    ),
    true
  );
  console.log(
    "  ok  ordering source-contract: capability cannot precede Organization target binding"
  );
}

function testDiscoveryOutputHygiene(): void {
  const report = buildDiscoveryReport([discoveryCandidate()], boundOrgTarget());
  assert.deepEqual(report.banners, [DISCOVERY_INVENTORY_BANNER, DISCOVERY_NOT_RS2_BANNER]);
  assert.equal(report.inventoryEqualsSelection, false);
  assert.equal(report.notRs2Evidence, true);
  assert.equal(report.rs2ItemsSatisfied.length, 0);
  assert.equal(report.sliceDoneClaim, "not_claimed");
  const hygiene = evaluateDiscoveryHygiene(report);
  assert.equal(hygiene.ok, true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(LEAD_A), false);
  assert.equal(serialized.includes(CASE_A), false);
  assert.equal(serialized.includes("inventory != selection"), true);
  assert.equal(serialized.includes("not RS-2 evidence"), true);
  assert.equal(serialized.includes("password"), false);
  console.log("  ok  discovery output: digest-oriented, inventory != selection, not RS-2 evidence");
}

function testHostedLeakageSurface(): void {
  const evaluatorSource = productSourceForContract(
    readFileSync(join(HERE, "sl6-authority-evidence.ts"), "utf8")
  );
  const selftestSource = readFileSync(join(HERE, "sl6-authority-evidence.selftest.ts"), "utf8");
  assert.equal(/from\s+["']@supabase\/supabase-js["']/.test(evaluatorSource), false);
  assert.equal(/from\s+["']@supabase\/supabase-js["']/.test(selftestSource), false);
  assert.equal(/from\s+["']mongodb["']/.test(selftestSource), false);
  assert.equal(/from\s+["']@google-cloud\/firestore["']/.test(selftestSource), false);
  assert.equal(/process\.env\.[A-Z0-9_]+/.test(selftestSource), false);
  console.log("  ok  local selftests do not construct hosted clients or require real credentials");
}

function main(): void {
  console.log("sl6 authority evidence selftest");
  testPhaseSafety();
  testManifest();
  testOracleIndependence();
  testPersistenceGating();
  testPortfolioReadback();
  testRs2Semantics();
  testHygieneAndArtifact();
  testAssertionCountCoherence();
  testProvenance();
  testHostedSafetyGate();
  testSourceContractsAndBinding();
  testPlacementAndTree();
  testAdmissionAndBinding();
  testDiscoveryClassification();
  testPlacementProbeGate();
  testPlacementProbeCandidateIsolation();
  testOrganizationLegacyTargetBinding();
  testCapabilityBookkeepingState();
  testSafeRawFailureDiagnostics();
  testCapabilityOrderingSourceContract();
  testDiscoveryOutputHygiene();
  testHostedLeakageSurface();
  console.log("sl6 authority evidence selftest: ok");
}

main();
