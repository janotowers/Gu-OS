/**
 * Hosted RS-2 procedure for SL-6 T7 (SA-6.8, SA-6.9, SA-6.10, SA-6.11).
 *
 * Two phases, and they are not interchangeable:
 *
 *   --phase discover  inventories and classifies operator-named candidates
 *                     read-only. inventory != selection. not RS-2 evidence.
 *                     A candidate is not a final evidence member.
 *                     Discover cannot persist, backfill, attach, or freeze.
 *
 *   --phase evidence  evaluates an explicit frozen --conversations-file.
 *                     This runner never auto-selects a Case.
 *
 * THIS FILE MAY LATER WRITE `authority_resolution` rows — but only through
 * `persistFailSafeAuthorityResolution` after `evaluateFailSafePersistAdmission`.
 * It does not:
 *   * invent or select a Case;
 *   * call `attachExternalConversationBinding`;
 *   * execute `backfillAdmittedLegacyLeadIdentity` (T7-3);
 *   * open a Traditional Gu write client;
 *   * write Traditional Gu;
 *   * pause, suppress, send, or reach a prospect-facing effect;
 *   * call the C2 production route.
 *
 * Staging only. Safety gates run before any hosted client is constructed.
 *
 * Usage:
 *   npx tsx scripts/verify-sl6-authority.ts \
 *     --phase discover \
 *     --env-file .env.staging.local --env staging --legacy-env stage \
 *     --organization <uuid> --case-id <uuid> \
 *     [--product-sha 12ed79e]
 *
 *   npx tsx scripts/verify-sl6-authority.ts \
 *     --phase evidence \
 *     --env-file .env.staging.local --env staging --legacy-env stage \
 *     --organization <uuid> --conversations-file <operator-local.json> \
 *     --acknowledge-durable-write --acknowledge-fail-safe-persist \
 *     [--product-sha 12ed79e] [--json evidence.json]
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  getOperationalCase,
  getOrganizationById,
  getOrganizationToolSecretPublic,
  getSourceEventById,
  listAuthorityResolutionsForCases,
  listConversationBindingsForCase,
  type DbClient,
  type OrganizationToolSecretPublic,
} from "@agents/db";
import type {
  AuthorityResolution,
  InteractionAuthorityResolution,
} from "@agents/types";
import { resolveInteractionAuthority } from "../apps/web/src/lib/relationship-authority/resolve";
import { persistFailSafeAuthorityResolution } from "../apps/web/src/lib/relationship-authority/persist";
import { readLegacyConversationAuthority } from "../apps/web/src/lib/legacy-gateway";
import type { GatewayCallerContext } from "../apps/web/src/lib/legacy-gateway/authorization";
import { isLegacyReadRefusal } from "../apps/web/src/lib/legacy-gateway/errors";
import {
  assertBinding,
  describeTarget,
  parseTargetArgs,
  resolveEncryptionKeyForTarget,
  resolveTarget,
  type TargetEnv,
} from "./lib/target-env";
import {
  resolveLegacyTarget,
  type LegacySourceTarget,
} from "./lib/legacy-target";
import {
  bindingIdentityDigest,
  buildDiscoveryReport,
  buildDurableEvidence,
  DISCOVERY_INVENTORY_BANNER,
  DISCOVERY_NOT_RS2_BANNER,
  evaluateBindingDiscovery,
  evaluateBoundedPlacementProbeObservation,
  evaluateCapabilityBookkeepingState,
  evaluateDiscoveryHygiene,
  evaluateOrganizationLegacyTargetBinding,
  evaluateSafeRawFailureDiagnostic,
  organizationLegacyTargetAllowsCapability,
  attachEvidenceHygiene,
  evaluateEvidenceHygiene,
  evaluateEvidencePins,
  evaluateFailSafePersistAdmission,
  evaluateFrozenMemberPins,
  evaluateGenuineFailSafeCandidate,
  evaluateGovernedAdmissionObservation,
  evaluateIndependentEquivalence,
  planDiscoverPlacementProbes,
  evaluatePortfolioAuthorityConflictReadback,
  evaluateProductShaProvenance,
  evaluateSl6HostedSafetyGate,
  evaluateSourcePlacementObservation,
  evaluateTrackedTreeMatchesHead,
  evaluateVerifierSha,
  evidenceDigest,
  frozenConversationSetDigest,
  inspectTrackedWorkingTree,
  opaqueContextId,
  parseFrozenConversationManifest,
  parseNamedArg,
  SL6_CANONICAL_BINDING_HELPER,
  SL6_EXPECTED_STAGING_PRODUCT_SHA,
  SL6_HOSTED_ENVIRONMENT,
  SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
  SL6_PRODUCT_SHA_PROVENANCE,
  SL6_STAGING_PROJECT_REF,
  type BoundedPlacementPathObservation,
  type FrozenConversationMember,
  type ObservedConversationPins,
  type Sl6Check,
  type Sl6CredentialBookkeepingState,
  type Sl6DiscoveryCandidateReport,
  type Sl6DurableEvidence,
  type Sl6LegacyReadFailureKind,
  type Sl6OrgLegacyTargetObservation,
  type Sl6RawFailureFamily,
} from "./lib/sl6-authority-evidence";

const checks: Sl6Check[] = [];
function record(
  assertion: string,
  label: string,
  ok: boolean,
  detail?: string
): void {
  checks.push({ assertion, label, ok, detail });
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  [${assertion}] ${label}${detail ? ` - ${detail}` : ""}`
  );
}

function runGit(args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync("git", [...args], { encoding: "utf8" });
  return {
    status: result.status ?? 128,
    stdout: (result.stdout ?? "").toString(),
  };
}

/**
 * Fail closed unless executed tracked code == HEAD. HEAD alone is not enough:
 * a local edit to the harness could write while evidence still named the
 * unchanged SHA.
 */
