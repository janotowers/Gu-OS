/**
 * Hosted RS-2 procedure for SL-6 T7 (SA-6.8, SA-6.9, SA-6.10, SA-6.11).
 *
 * Two phases, and they are not interchangeable:
 *
 *   --phase discover  inventories operator-named candidates read-only.
 *                     inventory != selection. A candidate is not a final
 *                     evidence member. Discover cannot persist.
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
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  getOperationalCase,
  getOrganizationById,
  listAuthorityResolutionsForCases,
  listConversationBindingsForCase,
  type DbClient,
} from "@agents/db";
import type {
  AuthorityResolution,
  InteractionAuthorityResolution,
  OperationalCase,
} from "@agents/types";
import { resolveInteractionAuthority } from "../apps/web/src/lib/relationship-authority/resolve";
import { persistFailSafeAuthorityResolution } from "../apps/web/src/lib/relationship-authority/persist";
import { readLegacyConversationAuthority } from "../apps/web/src/lib/legacy-gateway";
import type { GatewayCallerContext } from "../apps/web/src/lib/legacy-gateway/authorization";
import {
  assertBinding,
  describeTarget,
  parseTargetArgs,
  resolveTarget,
  type TargetEnv,
} from "./lib/target-env";
import {
  resolveLegacyTarget,
  type LegacySourceTarget,
} from "./lib/legacy-target";
import {
  bindingIdentityDigest,
  buildDurableEvidence,
  evaluateEvidenceHygiene,
  evaluateEvidencePins,
  evaluateFailSafePersistAdmission,
  evaluateFrozenMemberPins,
  evaluateIndependentEquivalence,
  evaluatePortfolioAuthorityConflictReadback,
  evaluateProductShaProvenance,
  evaluateSl6HostedSafetyGate,
  evaluateSourcePlacementObservation,
  evaluateTrackedTreeMatchesHead,
  evaluateVerifierSha,
  evidenceDigest,
  frozenConversationSetDigest,
  inspectTrackedWorkingTree,
  parseFrozenConversationManifest,
  SL6_CANONICAL_BINDING_HELPER,
  SL6_EXPECTED_STAGING_PRODUCT_SHA,
  SL6_HOSTED_ENVIRONMENT,
  SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
  SL6_PRODUCT_SHA_PROVENANCE,
  SL6_STAGING_PROJECT_REF,
  type FrozenConversationMember,
  type ObservedConversationPins,
  type Sl6Check,
  type Sl6DurableEvidence,
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

async function runDiscoverHosted(params: {
  db: DbClient;
  organizationId: string;
  inventoryCaseIds: string[];
}): Promise<void> {
  // discover cannot persist — inventory != selection. A candidate is not a
  // final evidence member. T7-3 binding preparation stays
  // backfillAdmittedLegacyLeadIdentity and is not executed here.
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

  for (const caseId of params.inventoryCaseIds) {
    const opportunity = await getOperationalCase(params.db, caseId);
    const inOrg = opportunity?.organization_id === params.organizationId;
    const bindings = inOrg
      ? await listConversationBindingsForCase(params.db, {
          organizationId: params.organizationId,
          caseId,
        })
      : [];
    const gu = bindings.filter((row) => row.thread_kind === "gu" && row.status === "active");
    record(
      "discover",
      "inventoried an operator-named candidate (not a final evidence member)",
      Boolean(opportunity && inOrg),
      opportunity && inOrg
        ? `case=${evidenceDigest(caseId)} bindings=${gu.length} runtime=${opportunity.runtime_authority ?? "null"}`
        : "missing or foreign Case"
    );
  }
  console.log(
    "\ninventory != selection. This discover output is not a frozen conversation set."
  );
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
  // openHostedLegacyTarget exists for later placement probes. T7-1 does not
  // call it: the safety gate already required --legacy-env stage, and product
  // reads go through the existing gateway when evidence later executes.
  const legacyEnvironment = "stage";
  const placement = evaluateSourcePlacementObservation({
    observedPlacement: null,
  });
  record(
    "placement",
    "configured allowlist recorded; placement is not concluded",
    placement.conclusion === "not_concluded",
    placement.reason
  );

  if (safetyGate.args.phase === "discover") {
    await runDiscoverHosted({
      db,
      organizationId: safetyGate.args.organizationId,
      inventoryCaseIds: safetyGate.args.inventoryCaseIds,
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
    legacyEnvironment,
    jsonPath: safetyGate.args.jsonPath,
    observedPlacement: placement.observedPlacement,
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