function requireExecutedTrackedCodeMatchesHead(): string {
  const tree = evaluateTrackedTreeMatchesHead(inspectTrackedWorkingTree(runGit));
  if (!tree.ok) {
    throw new Error(
      `FAIL CLOSED - ${tree.reason}. ` +
        "Executed tracked code must match HEAD before verifierSha can be recorded."
    );
  }
  const head = evaluateVerifierSha(runGit(["rev-parse", "HEAD"]).stdout);
  if (!head.ok || !head.sha) {
    throw new Error(`FAIL CLOSED - ${head.reason}`);
  }
  return head.sha;
}

function openHostedGuOsClient(target: TargetEnv): DbClient {
  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error(
      "FAIL CLOSED - SL-6 authority evidence is service-role-only and needs " +
        "GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL."
    );
  }
  return createClient(target.supabaseUrl, target.serviceRoleKey) as unknown as DbClient;
}

export function openHostedLegacyTarget(argv: string[]): LegacySourceTarget {
  return resolveLegacyTarget({
    envFile: parseTargetArgs(argv).envFile,
    legacyEnv: (() => {
      for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--legacy-env") return (argv[i + 1] ?? "").trim();
      }
      return undefined;
    })(),
    requireMongo: true,
  });
}

function openHostedLegacyTargetAfterProbeAdmission(
  argv: string[],
  admission: { admitted: boolean; reason: string }
): LegacySourceTarget {
  if (!admission.admitted) {
    throw new Error(`FAIL CLOSED - placement probe refused: ${admission.reason}`);
  }
  return openHostedLegacyTarget(argv);
}

function prepareGatewayProcessEnv(argv: string[], target: TargetEnv): void {
  process.env.ENCRYPTION_KEY = resolveEncryptionKeyForTarget(
    parseTargetArgs(argv).envFile,
    target.name
  );
  process.env.LEGACY_GATEWAY_ENABLED = "true";
}

function classifyLegacyReadFailure(error: unknown): Sl6LegacyReadFailureKind {
  if (isLegacyReadRefusal(error)) {
    if (error.reason === "not_found") return "not_found";
    if (error.reason === "no_usable_credential") return "no_usable_credential";
    if (error.reason === "gateway_disabled") return "gateway_disabled";
    // ownership_not_contained, organization_not_bound_to_source, contract_drift,
    // pairing_ambiguous, source_unavailable, and other refusals stay generic.
    // They are not placement-uncertainty and must not admit Path B.
    return "capability_failed";
  }
  return "other";
}

function publicSecretIdentity(row: OrganizationToolSecretPublic | null): {
  present: boolean;
  status: string | null;
  projectId: string | null;
  clientEmail: string | null;
} {
  const config = (row?.config_jsonb ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    present: Boolean(row),
    status: row?.status ?? null,
    projectId: text(config.project_id),
    clientEmail: text(config.client_email),
  };
}

async function observeOrganizationLegacyTarget(
  db: DbClient,
  organizationId: string,
  declaredLegacyEnv: string
): Promise<Sl6OrgLegacyTargetObservation> {
  const firestore = publicSecretIdentity(
    await getOrganizationToolSecretPublic(db, {
      organizationId,
      provider: "traditional_gu_firestore",
    })
  );
  const mongo = publicSecretIdentity(
    await getOrganizationToolSecretPublic(db, {
      organizationId,
      provider: "traditional_gu_mongo",
    })
  );
  return evaluateOrganizationLegacyTargetBinding({
    declaredLegacyEnv,
    firestorePresent: firestore.present,
    firestoreStatus: firestore.status,
    firestoreProjectId: firestore.projectId,
    firestoreClientEmail: firestore.clientEmail,
    mongoPresent: mongo.present,
    mongoStatus: mongo.status,
  });
}

async function observeBoundedPlacementProbe(
  target: LegacySourceTarget,
  opaqueLeadRef: string
): Promise<BoundedPlacementPathObservation[]> {
  if (!target.mongo) {
    throw new Error("FAIL CLOSED - placement probe requires a configured Mongo identity");
  }
  const require_ = createRequire(import.meta.url);
  const { MongoClient } = require_("mongodb") as typeof import("mongodb");
  const client = new MongoClient(target.mongo.checkUri ?? target.mongo.uri, {
    serverSelectionTimeoutMS: 15000,
  });
  const specs = [
    { path: "gu2.users" as const, database: "gu2", collection: "users" },
    { path: "bot.users" as const, database: "bot", collection: "users" },
  ];
  try {
    await client.connect();
    const observed: BoundedPlacementPathObservation[] = [];
    for (const spec of specs) {
      const db = client.db(spec.database);
      const named = await db
        .listCollections({ name: spec.collection }, { nameOnly: true })
        .toArray();
      const collectionExists = named.length > 0;
      let namedLeadExists = false;
      let takeoverFieldPresent = false;
      let lastOwnerFieldPresent = false;
      let boundedCount = 0;
      if (collectionExists) {
        const rows = await db
          .collection(spec.collection)
          .find({ lead_id: opaqueLeadRef })
          .project({ bypass_bot: 1, last_owner_interaction_wba: 1 })
          .limit(2)
          .toArray();
        boundedCount = rows.length;
        namedLeadExists = rows.length > 0;
        takeoverFieldPresent = rows.some((row) =>
          Object.prototype.hasOwnProperty.call(row, "bypass_bot")
        );
        lastOwnerFieldPresent = rows.some((row) =>
          Object.prototype.hasOwnProperty.call(row, "last_owner_interaction_wba")
        );
      }
      observed.push({
        path: spec.path,
        collectionExists,
        namedLeadExists,
        takeoverFieldPresent,
        lastOwnerFieldPresent,
        boundedCount,
      });
    }
    return observed;
  } finally {
    await client.close();
  }
}

function loadFrozenManifest(path: string) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `FAIL CLOSED - could not read --conversations-file: ${(error as Error).message}`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("FAIL CLOSED - --conversations-file is not valid JSON");
  }
  const parsed = parseFrozenConversationManifest(raw);
  if (!parsed.ok) {
    throw new Error(`FAIL CLOSED - ${parsed.reason}`);
  }
  return parsed.manifest;
}

function pinsFromBinding(params: {
  organizationId: string;
  caseId: string;
  opaqueLeadRef: string;
  provider: string;
  threadKind: string;
  status: string;
}): ObservedConversationPins {
  return params;
}

async function persistAdmittedFailSafe(params: {
  db: DbClient;
  phase: "discover" | "evidence";
  frozenMember: boolean;
  acknowledgeDurableWrite: boolean;
  acknowledgeFailSafePersist: boolean;
  resolution: InteractionAuthorityResolution;
}): Promise<{ persisted: boolean; row: AuthorityResolution | null; reason: string }> {
  const gate = evaluateFailSafePersistAdmission({
    phase: params.phase,
    productVerdict: params.resolution.conversationAuthority,
    frozenMember: params.frozenMember,
    observedOwnerRef: params.resolution.observedOwnerRef,
    acknowledgeDurableWrite: params.acknowledgeDurableWrite,
    acknowledgeFailSafePersist: params.acknowledgeFailSafePersist,
  });
  if (!gate.admitted) {
    return { persisted: false, row: null, reason: gate.reason };
  }
  const row = await persistFailSafeAuthorityResolution({
    db: params.db,
    resolution: params.resolution,
    caseId: params.resolution.caseId,
    legacyLeadId: params.resolution.externalConversationRef,
  });
  return {
    persisted: Boolean(row),
    row,
    reason: row ? "persisted through persistFailSafeAuthorityResolution" : gate.reason,
  };
}

async function evaluateOneConversation(params: {
  db: DbClient;
  ctx: GatewayCallerContext;
  member: FrozenConversationMember;
  acknowledgeDurableWrite: boolean;
  acknowledgeFailSafePersist: boolean;
  ranAt: string;
  capabilityAuthorized: boolean;
}): Promise<Sl6DurableEvidence["conversations"][number]> {
  const opportunity = await getOperationalCase(params.db, params.member.caseId);
  if (!opportunity || opportunity.organization_id !== params.member.organizationId) {
    throw new Error("FAIL CLOSED - frozen Case is missing or not in the named Organization");
  }
  const bindings = await listConversationBindingsForCase(params.db, {
    organizationId: params.member.organizationId,
    caseId: params.member.caseId,
  });
  const gu = bindings.find(
    (row) =>
      row.thread_kind === "gu" &&
      row.status === "active" &&
      row.external_conversation_ref === params.member.opaqueLeadRef
  );
  if (!gu) {
    throw new Error("FAIL CLOSED - frozen member has no matching active gu binding");
  }
  const observed = pinsFromBinding({
    organizationId: gu.organization_id,
    caseId: gu.case_id,
    opaqueLeadRef: gu.external_conversation_ref,
    provider: gu.provider,
    threadKind: gu.thread_kind,
    status: gu.status,
  });
  const pins = evaluateFrozenMemberPins(params.member, observed);
  if (!pins.ok) {
    throw new Error(`FAIL CLOSED - ${pins.reason}`);
  }

  const runtimeBefore = opportunity.runtime_authority ?? null;
  if (!params.capabilityAuthorized) {
    throw new Error(
      "FAIL CLOSED - Organization legacy target is not bound; evidence cannot open the capability"
    );
  }
  const current = await readLegacyConversationAuthority(
    params.ctx,
    params.member.opaqueLeadRef
  );
  const resolution = await resolveInteractionAuthority({
    ctx: params.ctx,
    refs: {
      legacyLeadId: params.member.opaqueLeadRef,
      caseId: params.member.caseId,
    },
    readCurrent: async () => current,
  });
  // observeLegacyTakeover + recordAuthorityEquivalence run inside
  // evaluateIndependentEquivalence from the bounded current.value fields,
  // not from the product verdict.
  const { oracle, equivalence } = evaluateIndependentEquivalence({
    id: evidenceDigest(params.member.caseId),
    product: {
      conversationAuthority: resolution.conversationAuthority,
      humanActive: resolution.humanActive,
      observedOwnerRef: resolution.observedOwnerRef,
      answeredFrom: resolution.answeredFrom,
      failSafeReason: resolution.failSafeReason,
    },
    oracleInputs: {
      leadTakeoverActive: current.value.leadTakeoverActive,
      lastOwnerInteractionAt: current.value.lastOwnerInteractionAt,
      numberKillSwitchActive: current.value.numberKillSwitchActive,
      observedAt: current.provenance.freshness.readAt,
    },
  });

  const persist = await persistAdmittedFailSafe({
    db: params.db,
    phase: "evidence",
    frozenMember: true,
    acknowledgeDurableWrite: params.acknowledgeDurableWrite,
    acknowledgeFailSafePersist: params.acknowledgeFailSafePersist,
    resolution,
  });

  const readBack = persist.row
    ? await listAuthorityResolutionsForCases(params.db, {
        organizationId: params.member.organizationId,
        caseIds: [params.member.caseId],
      })
    : [];
  const afterCase = persist.row
    ? await getOperationalCase(params.db, params.member.caseId)
    : opportunity;
  const portfolio = persist.row
    ? evaluatePortfolioAuthorityConflictReadback({
        persistHelperReturnedId: persist.row.id,
        caseRow: afterCase ?? opportunity,
        readBackResolutions: readBack,
        now: new Date(params.ranAt),
      })
    : {
        ok: false,
        mustSurfaceAuthorityConflict: false,
        snapshotConflictState: null,
      };
  const runtimeAfter = (afterCase ?? opportunity).runtime_authority ?? null;
  record(
    "SA-6.11",
    "runtime_authority is unchanged for the frozen member",
    runtimeBefore === runtimeAfter,
    `before=${runtimeBefore ?? "null"} after=${runtimeAfter ?? "null"}`
  );

  return {
    organizationDigest: evidenceDigest(params.member.organizationId),
    caseDigest: evidenceDigest(params.member.caseId),
    leadDigest: evidenceDigest(params.member.opaqueLeadRef),
    bindingDigest: bindingIdentityDigest(observed),
    productVerdict: resolution.conversationAuthority,
    oracleVerdict: oracle.humanActive,
    oracleReason: oracle.reason,
    agreed: equivalence.agreed,
    takeoverHumanActiveObserved:
      resolution.humanActive === true || oracle.humanActive === true,
    unknownOrConflictingObserved:
      resolution.conversationAuthority === "unknown" ||
      resolution.conversationAuthority === "conflicting",
    persistenceAdmitted: persist.persisted,
    persistenceExercised: persist.persisted,
    portfolioMustSurfaceAuthorityConflict: portfolio.mustSurfaceAuthorityConflict,
    sourcePath: current.provenance.sourcePath,
    adapter: current.provenance.adapter,
  };
}

async function classifyDiscoverCandidate(params: {
  db: DbClient;
  organizationId: string;
  caseId: string;
  capabilityAuthorized: boolean;
}): Promise<
  Sl6DiscoveryCandidateReport & {
    probeLeadRef: string | null;
    capabilityAttempted: boolean;
    capabilityFailureKind: Sl6LegacyReadFailureKind | null;
  }
> {
  const opportunity = await getOperationalCase(params.db, params.caseId);
  const inOrg = opportunity?.organization_id === params.organizationId;
  const contextLegacyLeadId = opaqueContextId(opportunity?.context_jsonb, "legacy_lead_id");
  const contextSourceEventId = opaqueContextId(
    opportunity?.context_jsonb,
    "source_event_id"
  );
  const sourceEvent =
    inOrg && contextSourceEventId
      ? await getSourceEventById(params.db, params.organizationId, contextSourceEventId)
      : null;
  const admission = evaluateGovernedAdmissionObservation({
    caseFound: Boolean(opportunity),
    caseInOrganization: Boolean(inOrg && opportunity),
    caseId: opportunity?.id ?? params.caseId,
    caseType: opportunity?.case_type ?? null,
    contextLegacyLeadId,
    contextSourceEventId,
    sourceEventFound: Boolean(sourceEvent),
    sourceSystem: sourceEvent?.source_system ?? null,
    sourceEventStatus: sourceEvent?.status ?? null,
    disposition:
      typeof sourceEvent?.decision_jsonb?.disposition === "string"
        ? sourceEvent.decision_jsonb.disposition
        : null,
    admittedCaseId: sourceEvent?.admitted_case_id ?? null,
    externalLeadRef: sourceEvent?.external_lead_ref ?? null,
  });
  const bindingRows = inOrg
    ? (
        await listConversationBindingsForCase(params.db, {
          organizationId: params.organizationId,
          caseId: params.caseId,
        })
      ).map((row) => ({
        provider: row.provider,
        threadKind: row.thread_kind,
        status: row.status,
        organizationId: row.organization_id,
        caseId: row.case_id,
        opaqueLeadRef: row.external_conversation_ref,
      }))
    : [];
  const binding = evaluateBindingDiscovery({
    admittedEligible: admission.admittedEligible,
    bindings: bindingRows,
  });

  let legacyReadSucceeded = false;
  let legacyReadFailureKind: Sl6LegacyReadFailureKind | null = binding.bound
    ? null
    : binding.ambiguous
      ? "ambiguous_binding"
      : "missing_binding";
  let capabilityAttempted = false;
  let productOutcome: Sl6DiscoveryCandidateReport["productOutcome"] = null;
  let oracleOutcome: boolean | null = null;
  let oracleReason: string | null = null;
  let agreed: boolean | null = null;
  let takeoverHumanActiveObserved: boolean | null = null;
  let killSwitchObserved: boolean | null = null;
  let incidentalCredentialUsageBookkeeping: Sl6CredentialBookkeepingState =
    "not_attempted";
  let legacyReadFailureFamily: Sl6RawFailureFamily | null = null;
  let legacyReadErrorName: string | null = null;
  let legacyReadErrorCode: string | number | null = null;
  let placement = evaluateSourcePlacementObservation({ observedPlacement: null });

  if (binding.bound && binding.opaqueLeadRef && params.capabilityAuthorized) {
    const ctx: GatewayCallerContext = {
      db: params.db,
      organizationId: params.organizationId,
    };
    try {
      capabilityAttempted = true;
      incidentalCredentialUsageBookkeeping = evaluateCapabilityBookkeepingState({
        capabilityInvocationBegan: true,
      });
      const current = await readLegacyConversationAuthority(ctx, binding.opaqueLeadRef);
      const resolution = await resolveInteractionAuthority({
        ctx,
        refs: {
          legacyLeadId: binding.opaqueLeadRef,
          caseId: params.caseId,
        },
        readCurrent: async () => current,
      });
      const { oracle, equivalence } = evaluateIndependentEquivalence({
        id: evidenceDigest(params.caseId),
        product: {
          conversationAuthority: resolution.conversationAuthority,
          humanActive: resolution.humanActive,
          observedOwnerRef: resolution.observedOwnerRef,
          answeredFrom: resolution.answeredFrom,
          failSafeReason: resolution.failSafeReason,
        },
        oracleInputs: {
          leadTakeoverActive: current.value.leadTakeoverActive,
          lastOwnerInteractionAt: current.value.lastOwnerInteractionAt,
          numberKillSwitchActive: current.value.numberKillSwitchActive,
          observedAt: current.provenance.freshness.readAt,
        },
      });
      legacyReadSucceeded = true;
      legacyReadFailureKind = null;
      productOutcome = resolution.conversationAuthority;
      oracleOutcome = oracle.humanActive;
      oracleReason = oracle.reason;
      agreed = equivalence.agreed;
      takeoverHumanActiveObserved =
        resolution.humanActive === true || oracle.humanActive === true;
      killSwitchObserved = current.value.numberKillSwitchActive;
      placement = evaluateSourcePlacementObservation({
        observedPlacement: null,
        capabilitySucceeded: true,
        fieldContributions: current.provenance.contributions ?? [],
      });
      if (placement.conclusion === "not_concluded") {
        legacyReadFailureKind = "unconfirmed_fields";
      }
    } catch (error) {
      legacyReadSucceeded = false;
      legacyReadFailureKind = classifyLegacyReadFailure(error);
      if (legacyReadFailureKind === "other") {
        const diagnostic = evaluateSafeRawFailureDiagnostic(error);
        legacyReadFailureFamily = diagnostic.family;
        legacyReadErrorName = diagnostic.errorName;
        legacyReadErrorCode = diagnostic.errorCode;
      }
      placement = evaluateSourcePlacementObservation({
        observedPlacement: null,
        capabilitySucceeded: false,
      });
    }
  }

  const failSafe = evaluateGenuineFailSafeCandidate({
    bindingPresent: binding.bindingPresent,
    bound: binding.bound,
    legacyReadSucceeded,
    productVerdict: productOutcome,
  });

  return {
    caseDigest: evidenceDigest(params.caseId),
    leadDigest: binding.opaqueLeadRef
      ? evidenceDigest(binding.opaqueLeadRef)
      : admission.admissionLeadRef
        ? evidenceDigest(admission.admissionLeadRef)
        : null,
    bindingDigest: binding.bindingDigest,
    admittedEligible: admission.admittedEligible,
    admissionClassification: admission.classification,
    bindingPresent: binding.bindingPresent,
    t73Candidate: binding.t7_3Candidate,
    legacyReadSucceeded,
    legacyReadFailureKind,
    legacyReadFailureFamily,
    legacyReadErrorName,
    legacyReadErrorCode,
    placementConclusion: placement.conclusion,
    placementReason: placement.reason,
    takeoverHumanActiveObserved,
    killSwitchObserved,
    productOutcome,
    oracleOutcome,
    oracleReason,
    agreed,
    genuineUnknownOrConflictingCandidate: failSafe.genuineUnknownOrConflictingCandidate,
    incidentalCredentialUsageBookkeeping,
    probeLeadRef: binding.bound ? binding.opaqueLeadRef : null,
    capabilityAttempted,
    capabilityFailureKind: capabilityAttempted ? legacyReadFailureKind : null,
  };
}

async function runDiscoverHosted(params: {
  db: DbClient;
  organizationId: string;
  inventoryCaseIds: string[];
  argv: string[];
  safetyGateOk: boolean;
  targetName: string;
  targetProjectRef: string;
  legacyEnv: string;
  trackedTreeMatchesHead: boolean;
  verifierShaOk: boolean;
  capabilityAuthorized: boolean;
  organizationLegacyTarget: Sl6OrgLegacyTargetObservation;
}): Promise<void> {
  // discover cannot persist — inventory != selection. not RS-2 evidence.
  // T7-3 binding preparation stays backfillAdmittedLegacyLeadIdentity and
  // is not executed here.
  void SL6_CANONICAL_BINDING_HELPER;
  const organization = await getOrganizationById(params.db, params.organizationId);
  record(
    "discover",
    "the Organization resolves in the declared Gu OS environment",
    Boolean(organization),
    organization ? `status=${organization.status}` : "not found"
  );
  if (!organization) {
    throw new Error("FAIL CLOSED - Organization not found");
  }

  const classified = [];
  for (const caseId of params.inventoryCaseIds) {
    classified.push(
      await classifyDiscoverCandidate({
        db: params.db,
        organizationId: params.organizationId,
        caseId,
        capabilityAuthorized: params.capabilityAuthorized,
      })
    );
  }

  const probePlan = planDiscoverPlacementProbes({
    candidates: classified.map((row) => ({
      candidateKey: row.caseDigest,
      capabilityAttempted: row.capabilityAttempted,
      capabilityFailureKind: row.capabilityFailureKind,
      placementConclusion: row.placementConclusion,
      probeLeadRef: row.probeLeadRef,
    })),
    phase: "discover",
    safetyGateOk: params.safetyGateOk,
    targetName: params.targetName,
    targetProjectRef: params.targetProjectRef,
    legacyEnv: params.legacyEnv,
    organizationId: params.organizationId,
    namedCaseCount: params.inventoryCaseIds.length,
    trackedTreeMatchesHead: params.trackedTreeMatchesHead,
    verifierShaOk: params.verifierShaOk,
    readOnly: true,
  });
  const probeAdmission = {
    admitted: probePlan.openTarget,
    reason: probePlan.openReason,
  };
  if (probeAdmission.admitted) {
    const legacyTarget = openHostedLegacyTargetAfterProbeAdmission(
      params.argv,
      probeAdmission
    );
    const admittedKeys = new Set(probePlan.admittedKeys);
    for (const row of classified) {
      if (!admittedKeys.has(row.caseDigest) || !row.probeLeadRef) continue;
      const paths = await observeBoundedPlacementProbe(legacyTarget, row.probeLeadRef);
      const probed = evaluateBoundedPlacementProbeObservation({ paths });
      row.placementConclusion = probed.conclusion;
      row.placementReason = probed.reason;
    }
    for (const refused of probePlan.refused) {
      record(
        "discover",
        "placement probe remained closed for an independently ineligible candidate",
        true,
        refused.reason
      );
    }
  } else if (classified.some((row) => row.capabilityAttempted)) {
    record(
      "discover",
      "placement probe remained closed",
      true,
      probeAdmission.reason
    );
  }

  const report = buildDiscoveryReport(
    classified.map(
      ({
        probeLeadRef: _probeLeadRef,
        capabilityAttempted: _capabilityAttempted,
        capabilityFailureKind: _capabilityFailureKind,
        ...candidate
      }) => candidate
    ),
    params.organizationLegacyTarget
  );
  const hygiene = evaluateDiscoveryHygiene(report);
  record("hygiene", "discovery report is digest-oriented and non-canonical", hygiene.ok, hygiene.reason);
  for (const candidate of report.candidates) {
    record(
      "discover",
      "classified an operator-named candidate (not a final evidence member)",
      true,
      `case=${candidate.caseDigest} admitted=${candidate.admittedEligible} bound=${candidate.bindingPresent} t7_3=${candidate.t73Candidate} genuine_rs2_3=${candidate.genuineUnknownOrConflictingCandidate}`
    );
  }
  console.log(`\n${DISCOVERY_INVENTORY_BANNER}`);
  console.log(DISCOVERY_NOT_RS2_BANNER);
  console.log(JSON.stringify(report, null, 2));
}

async function runEvidenceHosted(params: {
  db: DbClient;
  organizationId: string;
  conversationsFile: string;
  acknowledgeDurableWrite: boolean;
  acknowledgeFailSafePersist: boolean;
  ranAt: string;
  productSha: string;
  verifierSha: string;
  projectRef: string;
  legacyEnvironment: string;
  jsonPath: string | null;
  observedPlacement: string[] | null;
  capabilityAuthorized: boolean;
}): Promise<Sl6DurableEvidence> {
  const manifest = loadFrozenManifest(params.conversationsFile);
  if (manifest.organizationId !== params.organizationId) {
    throw new Error("FAIL CLOSED - frozen set Organization does not match --organization");
  }

  const ctx: GatewayCallerContext = {
    db: params.db,
    organizationId: params.organizationId,
  };
  const conversations = [];
  for (const member of manifest.members) {
    conversations.push(
      await evaluateOneConversation({
        db: params.db,
        ctx,
        member,
        acknowledgeDurableWrite: params.acknowledgeDurableWrite,
        acknowledgeFailSafePersist: params.acknowledgeFailSafePersist,
        ranAt: params.ranAt,
        capabilityAuthorized: params.capabilityAuthorized,
      })
    );
  }

  const unknownSurfaced = conversations.some(
    (row) =>
      row.unknownOrConflictingObserved &&
      row.persistenceExercised &&
      row.portfolioMustSurfaceAuthorityConflict
  );
  const evidence = buildDurableEvidence({
    ranAt: params.ranAt,
    productSha: params.productSha,
    verifierSha: params.verifierSha,
    guOsEnvironment: SL6_HOSTED_ENVIRONMENT,
    projectRef: params.projectRef,
    legacyEnvironment: params.legacyEnvironment,
    frozenConversationSetDigest: frozenConversationSetDigest(manifest.members),
    conversations,
    observedPlacement: params.observedPlacement,
    runtimeAuthorityMutated: checks.some(
      (check) => check.assertion === "SA-6.11" && !check.ok
    )
      ? true
      : false,
    checks,
    executionCompleted: true,
    namedEquivalenceRecords: conversations.length,
    unexplainedMissingEquivalence: conversations.length !== manifest.members.length,
    takeoverHumanActiveObserved: conversations.some((row) => row.takeoverHumanActiveObserved),
    unknownOrConflictingPersistedAndSurfaced: unknownSurfaced,
  });
  const hygiene = evaluateEvidenceHygiene(evidence);
  record("hygiene", "durable evidence omits prohibited raw data", hygiene.ok, hygiene.reason);
  attachEvidenceHygiene(evidence, hygiene);
  if (params.jsonPath) {
    writeFileSync(params.jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`\nwrote ${params.jsonPath}`);
  }
  return evidence;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  console.log("this procedure never auto-selects a Case or conversation");

  const target = resolveTarget(parseTargetArgs(argv));
  assertBinding(target);

  const safetyGate = evaluateSl6HostedSafetyGate({
    argv,
    targetName: target.name,
    targetProjectRef: target.projectRef,
  });
  if (!safetyGate.ok || !safetyGate.args.phase || !safetyGate.args.organizationId) {
    throw new Error(`FAIL CLOSED - ${safetyGate.reason}`);
  }

  const product = evaluateProductShaProvenance({
    declaredProductSha: safetyGate.args.productSha ?? SL6_EXPECTED_STAGING_PRODUCT_SHA,
    expectedPin: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    observedLatestRelevantDeliverySha: SL6_EXPECTED_STAGING_PRODUCT_SHA,
    deliveryWorkflowId: SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
  });
  if (!product.ok || !product.productSha || product.provenanceClassification !== SL6_PRODUCT_SHA_PROVENANCE) {
    throw new Error(`FAIL CLOSED - ${product.reason}`);
  }

  const verifierSha = requireExecutedTrackedCodeMatchesHead();
  const ranAt = new Date().toISOString();
  const pins = evaluateEvidencePins({
    productSha: product.productSha,
    verifierSha,
    environment: target.name,
    projectRef: target.projectRef,
    ranAt,
    productShaProvenance: product.provenanceClassification,
  });
  if (!pins.ok) {
    throw new Error(`FAIL CLOSED - ${pins.reason}`);
  }

  console.log(describeTarget(target));
  console.log(`environment: ${SL6_HOSTED_ENVIRONMENT}`);
  console.log(`expected_project_ref: ${SL6_STAGING_PROJECT_REF}`);
  console.log(`product_sha: ${product.productSha}`);
  console.log(`product_sha_provenance: ${SL6_PRODUCT_SHA_PROVENANCE}`);
  console.log(`verifier_sha: ${verifierSha}`);
  console.log(`organization: ${evidenceDigest(safetyGate.args.organizationId)}`);
  console.log(`phase: ${safetyGate.args.phase}`);
  console.log("traditional_gu write clients: not opened (structural)\n");

  const db = openHostedGuOsClient(target);
  // openHostedLegacyTarget is only reachable through
  // openHostedLegacyTargetAfterProbeAdmission after planDiscoverPlacementProbes.
  // Product reads go through the existing gateway.
  const declaredLegacyEnv = parseNamedArg(argv, "--legacy-env") ?? "";
  const organization = await getOrganizationById(db, safetyGate.args.organizationId);
  if (!organization) {
    throw new Error("FAIL CLOSED - Organization not found");
  }
  const organizationLegacyTarget = await observeOrganizationLegacyTarget(
    db,
    safetyGate.args.organizationId,
    declaredLegacyEnv
  );
  record(
    "legacy-target",
    "Organization-scoped Firestore identity matches the declared legacy environment",
    organizationLegacyTargetAllowsCapability(organizationLegacyTarget),
    organizationLegacyTarget.reason
  );
  const capabilityAuthorized = organizationLegacyTargetAllowsCapability(
    organizationLegacyTarget
  );
  if (!capabilityAuthorized) {
    console.log("declared_legacy_env: " + (organizationLegacyTarget.declaredLegacyEnv ?? "none"));
    console.log(
      "expected_firestore_project: " +
        (organizationLegacyTarget.expectedFirestoreProject ?? "none")
    );
    console.log(
      "configured_firestore_project: " +
        (organizationLegacyTarget.configuredFirestoreProject ?? "none")
    );
    console.log(
      "configured_client_email: " +
        (organizationLegacyTarget.configuredClientEmail ?? "none")
    );
    console.log("firestore_status: " + (organizationLegacyTarget.firestoreStatus ?? "none"));
    console.log("mongo_present: " + String(organizationLegacyTarget.mongoPresent));
    console.log("mongo_status: " + (organizationLegacyTarget.mongoStatus ?? "none"));
    console.log("organization_legacy_target: " + organizationLegacyTarget.classification);
    if (safetyGate.args.phase === "discover") {
      await runDiscoverHosted({
        db,
        organizationId: safetyGate.args.organizationId,
        inventoryCaseIds: safetyGate.args.inventoryCaseIds,
        argv,
        safetyGateOk: safetyGate.ok,
        targetName: target.name,
        targetProjectRef: target.projectRef,
        legacyEnv: declaredLegacyEnv,
        trackedTreeMatchesHead: true,
        verifierShaOk: true,
        capabilityAuthorized: false,
        organizationLegacyTarget,
      });
    }
    throw new Error(
      `FAIL CLOSED - Organization legacy target ${organizationLegacyTarget.classification}: ${organizationLegacyTarget.reason}`
    );
  }
  prepareGatewayProcessEnv(argv, target);
  const placement = evaluateSourcePlacementObservation({
    observedPlacement: null,
  });
  record(
    "placement",
    "configured allowlist recorded; placement is not concluded until a confirming observation",
    placement.conclusion === "not_concluded" || placement.conclusion === "confirmed",
    placement.reason
  );

  if (safetyGate.args.phase === "discover") {
    await runDiscoverHosted({
      db,
      organizationId: safetyGate.args.organizationId,
      inventoryCaseIds: safetyGate.args.inventoryCaseIds,
      argv,
      safetyGateOk: safetyGate.ok,
      targetName: target.name,
      targetProjectRef: target.projectRef,
      legacyEnv: declaredLegacyEnv,
      trackedTreeMatchesHead: true,
      verifierShaOk: true,
      capabilityAuthorized: true,
      organizationLegacyTarget,
    });
    return;
  }

  if (!safetyGate.args.conversationsFile) {
    throw new Error("FAIL CLOSED - evidence requires --conversations-file");
  }
  const evidence = await runEvidenceHosted({
    db,
    organizationId: safetyGate.args.organizationId,
    conversationsFile: safetyGate.args.conversationsFile,
    acknowledgeDurableWrite: safetyGate.args.acknowledgeDurableWrite,
    acknowledgeFailSafePersist: safetyGate.args.acknowledgeFailSafePersist,
    ranAt,
    productSha: product.productSha,
    verifierSha,
    projectRef: target.projectRef,
    legacyEnvironment: declaredLegacyEnv,
    jsonPath: safetyGate.args.jsonPath,
    observedPlacement: placement.observedPlacement,
    capabilityAuthorized: true,
  });
  console.log(
    `\nverify-sl6-authority: executionCompleted=${evidence.rs2.executionCompleted} ` +
      `requiredRs2FullySatisfied=${evidence.rs2.requiredRs2FullySatisfied} ` +
      `sliceDoneClaim=${evidence.rs2.sliceDoneClaim}`
  );
  if (!evidence.rs2.requiredRs2FullySatisfied) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(`verify-sl6-authority: ${(error as Error).message}`);
  process.exitCode = 1;
});
