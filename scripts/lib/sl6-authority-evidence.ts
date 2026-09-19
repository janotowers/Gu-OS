/**
 * Pure hosted-evidence evaluation for R1 SL-6 T7 (RS-2).
 *
 * Split out of `verify-sl6-authority.ts` so pass/fail logic is I/O-free and
 * unit-tested. This module evaluates already-observed inputs and results.
 * It does not construct clients, read credentials, touch the network, persist
 * rows, select conversations, or mutate product state.
 *
 * Product authority is produced by `resolveInteractionAuthority`.
 * Oracle authority is produced by `observeLegacyTakeover`.
 * Equivalence is recorded by `recordAuthorityEquivalence`.
 * This file invents none of those algorithms.
 *
 * Discovery classification (admission, binding, T7-3, placement, genuine
 * fail-safe candidacy) is also I/O-free. Hosted reads stay in the runner.
 */

import { createHash } from "node:crypto";
import type {
  AuthorityResolution,
  InteractionConversationVerdict,
  OperationalCase,
} from "@agents/types";
import {
  observeLegacyTakeover,
  type OracleObservedInputs,
  type OracleVerdict,
} from "../../apps/web/src/lib/authority-equivalence/oracle";
import {
  recordAuthorityEquivalence,
  type EquivalenceRecord,
} from "../../apps/web/src/lib/authority-equivalence/compare";
import { buildCaseSnapshots } from "../../apps/web/src/lib/work-portfolio/snapshot";
import { evaluateMustSurface } from "../../apps/web/src/lib/work-portfolio/must-surface";
import {
  evaluateTrackedTreeMatchesHead,
  evaluateVerifierSha,
  inspectTrackedWorkingTree,
  type TrackedTreeInspection,
} from "./sl15-identity-evidence";

export const SL6_SLICE = "SL-6";
export const SL6_RELEASE_SCOPE = "RS-2";
export const SL6_HOSTED_ENVIRONMENT = "staging";
export const SL6_STAGING_PROJECT_REF = "wdtjqlbsxwiijasicint";
export const SL6_EXPECTED_STAGING_PRODUCT_SHA =
  "12ed79ec05f5228a243695a026889f28e18280af";
export const SL6_PRODUCT_SHA_DELIVERY_WORKFLOW = "35385218918";
export const SL6_PRODUCT_SHA_PROVENANCE =
  "SUPPORTED_BY_DELIVERY_WORKFLOW_NOT_MECHANICALLY_PINNED" as const;
export const SL6_CANONICAL_BINDING_HELPER =
  "backfillAdmittedLegacyLeadIdentity" as const;

/** Configured allowlist for conversation-authority reads. Not a T7-P1 verdict. */
export const CONFIGURED_AUTHORITY_SOURCE_ALLOWLIST = [
  "gu2.users",
  "gu2.gunumbers",
] as const;

/** Placement that T7 may later compare. Not treated as current authority. */
export const COMPARISON_AUTHORITY_PLACEMENT_PATHS = ["bot.users"] as const;

export const AUTO_SELECT_FLAGS = [
  "--auto",
  "--auto-select",
  "--pick",
  "--first",
  "--first-eligible",
  "--any",
  "--any-case",
  "--select-case",
] as const;

export type Sl6Phase = "discover" | "evidence";

export type Sl6AdmissionClassification =
  | "admitted"
  | "not_admitted"
  | "missing"
  | "invalid";

export type Sl6PlacementConclusion = "confirmed" | "not_concluded" | "mismatch";

export type Sl6LegacyReadFailureKind =
  | "missing_binding"
  | "capability_failed"
  | "not_found"
  | "no_usable_credential"
  | "gateway_disabled"
  | "unconfirmed_fields"
  | "ambiguous_binding"
  | "other";

export const DISCOVERY_INVENTORY_BANNER = "inventory != selection" as const;
export const DISCOVERY_NOT_RS2_BANNER = "not RS-2 evidence" as const;

export type Rs2ItemId =
  | "rs2_1_named_equivalence"
  | "rs2_2_takeover_variation"
  | "rs2_3_unknown_conflicting"
  | "rs2_4_containment";

export type Rs2ItemStatus = "SATISFIED" | "UNMET" | "CONDITIONED_UNAVAILABLE";

export interface Sl6Check {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface FrozenConversationMember {
  organizationId: string;
  caseId: string;
  opaqueLeadRef: string;
  expectedOrganizationDigest: string;
  expectedCaseDigest: string;
  expectedLeadDigest: string;
  expectedBindingDigest: string;
}

export interface FrozenConversationManifest {
  version: 1;
  organizationId: string;
  members: FrozenConversationMember[];
}

export interface ObservedConversationPins {
  organizationId: string;
  caseId: string;
  opaqueLeadRef: string;
  provider: string;
  threadKind: string;
  status: string;
}

export interface ProductAuthorityObservation {
  conversationAuthority: InteractionConversationVerdict;
  humanActive: boolean | null;
  observedOwnerRef: string | null;
  answeredFrom: string | null;
  failSafeReason: string | null;
}

export interface PersistAdmissionInput {
  phase: Sl6Phase;
  productVerdict: InteractionConversationVerdict;
  frozenMember: boolean;
  observedOwnerRef: string | null;
  acknowledgeDurableWrite: boolean;
  acknowledgeFailSafePersist: boolean;
}

export interface PortfolioReadbackInput {
  persistHelperReturnedId: string | null;
  caseRow: OperationalCase;
  readBackResolutions: readonly AuthorityResolution[];
  now: Date;
}

export interface ProductShaProvenanceInput {
  declaredProductSha: string | null | undefined;
  expectedPin?: string;
  observedLatestRelevantDeliverySha: string | null;
  deliveryWorkflowId: string | null;
}

export interface Sl6HostedSafetyGateInput {
  argv: string[];
  targetName: string;
  targetProjectRef: string;
}

export interface Sl6DurableEvidence {
  slice: typeof SL6_SLICE;
  releaseScope: typeof SL6_RELEASE_SCOPE;
  ranAt: string;
  productSha: string;
  productShaProvenance: typeof SL6_PRODUCT_SHA_PROVENANCE;
  productShaDeliveryWorkflow: string;
  verifierSha: string;
  guOsEnvironment: string;
  projectRef: string;
  legacyEnvironment: string;
  frozenConversationSetDigest: string | null;
  conversations: Array<{
    organizationDigest: string;
    caseDigest: string;
    leadDigest: string;
    bindingDigest: string;
    productVerdict: InteractionConversationVerdict;
    oracleVerdict: boolean | null;
    oracleReason: string;
    agreed: boolean;
    takeoverHumanActiveObserved: boolean;
    unknownOrConflictingObserved: boolean;
    persistenceAdmitted: boolean;
    persistenceExercised: boolean;
    portfolioMustSurfaceAuthorityConflict: boolean;
    sourcePath: string | null;
    adapter: string | null;
  }>;
  sourcePlacement: {
    configuredAllowlist: readonly string[];
    comparisonPaths: readonly string[];
    observedPlacement: string[] | null;
    conclusion: "not_concluded";
  };
  containment: {
    traditionalGuWrites: { value: 0; basis: "structural" };
    traditionalGuWriteClientsOpened: { value: 0; basis: "structural" };
    runtimeAuthorityMutated: boolean | null;
    enforcementInvoked: false;
    c2EndpointInvoked: false;
  };
  assertions: {
    passed: number;
    failed: number;
    total: number;
    results: Sl6Check[];
  };
  rs2: {
    executionCompleted: boolean;
    items: Array<{
      id: Rs2ItemId;
      status: Rs2ItemStatus;
      detail: string;
    }>;
    requiredRs2FullySatisfied: boolean;
    sliceDoneClaim: "not_claimed";
  };
}

const PROHIBITED_EVIDENCE_KEY =
  /secret|password|token|authorization|api[_-]?key|mongo.?uri|private[_-]?key|env[_-]?file|conversations-file|opaqueLeadRef|legacyLeadId|phone/i;

export function evidenceDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

export function bindingIdentityDigest(observed: ObservedConversationPins): string {
  return evidenceDigest(
    [
      observed.provider,
      observed.threadKind,
      observed.status,
      observed.organizationId,
      observed.caseId,
      observed.opaqueLeadRef,
    ].join("|")
  );
}

export function frozenConversationSetDigest(
  members: readonly FrozenConversationMember[]
): string {
  const material = [...members]
    .map((member) =>
      [
        member.expectedOrganizationDigest,
        member.expectedCaseDigest,
        member.expectedLeadDigest,
        member.expectedBindingDigest,
      ].join(":")
    )
    .sort()
    .join(";");
  return evidenceDigest(material);
}

export function parseNamedArg(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const value = (argv[i + 1] ?? "").trim();
    if (!value || value.startsWith("--")) return undefined;
    return value;
  }
  return undefined;
}

export function parseRepeatedNamedArg(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const value = (argv[i + 1] ?? "").trim();
    if (!value || value.startsWith("--")) continue;
    values.push(value);
  }
  return values;
}

export function hasAutoSelectFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => (AUTO_SELECT_FLAGS as readonly string[]).includes(arg));
}

export interface Sl6AuthorityArgs {
  ok: boolean;
  reason: string;
  phase: Sl6Phase | null;
  conversationsFile: string | null;
  inventoryCaseIds: string[];
  productSha: string | null;
  acknowledgeDurableWrite: boolean;
  acknowledgeFailSafePersist: boolean;
  jsonPath: string | null;
  organizationId: string | null;
}

export function parseSl6AuthorityArgs(argv: string[]): Sl6AuthorityArgs {
  const fail = (reason: string): Sl6AuthorityArgs => ({
    ok: false,
    reason,
    phase: null,
    conversationsFile: null,
    inventoryCaseIds: [],
    productSha: null,
    acknowledgeDurableWrite: false,
    acknowledgeFailSafePersist: false,
    jsonPath: null,
    organizationId: null,
  });

  if (hasAutoSelectFlag(argv)) {
    return fail("this procedure never auto-selects a Case or conversation");
  }

  const phaseRaw = parseNamedArg(argv, "--phase");
  if (phaseRaw !== "discover" && phaseRaw !== "evidence") {
    return fail("--phase discover|evidence is required");
  }

  const conversationsFile = parseNamedArg(argv, "--conversations-file") ?? null;
  const inventoryCaseIds = parseRepeatedNamedArg(argv, "--case-id");
  if (phaseRaw === "evidence") {
    if (!conversationsFile) {
      return fail(
        "evidence requires an explicit frozen --conversations-file; inventory is not selection"
      );
    }
    if (inventoryCaseIds.length > 0) {
      return fail(
        "evidence refuses --case-id inventory flags; frozen membership is only --conversations-file"
      );
    }
  }

  const jsonPath = parseNamedArg(argv, "--json") ?? null;
  if (phaseRaw === "discover" && jsonPath) {
    return fail(
      "discover does not write durable evidence JSON; inventory is not RS-2 evidence"
    );
  }

  return {
    ok: true,
    reason:
      phaseRaw === "discover"
        ? "discover inventories operator-named candidates only; it does not select the final set"
        : "evidence requires the explicit frozen conversation set",
    phase: phaseRaw,
    conversationsFile,
    inventoryCaseIds,
    productSha: parseNamedArg(argv, "--product-sha") ?? null,
    acknowledgeDurableWrite: argv.includes("--acknowledge-durable-write"),
    acknowledgeFailSafePersist: argv.includes("--acknowledge-fail-safe-persist"),
    jsonPath,
    organizationId: parseNamedArg(argv, "--organization") ?? null,
  };
}

export function evaluateSl6HostedSafetyGate(
  input: Sl6HostedSafetyGateInput
): { ok: boolean; reason: string; args: Sl6AuthorityArgs } {
  const args = parseSl6AuthorityArgs(input.argv);
  if (!args.ok) {
    return { ok: false, reason: args.reason, args };
  }
  const envFlag = parseNamedArg(input.argv, "--env");
  if (envFlag !== SL6_HOSTED_ENVIRONMENT) {
    return {
      ok: false,
      reason: `--env ${SL6_HOSTED_ENVIRONMENT} is required; other Gu OS environments are refused`,
      args,
    };
  }
  if (input.targetName !== SL6_HOSTED_ENVIRONMENT) {
    return {
      ok: false,
      reason: `target environment must be ${SL6_HOSTED_ENVIRONMENT}`,
      args,
    };
  }
  if (input.targetProjectRef !== SL6_STAGING_PROJECT_REF) {
    return {
      ok: false,
      reason: "target project ref is not the expected staging project",
      args,
    };
  }
  const legacyEnv = parseNamedArg(input.argv, "--legacy-env");
  if (!legacyEnv) {
    return {
      ok: false,
      reason:
        "--legacy-env is required; there is no default and no fallback to production",
      args,
    };
  }
  if (legacyEnv !== "stage") {
    return {
      ok: false,
      reason: "T7 hosted authority evidence permits --legacy-env stage only",
      args,
    };
  }
  if (!args.organizationId) {
    return {
      ok: false,
      reason: "--organization must be supplied explicitly; a Case is never selected",
      args,
    };
  }
  if (args.phase === "discover" && args.inventoryCaseIds.length === 0) {
    return {
      ok: false,
      reason:
        "discover inventories only operator-named --case-id candidates; it does not list or select Cases",
      args,
    };
  }
  return { ok: true, reason: "hosted safety preconditions satisfied", args };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseFrozenConversationManifest(
  raw: unknown
): { ok: true; manifest: FrozenConversationManifest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "manifest is not an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    return { ok: false, reason: "manifest version must be 1" };
  }
  if (!isNonEmptyString(record.organizationId)) {
    return { ok: false, reason: "manifest organizationId is required" };
  }
  if (!Array.isArray(record.members) || record.members.length === 0) {
    return { ok: false, reason: "manifest members must be a non-empty array" };
  }

  const members: FrozenConversationMember[] = [];
  const caseIds = new Set<string>();
  const leadRefs = new Set<string>();
  for (const [index, item] of record.members.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `member ${index} is not an object` };
    }
    const member = item as Record<string, unknown>;
    const organizationId = member.organizationId;
    const caseId = member.caseId;
    const opaqueLeadRef = member.opaqueLeadRef;
    const expectedOrganizationDigest = member.expectedOrganizationDigest;
    const expectedCaseDigest = member.expectedCaseDigest;
    const expectedLeadDigest = member.expectedLeadDigest;
    const expectedBindingDigest = member.expectedBindingDigest;
    if (
      !isNonEmptyString(organizationId) ||
      !isNonEmptyString(caseId) ||
      !isNonEmptyString(opaqueLeadRef) ||
      !isNonEmptyString(expectedOrganizationDigest) ||
      !isNonEmptyString(expectedCaseDigest) ||
      !isNonEmptyString(expectedLeadDigest) ||
      !isNonEmptyString(expectedBindingDigest)
    ) {
      return {
        ok: false,
        reason: `member ${index} is missing required identity or expected digest fields`,
      };
    }
    if (organizationId !== record.organizationId) {
      return {
        ok: false,
        reason: `member ${index} Organization does not match the frozen set`,
      };
    }
    if (caseIds.has(caseId) || leadRefs.has(opaqueLeadRef)) {
      return {
        ok: false,
        reason: "duplicate or ambiguous frozen membership",
      };
    }
    caseIds.add(caseId);
    leadRefs.add(opaqueLeadRef);
    members.push({
      organizationId,
      caseId,
      opaqueLeadRef,
      expectedOrganizationDigest,
      expectedCaseDigest,
      expectedLeadDigest,
      expectedBindingDigest,
    });
  }

  return {
    ok: true,
    manifest: {
      version: 1,
      organizationId: record.organizationId,
      members,
    },
  };
}

export function evaluateFrozenMemberPins(
  member: FrozenConversationMember,
  observed: ObservedConversationPins
): { ok: boolean; reason: string } {
  if (observed.organizationId !== member.organizationId) {
    return { ok: false, reason: "observed Organization is not the frozen member" };
  }
  if (observed.caseId !== member.caseId) {
    return { ok: false, reason: "observed Case is not the frozen member" };
  }
  if (observed.opaqueLeadRef !== member.opaqueLeadRef) {
    return { ok: false, reason: "observed lead ref is not the frozen member" };
  }
  const organizationDigest = evidenceDigest(observed.organizationId);
  const caseDigest = evidenceDigest(observed.caseId);
  const leadDigest = evidenceDigest(observed.opaqueLeadRef);
  const bindingDigest = bindingIdentityDigest(observed);
  if (organizationDigest !== member.expectedOrganizationDigest) {
    return { ok: false, reason: "expected Organization digest/pin changed" };
  }
  if (caseDigest !== member.expectedCaseDigest) {
    return { ok: false, reason: "expected Case digest/pin changed" };
  }
  if (leadDigest !== member.expectedLeadDigest) {
    return { ok: false, reason: "expected lead digest/pin changed" };
  }
  if (bindingDigest !== member.expectedBindingDigest) {
    return { ok: false, reason: "expected binding digest/pin changed" };
  }
  return { ok: true, reason: "frozen member pins match" };
}

/**
 * Oracle and product are computed independently. Oracle inputs are the
 * bounded capability observations only — never the product verdict.
 */
export function evaluateIndependentEquivalence(input: {
  id: string;
  product: ProductAuthorityObservation;
  oracleInputs: OracleObservedInputs;
}): {
  oracle: OracleVerdict;
  equivalence: EquivalenceRecord;
} {
  const oracle = observeLegacyTakeover(input.oracleInputs);
  const equivalence = recordAuthorityEquivalence({
    id: input.id,
    resolverHumanActive: input.product.humanActive,
    oracle,
    inputs: input.oracleInputs,
    provenance: {
      productVerdict: input.product.conversationAuthority,
      answeredFrom: input.product.answeredFrom,
    },
  });
  return { oracle, equivalence };
}

export function evaluateFailSafePersistAdmission(
  input: PersistAdmissionInput
): { admitted: boolean; reason: string } {
  if (input.phase !== "evidence") {
    return { admitted: false, reason: "discover cannot persist authority_resolution" };
  }
  if (
    input.productVerdict !== "unknown" &&
    input.productVerdict !== "conflicting"
  ) {
    return {
      admitted: false,
      reason:
        "fail-safe persist is refused for confident or non-fail-safe verdicts (agreement, takeover/human_active, or oracle disagreement by itself)",
    };
  }
  if (!input.frozenMember) {
    return { admitted: false, reason: "conversation is not a frozen evidence member" };
  }
  if (!input.observedOwnerRef?.trim()) {
    return { admitted: false, reason: "required observed owner/reference basis is missing" };
  }
  if (!input.acknowledgeDurableWrite) {
    return { admitted: false, reason: "explicit durable-write acknowledgement is missing" };
  }
  if (!input.acknowledgeFailSafePersist) {
    return {
      admitted: false,
      reason: "explicit fail-safe-persist acknowledgement is missing",
    };
  }
  return { admitted: true, reason: "fail-safe persist admitted" };
}

export function evaluatePortfolioAuthorityConflictReadback(
  input: PortfolioReadbackInput
): {
  ok: boolean;
  reason: string;
  usedPersistReturnValueAlone: false;
  snapshotConflictState: "unknown" | "conflicting" | null;
  mustSurfaceAuthorityConflict: boolean;
} {
  const snapshots = buildCaseSnapshots({
    organizationId: input.caseRow.organization_id ?? "",
    cases: [input.caseRow],
    facts: [],
    subjects: [],
    events: [],
    approvals: [],
    work: [],
    authorityResolutions: input.readBackResolutions,
  });
  const snapshot = snapshots[0];
  const items = snapshot ? evaluateMustSurface(snapshot, input.now) : [];
  const mustSurfaceAuthorityConflict = items.some(
    (item) => item.predicate === "authority_conflict"
  );
  const snapshotConflictState = snapshot?.authority_conflict?.state ?? null;
  const readBackUnresolved = input.readBackResolutions.some(
    (row) =>
      row.resolved_at == null &&
      (row.state === "unknown" || row.state === "conflicting")
  );

  if (!readBackUnresolved || !snapshotConflictState || !mustSurfaceAuthorityConflict) {
    return {
      ok: false,
      reason: input.persistHelperReturnedId
        ? "persist helper return is not Portfolio proof; read-back did not surface authority_conflict"
        : "Portfolio read-back does not show an unresolved authority_conflict must-surface item",
      usedPersistReturnValueAlone: false,
      snapshotConflictState,
      mustSurfaceAuthorityConflict,
    };
  }

  return {
    ok: true,
    reason: "persisted-state read-back surfaces authority_conflict",
    usedPersistReturnValueAlone: false,
    snapshotConflictState,
    mustSurfaceAuthorityConflict,
  };
}

export function evaluateSourcePlacementObservation(input: {
  configuredAllowlist?: readonly string[];
  comparisonPaths?: readonly string[];
  observedPlacement: string[] | null;
  capabilitySucceeded?: boolean;
  fieldContributions?: readonly { field: string; sourcePath: string }[];
}): {
  configuredAllowlist: readonly string[];
  comparisonPaths: readonly string[];
  observedPlacement: string[] | null;
  conclusion: Sl6PlacementConclusion;
  reason: string;
} {
  const configuredAllowlist =
    input.configuredAllowlist ?? CONFIGURED_AUTHORITY_SOURCE_ALLOWLIST;
  const comparisonPaths = input.comparisonPaths ?? COMPARISON_AUTHORITY_PLACEMENT_PATHS;
  const contributions = input.fieldContributions ?? [];
  const observedPlacement =
    input.observedPlacement ??
    (contributions.length > 0
      ? [...new Set(contributions.map((item) => item.sourcePath))]
      : null);

  if (!input.capabilitySucceeded) {
    return {
      configuredAllowlist,
      comparisonPaths,
      observedPlacement,
      conclusion: "not_concluded",
      reason:
        "configured allowlist and observed placement are recorded separately; gu2.users is not concluded as correct before a confirming capability read",
    };
  }

  const takeover = contributions.find((item) => item.field === "leadTakeoverActive");
  if (!takeover?.sourcePath) {
    return {
      configuredAllowlist,
      comparisonPaths,
      observedPlacement,
      conclusion: "not_concluded",
      reason: "capability succeeded but the takeover-field contribution is missing",
    };
  }

  const onAllowlist = (configuredAllowlist as readonly string[]).includes(
    takeover.sourcePath
  );
  const onComparison = (comparisonPaths as readonly string[]).includes(
    takeover.sourcePath
  );
  if (!onAllowlist) {
    return {
      configuredAllowlist,
      comparisonPaths,
      observedPlacement,
      conclusion: "mismatch",
      reason: onComparison
        ? "takeover field was observed on a comparison path, not the configured allowlist"
        : "takeover field source is not on the configured allowlist",
    };
  }

  return {
    configuredAllowlist,
    comparisonPaths,
    observedPlacement,
    conclusion: "confirmed",
    reason: "capability provenance confirms the configured takeover source",
  };
}

export function opaqueContextId(
  context: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  if (!context) return null;
  const raw = context[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export interface GovernedAdmissionObservation {
  caseFound: boolean;
  caseInOrganization: boolean;
  caseId: string | null;
  caseType: string | null;
  contextLegacyLeadId: string | null;
  contextSourceEventId: string | null;
  sourceEventFound: boolean;
  sourceSystem: string | null;
  sourceEventStatus: string | null;
  disposition: string | null;
  admittedCaseId: string | null;
  externalLeadRef: string | null;
}

export function evaluateGovernedAdmissionObservation(
  observation: GovernedAdmissionObservation
): {
  classification: Sl6AdmissionClassification;
  admittedEligible: boolean;
  admissionLeadRef: string | null;
  reason: string;
} {
  if (!observation.caseFound) {
    return {
      classification: "missing",
      admittedEligible: false,
      admissionLeadRef: null,
      reason: "named Case was not found",
    };
  }
  if (!observation.caseInOrganization) {
    return {
      classification: "invalid",
      admittedEligible: false,
      admissionLeadRef: null,
      reason: "named Case is missing or not in the declared Organization",
    };
  }
  if (observation.caseType !== "lead_opportunity") {
    return {
      classification: "not_admitted",
      admittedEligible: false,
      admissionLeadRef: null,
      reason: "Case is not a lead_opportunity",
    };
  }
  if (!observation.contextLegacyLeadId || !observation.contextSourceEventId) {
    return {
      classification: "not_admitted",
      admittedEligible: false,
      admissionLeadRef: null,
      reason: "Case is not proven governed admission",
    };
  }
  if (
    !observation.sourceEventFound ||
    observation.sourceSystem !== "traditional_gu" ||
    observation.sourceEventStatus !== "completed" ||
    observation.disposition !== "admitted" ||
    observation.admittedCaseId !== observation.caseId ||
    observation.externalLeadRef !== observation.contextLegacyLeadId
  ) {
    return {
      classification: "not_admitted",
      admittedEligible: false,
      admissionLeadRef: null,
      reason: "source event is not governed admitted evidence for this Case",
    };
  }
  return {
    classification: "admitted",
    admittedEligible: true,
    admissionLeadRef: observation.contextLegacyLeadId,
    reason: "Case is a governed-admitted lead_opportunity",
  };
}

export interface ObservedBindingRow {
  provider: string;
  threadKind: string;
  status: string;
  organizationId: string;
  caseId: string;
  opaqueLeadRef: string;
}

export function evaluateBindingDiscovery(input: {
  admittedEligible: boolean;
  bindings: readonly ObservedBindingRow[];
}): {
  bound: boolean;
  bindingPresent: boolean;
  ambiguous: boolean;
  opaqueLeadRef: string | null;
  bindingDigest: string | null;
  t7_3Candidate: boolean;
  reason: string;
} {
  const expected = input.bindings.filter(
    (row) =>
      row.provider === "whatsapp_business" &&
      row.threadKind === "gu" &&
      row.status === "active"
  );
  if (expected.length === 0) {
    return {
      bound: false,
      bindingPresent: false,
      ambiguous: false,
      opaqueLeadRef: null,
      bindingDigest: null,
      t7_3Candidate: input.admittedEligible,
      reason: input.admittedEligible
        ? "admitted Case lacks the required active gu binding; T7-3 candidate"
        : "no active gu binding",
    };
  }
  if (expected.length > 1) {
    return {
      bound: false,
      bindingPresent: true,
      ambiguous: true,
      opaqueLeadRef: null,
      bindingDigest: null,
      t7_3Candidate: false,
      reason: "multiple active gu bindings; mapping is ambiguous and is not T7-3",
    };
  }
  const [row] = expected;
  return {
    bound: true,
    bindingPresent: true,
    ambiguous: false,
    opaqueLeadRef: row.opaqueLeadRef,
    bindingDigest: bindingIdentityDigest(row),
    t7_3Candidate: false,
    reason: "exactly one active whatsapp_business/gu binding",
  };
}

export function evaluateGenuineFailSafeCandidate(input: {
  bindingPresent: boolean;
  bound: boolean;
  legacyReadSucceeded: boolean;
  productVerdict: InteractionConversationVerdict | null;
}): { genuineUnknownOrConflictingCandidate: boolean; reason: string } {
  if (!input.bound || !input.bindingPresent) {
    return {
      genuineUnknownOrConflictingCandidate: false,
      reason:
        "unbound or missing binding is a T7-3/discovery prerequisite, not RS-2 #3 authority-state evidence",
    };
  }
  if (!input.legacyReadSucceeded) {
    return {
      genuineUnknownOrConflictingCandidate: false,
      reason:
        "a failed or incomplete bounded read is a discovery issue, not genuine unknown/conflicting evidence",
    };
  }
  if (
    input.productVerdict !== "unknown" &&
    input.productVerdict !== "conflicting"
  ) {
    return {
      genuineUnknownOrConflictingCandidate: false,
      reason: "product resolver did not return unknown or conflicting",
    };
  }
  return {
    genuineUnknownOrConflictingCandidate: true,
    reason: "bound conversation with a successful bounded read and a fail-safe product verdict",
  };
}

export const PLACEMENT_PROBE_ELIGIBLE_UNCERTAINTY = [
  "not_found",
  "unconfirmed_fields",
] as const satisfies readonly Sl6LegacyReadFailureKind[];

export function isPlacementProbeEligibleUncertainty(
  kind: Sl6LegacyReadFailureKind | null
): kind is (typeof PLACEMENT_PROBE_ELIGIBLE_UNCERTAINTY)[number] {
  return kind === "not_found" || kind === "unconfirmed_fields";
}

export function evaluatePlacementProbeAdmission(input: {
  phase: Sl6Phase;
  safetyGateOk: boolean;
  targetName: string;
  targetProjectRef: string;
  legacyEnv: string | null;
  organizationId: string | null;
  namedCaseCount: number;
  trackedTreeMatchesHead: boolean;
  verifierShaOk: boolean;
  capabilityAttempted: boolean;
  placementConclusion: Sl6PlacementConclusion;
  capabilityFailureKind: Sl6LegacyReadFailureKind | null;
  readOnly: boolean;
}): { admitted: boolean; reason: string } {
  if (input.phase !== "discover") {
    return { admitted: false, reason: "placement probe is discover-only" };
  }
  if (!input.safetyGateOk) {
    return { admitted: false, reason: "hosted safety gate has not succeeded" };
  }
  if (input.targetName !== SL6_HOSTED_ENVIRONMENT) {
    return { admitted: false, reason: "placement probe requires Gu OS staging" };
  }
  if (input.targetProjectRef !== SL6_STAGING_PROJECT_REF) {
    return { admitted: false, reason: "placement probe requires the expected staging project" };
  }
  if (!input.legacyEnv) {
    return {
      admitted: false,
      reason: "--legacy-env is required; there is no default and no fallback to production",
    };
  }
  if (input.legacyEnv !== "stage") {
    return { admitted: false, reason: "placement probe permits --legacy-env stage only" };
  }
  if (!input.organizationId) {
    return { admitted: false, reason: "explicit --organization is required" };
  }
  if (input.namedCaseCount < 1) {
    return { admitted: false, reason: "placement probe requires operator-named --case-id candidates" };
  }
  if (!input.trackedTreeMatchesHead) {
    return { admitted: false, reason: "tracked verifier tree must match HEAD" };
  }
  if (!input.verifierShaOk) {
    return { admitted: false, reason: "full verifier SHA must be validated" };
  }
  if (!input.capabilityAttempted) {
    return {
      admitted: false,
      reason: "capability path must be attempted before a placement probe",
    };
  }
  if (input.placementConclusion === "confirmed") {
    return { admitted: false, reason: "placement is already confirmed; probe is not needed" };
  }
  if (input.placementConclusion === "mismatch") {
    return {
      admitted: false,
      reason:
        "Path A already concluded a placement mismatch; the probe is not a recheck",
    };
  }
  if (input.placementConclusion !== "not_concluded") {
    return {
      admitted: false,
      reason: "unrecognized placement conclusion is not placement-probe eligible",
    };
  }
  if (!isPlacementProbeEligibleUncertainty(input.capabilityFailureKind)) {
    return {
      admitted: false,
      reason:
        "capability outcome is not a recognized placement-uncertainty; probe remains closed",
    };
  }
  if (!input.readOnly) {
    return { admitted: false, reason: "placement probe is read-only" };
  }
  return {
    admitted: true,
    reason:
      input.capabilityFailureKind === "not_found"
        ? "named lead was not found on the configured capability path; bounded placement probe may open"
        : "capability succeeded without a confirming takeover-field contribution; bounded placement probe may open",
  };
}

export interface Sl6PlacementProbeCandidateFacts {
  candidateKey: string;
  capabilityAttempted: boolean;
  capabilityFailureKind: Sl6LegacyReadFailureKind | null;
  placementConclusion: Sl6PlacementConclusion;
  probeLeadRef: string | null;
}

export interface Sl6PlacementProbePlan {
  openTarget: boolean;
  openReason: string;
  admittedKeys: string[];
  refused: readonly { candidateKey: string; reason: string }[];
}

export function planDiscoverPlacementProbes(input: {
  candidates: readonly Sl6PlacementProbeCandidateFacts[];
  phase: Sl6Phase;
  safetyGateOk: boolean;
  targetName: string;
  targetProjectRef: string;
  legacyEnv: string | null;
  organizationId: string | null;
  namedCaseCount: number;
  trackedTreeMatchesHead: boolean;
  verifierShaOk: boolean;
  readOnly: boolean;
}): Sl6PlacementProbePlan {
  const admittedKeys: string[] = [];
  const refused: { candidateKey: string; reason: string }[] = [];
  for (const candidate of input.candidates) {
    const admission = evaluatePlacementProbeAdmission({
      phase: input.phase,
      safetyGateOk: input.safetyGateOk,
      targetName: input.targetName,
      targetProjectRef: input.targetProjectRef,
      legacyEnv: input.legacyEnv,
      organizationId: input.organizationId,
      namedCaseCount: input.namedCaseCount,
      trackedTreeMatchesHead: input.trackedTreeMatchesHead,
      verifierShaOk: input.verifierShaOk,
      capabilityAttempted: candidate.capabilityAttempted,
      placementConclusion: candidate.placementConclusion,
      capabilityFailureKind: candidate.capabilityFailureKind,
      readOnly: input.readOnly,
    });
    if (!admission.admitted) {
      refused.push({ candidateKey: candidate.candidateKey, reason: admission.reason });
      continue;
    }
    if (!candidate.probeLeadRef) {
      refused.push({
        candidateKey: candidate.candidateKey,
        reason: "placement probe requires a bound lead reference",
      });
      continue;
    }
    admittedKeys.push(candidate.candidateKey);
  }
  return {
    openTarget: admittedKeys.length > 0,
    openReason:
      admittedKeys.length > 0
        ? "at least one candidate independently admitted for a recognized placement-uncertainty"
        : (refused[0]?.reason ??
          "no candidate is independently eligible for a placement probe"),
    admittedKeys,
    refused,
  };
}

export interface Sl6DiscoveryCandidateReport {
  caseDigest: string;
  leadDigest: string | null;
  bindingDigest: string | null;
  admittedEligible: boolean;
  admissionClassification: Sl6AdmissionClassification;
  bindingPresent: boolean;
  t73Candidate: boolean;
  legacyReadSucceeded: boolean;
  legacyReadFailureKind: Sl6LegacyReadFailureKind | null;
  placementConclusion: Sl6PlacementConclusion;
  placementReason: string;
  takeoverHumanActiveObserved: boolean | null;
  killSwitchObserved: boolean | null;
  productOutcome: InteractionConversationVerdict | null;
  oracleOutcome: boolean | null;
  oracleReason: string | null;
  agreed: boolean | null;
  genuineUnknownOrConflictingCandidate: boolean;
  incidentalCredentialUsageBookkeepingPossible: boolean;
}

export interface Sl6DiscoveryReport {
  inventoryEqualsSelection: false;
  notRs2Evidence: true;
  banners: readonly [
    typeof DISCOVERY_INVENTORY_BANNER,
    typeof DISCOVERY_NOT_RS2_BANNER,
  ];
  rs2ItemsSatisfied: [];
  sliceDoneClaim: "not_claimed";
  t7CompleteClaim: false;
  incidentalCredentialUsageBookkeeping: "possible_on_capability_read";
  candidates: Sl6DiscoveryCandidateReport[];
}

export interface BoundedPlacementPathObservation {
  path: "gu2.users" | "bot.users";
  collectionExists: boolean;
  namedLeadExists: boolean;
  takeoverFieldPresent: boolean;
  lastOwnerFieldPresent: boolean;
  boundedCount: number;
}

export function evaluateBoundedPlacementProbeObservation(input: {
  paths: readonly BoundedPlacementPathObservation[];
  configuredAllowlist?: readonly string[];
  comparisonPaths?: readonly string[];
}): {
  configuredAllowlist: readonly string[];
  comparisonPaths: readonly string[];
  observedPlacement: string[] | null;
  conclusion: Sl6PlacementConclusion;
  reason: string;
} {
  const configuredAllowlist =
    input.configuredAllowlist ?? CONFIGURED_AUTHORITY_SOURCE_ALLOWLIST;
  const comparisonPaths = input.comparisonPaths ?? COMPARISON_AUTHORITY_PLACEMENT_PATHS;
  const confirming = input.paths.filter(
    (path) => path.namedLeadExists && path.takeoverFieldPresent
  );
  const observedPlacement =
    confirming.length > 0 ? confirming.map((path) => path.path) : null;
  const configuredHit = confirming.find((path) =>
    (configuredAllowlist as readonly string[]).includes(path.path)
  );
  const comparisonHit = confirming.find((path) =>
    (comparisonPaths as readonly string[]).includes(path.path)
  );
  if (configuredHit) {
    return {
      configuredAllowlist,
      comparisonPaths,
      observedPlacement,
      conclusion: "confirmed",
      reason: "bounded probe observed takeover-field presence on the configured source",
    };
  }
  if (comparisonHit) {
    return {
      configuredAllowlist,
      comparisonPaths,
      observedPlacement,
      conclusion: "mismatch",
      reason: "bounded probe observed takeover-field presence only on a comparison path",
    };
  }
  return {
    configuredAllowlist,
    comparisonPaths,
    observedPlacement,
    conclusion: "not_concluded",
    reason: "bounded probe did not observe a confirming takeover-field placement",
  };
}

export function buildDiscoveryReport(
  candidates: Sl6DiscoveryCandidateReport[]
): Sl6DiscoveryReport {
  return {
    inventoryEqualsSelection: false,
    notRs2Evidence: true,
    banners: [DISCOVERY_INVENTORY_BANNER, DISCOVERY_NOT_RS2_BANNER],
    rs2ItemsSatisfied: [],
    sliceDoneClaim: "not_claimed",
    t7CompleteClaim: false,
    incidentalCredentialUsageBookkeeping: "possible_on_capability_read",
    candidates,
  };
}

export function evaluateDiscoveryHygiene(report: Sl6DiscoveryReport): {
  ok: boolean;
  reason: string;
} {
  if (
    !report.banners.includes(DISCOVERY_INVENTORY_BANNER) ||
    !report.banners.includes(DISCOVERY_NOT_RS2_BANNER) ||
    report.inventoryEqualsSelection !== false ||
    report.notRs2Evidence !== true ||
    report.rs2ItemsSatisfied.length !== 0 ||
    report.sliceDoneClaim !== "not_claimed" ||
    report.t7CompleteClaim !== false
  ) {
    return {
      ok: false,
      reason: "discovery report is missing required non-canonical banners or claims RS-2/T7 completion",
    };
  }
  return evaluateEvidenceHygiene(report);
}

export function normalizeExpectedProductSha(
  value: string | null | undefined,
  expected = SL6_EXPECTED_STAGING_PRODUCT_SHA
): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  const pin = expected.toLowerCase();
  if (!trimmed) return null;
  if (trimmed === pin) return expected;
  if (trimmed.length >= 7 && pin.startsWith(trimmed)) return expected;
  return null;
}

export function evaluateProductShaProvenance(input: ProductShaProvenanceInput): {
  ok: boolean;
  productSha: string | null;
  provenanceClassification: typeof SL6_PRODUCT_SHA_PROVENANCE | null;
  deliveryObservation: "not_observed" | "matches_expected_pin" | "newer_than_expected_pin";
  hostedEvidenceReady: boolean;
  reason: string;
} {
  const expected = input.expectedPin ?? SL6_EXPECTED_STAGING_PRODUCT_SHA;
  const productSha = normalizeExpectedProductSha(input.declaredProductSha, expected);
  if (!productSha) {
    return {
      ok: false,
      productSha: null,
      provenanceClassification: null,
      deliveryObservation: "not_observed",
      hostedEvidenceReady: false,
      reason: "product SHA is not the expected staging product pin",
    };
  }
  const latest = (input.observedLatestRelevantDeliverySha ?? "").trim().toLowerCase();
  if (latest && latest !== expected.toLowerCase()) {
    return {
      ok: false,
      productSha,
      provenanceClassification: null,
      deliveryObservation: "newer_than_expected_pin",
      hostedEvidenceReady: false,
      reason:
        "a newer relevant staging delivery exists; update the expected product pin/provenance before hosted evidence",
    };
  }
  const workflowOk = input.deliveryWorkflowId === SL6_PRODUCT_SHA_DELIVERY_WORKFLOW;
  const deliveryObservation = latest ? "matches_expected_pin" : "not_observed";
  return {
    ok: true,
    productSha,
    provenanceClassification: workflowOk ? SL6_PRODUCT_SHA_PROVENANCE : null,
    deliveryObservation,
    hostedEvidenceReady: deliveryObservation === "matches_expected_pin" && workflowOk,
    reason: workflowOk
      ? "product SHA is delivery-corroborated, not mechanically attested by staging"
      : "product pin matches but delivery workflow provenance is missing",
  };
}

export function evaluateEvidencePins(pins: {
  productSha: string | null;
  verifierSha: string | null;
  environment: string | null;
  projectRef: string | null;
  ranAt: string | null;
  productShaProvenance: string | null;
}): { ok: boolean; reason: string } {
  if (pins.environment !== SL6_HOSTED_ENVIRONMENT) {
    return { ok: false, reason: "environment is not staging" };
  }
  if (pins.projectRef !== SL6_STAGING_PROJECT_REF) {
    return { ok: false, reason: "project ref is not the expected staging project" };
  }
  if (normalizeExpectedProductSha(pins.productSha) !== SL6_EXPECTED_STAGING_PRODUCT_SHA) {
    return { ok: false, reason: "product SHA is not the expected staging product pin" };
  }
  if (pins.productShaProvenance !== SL6_PRODUCT_SHA_PROVENANCE) {
    return { ok: false, reason: "product SHA provenance classification is missing" };
  }
  if (!evaluateVerifierSha(pins.verifierSha).ok) {
    return { ok: false, reason: "verifier SHA is missing or not a full git SHA" };
  }
  if (!pins.ranAt || Number.isNaN(Date.parse(pins.ranAt))) {
    return { ok: false, reason: "execution timestamp is missing" };
  }
  return { ok: true, reason: "pins present" };
}

export function evaluateRs2Items(input: {
  namedEquivalenceRecords: number;
  unexplainedMissingEquivalence: boolean;
  takeoverHumanActiveObserved: boolean;
  unknownOrConflictingPersistedAndSurfaced: boolean;
  containmentHolds: boolean;
}): Array<{ id: Rs2ItemId; status: Rs2ItemStatus; detail: string }> {
  const item1: Rs2ItemStatus =
    input.namedEquivalenceRecords > 0 && !input.unexplainedMissingEquivalence
      ? "SATISFIED"
      : "UNMET";
  const item2: Rs2ItemStatus = input.takeoverHumanActiveObserved
    ? "SATISFIED"
    : "CONDITIONED_UNAVAILABLE";
  const item3: Rs2ItemStatus = input.unknownOrConflictingPersistedAndSurfaced
    ? "SATISFIED"
    : "UNMET";
  const item4: Rs2ItemStatus = input.containmentHolds ? "SATISFIED" : "UNMET";

  return [
    {
      id: "rs2_1_named_equivalence",
      status: item1,
      detail:
        item1 === "SATISFIED"
          ? "named-conversation equivalence records exist (agreement or recorded divergence)"
          : "named-conversation equivalence run is missing",
    },
    {
      id: "rs2_2_takeover_variation",
      status: item2,
      detail: input.takeoverHumanActiveObserved
        ? "real same-thread takeover / human_active variation was observed"
        : "no takeover/human_active variation observed; all-agreement must not be overstated",
    },
    {
      id: "rs2_3_unknown_conflicting",
      status: item3,
      detail: input.unknownOrConflictingPersistedAndSurfaced
        ? "a real unknown/conflicting result persisted and surfaced through authority_conflict"
        : "no real unknown/conflicting persist+Portfolio instance; a normal takeover does not satisfy this item",
    },
    {
      id: "rs2_4_containment",
      status: item4,
      detail: input.containmentHolds
        ? "hosted containment holds (no Traditional Gu write; runtime_authority unchanged; no enforcement)"
        : "containment is unmet",
    },
  ];
}

export function evaluateRequiredRs2Satisfaction(input: {
  executionCompleted: boolean;
  items: Array<{ id: Rs2ItemId; status: Rs2ItemStatus }>;
}): {
  executionCompleted: boolean;
  requiredRs2FullySatisfied: boolean;
  sliceDoneClaim: "not_claimed";
  reason: string;
} {
  const byId = new Map(input.items.map((item) => [item.id, item.status]));
  const item3 = byId.get("rs2_3_unknown_conflicting");
  if (item3 !== "SATISFIED") {
    return {
      executionCompleted: input.executionCompleted,
      requiredRs2FullySatisfied: false,
      sliceDoneClaim: "not_claimed",
      reason:
        "RS-2 item #3 is UNMET; overall required hosted evidence is not discharged and SL-6 is not Done",
    };
  }
  const item1 = byId.get("rs2_1_named_equivalence");
  const item4 = byId.get("rs2_4_containment");
  if (item1 !== "SATISFIED" || item4 !== "SATISFIED") {
    return {
      executionCompleted: input.executionCompleted,
      requiredRs2FullySatisfied: false,
      sliceDoneClaim: "not_claimed",
      reason: "required RS-2 item #1 or #4 is UNMET; overall result is not PASS",
    };
  }
  if (!input.executionCompleted) {
    return {
      executionCompleted: false,
      requiredRs2FullySatisfied: false,
      sliceDoneClaim: "not_claimed",
      reason: "execution did not complete; run-completed is not implied by assertion results",
    };
  }
  return {
    executionCompleted: true,
    requiredRs2FullySatisfied: true,
    sliceDoneClaim: "not_claimed",
    reason:
      "required RS-2 items #1, #3 and #4 are SATISFIED; #2 remains availability-conditioned; the harness never marks SL-6 Done",
  };
}

export function evaluateEvidenceHygiene(value: unknown): {
  ok: boolean;
  reason: string;
} {
  const stack: Array<{ key: string; value: unknown }> = [{ key: "", value }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (PROHIBITED_EVIDENCE_KEY.test(current.key)) {
      return { ok: false, reason: `durable evidence carries prohibited key ${current.key}` };
    }
    if (typeof current.value === "string") {
      if (
        /password|secret|BEGIN [A-Z ]+PRIVATE KEY|sb_secret_|mongodb(\+srv)?:\/\//i.test(
          current.value
        )
      ) {
        return { ok: false, reason: "durable evidence carries a prohibited secret-shaped value" };
      }
    }
    if (current.value && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) {
        stack.push({ key, value: child });
      }
    }
  }
  return { ok: true, reason: "durable evidence omits prohibited raw data" };
}

export function buildDurableEvidence(input: {
  ranAt: string;
  productSha: string;
  verifierSha: string;
  guOsEnvironment: string;
  projectRef: string;
  legacyEnvironment: string;
  frozenConversationSetDigest: string | null;
  conversations: Sl6DurableEvidence["conversations"];
  observedPlacement: string[] | null;
  runtimeAuthorityMutated: boolean | null;
  checks: Sl6Check[];
  executionCompleted: boolean;
  namedEquivalenceRecords: number;
  unexplainedMissingEquivalence: boolean;
  takeoverHumanActiveObserved: boolean;
  unknownOrConflictingPersistedAndSurfaced: boolean;
}): Sl6DurableEvidence {
  const items = evaluateRs2Items({
    namedEquivalenceRecords: input.namedEquivalenceRecords,
    unexplainedMissingEquivalence: input.unexplainedMissingEquivalence,
    takeoverHumanActiveObserved: input.takeoverHumanActiveObserved,
    unknownOrConflictingPersistedAndSurfaced:
      input.unknownOrConflictingPersistedAndSurfaced,
    containmentHolds:
      input.runtimeAuthorityMutated === false,
  });
  const overall = evaluateRequiredRs2Satisfaction({
    executionCompleted: input.executionCompleted,
    items,
  });
  const passed = input.checks.filter((check) => check.ok).length;
  return {
    slice: SL6_SLICE,
    releaseScope: SL6_RELEASE_SCOPE,
    ranAt: input.ranAt,
    productSha: input.productSha,
    productShaProvenance: SL6_PRODUCT_SHA_PROVENANCE,
    productShaDeliveryWorkflow: SL6_PRODUCT_SHA_DELIVERY_WORKFLOW,
    verifierSha: input.verifierSha,
    guOsEnvironment: input.guOsEnvironment,
    projectRef: input.projectRef,
    legacyEnvironment: input.legacyEnvironment,
    frozenConversationSetDigest: input.frozenConversationSetDigest,
    conversations: input.conversations,
    sourcePlacement: {
      configuredAllowlist: CONFIGURED_AUTHORITY_SOURCE_ALLOWLIST,
      comparisonPaths: COMPARISON_AUTHORITY_PLACEMENT_PATHS,
      observedPlacement: input.observedPlacement,
      conclusion: "not_concluded",
    },
    containment: {
      traditionalGuWrites: { value: 0, basis: "structural" },
      traditionalGuWriteClientsOpened: { value: 0, basis: "structural" },
      runtimeAuthorityMutated: input.runtimeAuthorityMutated,
      enforcementInvoked: false,
      c2EndpointInvoked: false,
    },
    assertions: {
      passed,
      failed: input.checks.length - passed,
      total: input.checks.length,
      results: input.checks,
    },
    rs2: {
      executionCompleted: overall.executionCompleted,
      items,
      requiredRs2FullySatisfied: overall.requiredRs2FullySatisfied,
      sliceDoneClaim: "not_claimed",
    },
  };
}

export function evaluateTrackedTreeGuard(
  runGit: (args: readonly string[]) => { status: number }
): { ok: boolean; reason: string; inspection: TrackedTreeInspection } {
  const inspection = inspectTrackedWorkingTree(runGit);
  const tree = evaluateTrackedTreeMatchesHead(inspection);
  return { ...tree, inspection };
}

export { evaluateVerifierSha, inspectTrackedWorkingTree, evaluateTrackedTreeMatchesHead };

/* SL6_SOURCE_CONTRACTS_BELOW */

export function productSourceForContract(source: string): string {
  const marker = "/* SL6_SOURCE_CONTRACTS_BELOW */";
  const index = source.indexOf(marker);
  return index >= 0 ? source.slice(0, index) : source;
}

const EVALUATOR_FORBIDDEN_IMPORTS = [
  "@supabase/supabase-js",
  "mongodb",
  "@google-cloud/firestore",
  "./target-env",
  "./legacy-target",
  "../relationship-authority/resolve",
  "../../apps/web/src/lib/relationship-authority/resolve",
  "../../apps/web/src/lib/relationship-authority/persist",
  "../../apps/web/src/lib/legacy-authority/handle",
];

export function evaluateSl6EvaluatorSourceContract(source: string): Sl6Check[] {
  source = productSourceForContract(source);
  const checks: Sl6Check[] = [];
  const add = (label: string, ok: boolean, detail?: string) => {
    checks.push({ assertion: "evaluator", label, ok, detail });
  };

  add(
    "does not construct hosted clients or read credentials",
    !source.includes("createClient(") &&
      !source.includes("MongoClient") &&
      !source.includes("createFirestoreReader") &&
      !source.includes("createMongoReader") &&
      !source.includes("resolveTarget(") &&
      !source.includes("resolveLegacyTarget(") &&
      !source.includes("readFileSync") &&
      !source.includes("process.env"),
    "I/O-free evaluator"
  );
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  add(
    "does not import a second resolver, persist path, or C2 handle",
    EVALUATOR_FORBIDDEN_IMPORTS.every((spec) => !imports.includes(spec)),
    "reuses oracle + recordAuthorityEquivalence only"
  );
  add(
    "uses observeLegacyTakeover and recordAuthorityEquivalence",
    source.includes("observeLegacyTakeover(") &&
      source.includes("recordAuthorityEquivalence(") &&
      !source.includes("verdictFromTakeover") &&
      !source.includes("function compareEquivalence"),
    "no copied verdict algorithm"
  );
  add(
    "does not call attachExternalConversationBinding",
    !/attachExternalConversationBinding\s*\(/.test(source),
    "T7 is not a binding caller"
  );
  add(
    "placement-probe planner evaluates each candidate independently against an allowlist",
    source.includes("function planDiscoverPlacementProbes(") &&
      source.includes("for (const candidate of input.candidates)") &&
      source.includes("evaluatePlacementProbeAdmission(") &&
      source.includes("function isPlacementProbeEligibleUncertainty(") &&
      source.includes('kind === "not_found"') &&
      source.includes('kind === "unconfirmed_fields"') &&
      !source.includes("PLACEMENT_PROBE_BLOCKING_FAILURES"),
    "deny-by-default Path B"
  );
  return checks;
}

export function evaluateSl6VerifierSourceContract(source: string): Sl6Check[] {
  const checks: Sl6Check[] = [];
  const add = (label: string, ok: boolean, detail?: string) => {
    checks.push({ assertion: "harness", label, ok, detail });
  };

  const safetyGateCall = source.indexOf("const safetyGate = evaluateSl6HostedSafetyGate({");
  const treeGuardCall = source.indexOf("const verifierSha = requireExecutedTrackedCodeMatchesHead(");
  const assertBindingCall = source.indexOf("assertBinding(target)");
  const openClientCall = source.indexOf("const db = openHostedGuOsClient(target)");
  const createClientFn = source.indexOf("function openHostedGuOsClient");
  const createClientCall = source.indexOf("createClient(");
  const persistCall = source.indexOf("persistFailSafeAuthorityResolution(");
  const persistGateCall = source.indexOf("evaluateFailSafePersistAdmission(");
  const discoverPersist = /async function runDiscoverHosted[\s\S]*?persistFailSafeAuthorityResolution\(/.test(
    source
  );

  add(
    "requires evaluateSl6HostedSafetyGate before openHostedGuOsClient",
    safetyGateCall >= 0 && openClientCall >= 0 && safetyGateCall < openClientCall,
    "safety gate precedes hosted client construction"
  );
  add(
    "proves executed tracked code matches HEAD before openHostedGuOsClient",
    treeGuardCall >= 0 && openClientCall >= 0 && treeGuardCall < openClientCall,
    "dirty tracked tree cannot record verifierSha"
  );
  add(
    "assertBinding precedes openHostedGuOsClient",
    assertBindingCall >= 0 && openClientCall >= 0 && assertBindingCall < openClientCall,
    "target binding precedes client construction"
  );
  add(
    "createClient lives only inside openHostedGuOsClient",
    createClientFn >= 0 &&
      createClientCall >= 0 &&
      createClientFn < createClientCall &&
      (source.match(/createClient\(/g) ?? []).length === 1,
    "single gated client constructor"
  );
  add(
    "resolveLegacyTarget is not invoked before the hosted safety gate",
    source.indexOf("resolveLegacyTarget(") === -1 ||
      (source.indexOf("function openHostedLegacyTarget") >= 0 &&
        source.indexOf("resolveLegacyTarget(") >
          source.indexOf("function openHostedLegacyTarget")),
    "legacy credential resolution is gated"
  );
  add(
    "discover cannot persist",
    !discoverPersist && source.includes("discover cannot persist"),
    "inventory is not a write"
  );
  add(
    "persistFailSafeAuthorityResolution is gated by evaluateFailSafePersistAdmission",
    persistCall >= 0 && persistGateCall >= 0,
    "fail-safe persist is not implicit"
  );
  add(
    "uses product resolver, T6 oracle, and recordAuthorityEquivalence",
    source.includes("resolveInteractionAuthority(") &&
      source.includes("observeLegacyTakeover") &&
      source.includes("recordAuthorityEquivalence") &&
      source.includes("evaluateIndependentEquivalence(") &&
      !source.includes("function compareEquivalence"),
    "no second verdict algorithm"
  );
  add(
    "Portfolio proof uses buildCaseSnapshots and evaluateMustSurface",
    source.includes("evaluatePortfolioAuthorityConflictReadback("),
    "read-back, not persist return value"
  );
  add(
    "is not a direct attachExternalConversationBinding caller",
    !/attachExternalConversationBinding\s*\(/.test(source),
    "single binding path preserved"
  );
  add(
    "does not call backfillAdmittedLegacyLeadIdentity",
    !/backfillAdmittedLegacyLeadIdentity\s*\(/.test(source),
    "T7-3 binding preparation is not executed here"
  );
  add(
    "does not call recordAuthorityResolutionObservation",
    !/recordAuthorityResolutionObservation\s*\(/.test(source),
    "discovery/evidence do not close incidents through the observation helper"
  );
  const prepareGateway = source.indexOf("prepareGatewayProcessEnv(argv, target)");
  const gatewayEnable = source.indexOf('process.env.LEGACY_GATEWAY_ENABLED = "true"');
  add(
    "prepares process-local encryption key and gateway flag before hosted clients",
    prepareGateway >= 0 &&
      gatewayEnable >= 0 &&
      openClientCall >= 0 &&
      source.includes("resolveEncryptionKeyForTarget(") &&
      prepareGateway < openClientCall,
    "verify-admission pattern"
  );
  const probeGate = source.indexOf("const probePlan = planDiscoverPlacementProbes(");
  const probeOpen = source.indexOf(
    "const legacyTarget = openHostedLegacyTargetAfterProbeAdmission("
  );
  add(
    "placement-probe target opening is gated by per-candidate planDiscoverPlacementProbes",
    probeGate >= 0 &&
      probeOpen >= 0 &&
      probeGate < probeOpen &&
      !source.includes("probeCandidates[0]") &&
      source.includes("probePlan.openTarget") &&
      source.includes("probePlan.admittedKeys"),
    "call-site hardening"
  );
  add(
    "does not invoke C2, pause, suppress, or send",
    !/from\s+["'][^"']*legacy-authority\/handle["']/.test(source) &&
      !/\bpauseCase\s*\(/.test(source) &&
      !/\bsuppress(?:Reply|Legacy)?\s*\(/.test(source) &&
      !/\bsendMessage\s*\(/.test(source),
    "no enforcement or prospect-facing path"
  );
  add(
    "never auto-selects a Case",
    source.includes("never auto-selects") &&
      source.includes("inventory != selection") &&
      source.includes("not RS-2 evidence"),
    "auto-select flags are refused"
  );
  add(
    "evidence requires an explicit frozen conversation set",
    source.includes("--conversations-file") &&
      source.includes("inventory != selection"),
    "no implicit default Case"
  );
  return checks;
}

export function evaluateOracleIndependenceSources(input: {
  evaluatorSource: string;
  runnerSource: string;
  oracleSource: string;
  resolverSource: string;
}): Sl6Check[] {
  input = {
    ...input,
    evaluatorSource: productSourceForContract(input.evaluatorSource),
  };
  const checks: Sl6Check[] = [];
  const add = (label: string, ok: boolean, detail?: string) => {
    checks.push({ assertion: "oracle-independence", label, ok, detail });
  };
  add(
    "oracle does not import or call resolveInteractionAuthority",
    !input.oracleSource.includes("resolveInteractionAuthority") &&
      !input.oracleSource.includes("relationship-authority/resolve"),
    "oracle stays independent"
  );
  add(
    "evaluator does not import resolver decision code",
    !/from\s+["'][^"']*relationship-authority\/resolve["']/.test(input.evaluatorSource) &&
      !/\bverdictFromTakeover\b/.test(input.evaluatorSource) &&
      !/\bresolveInteractionAuthority\s*\(/.test(input.evaluatorSource),
    "no resolver-output-to-oracle shortcut in the evaluator"
  );
  add(
    "resolver does not import the oracle",
    !input.resolverSource.includes("observeLegacyTakeover") &&
      !input.resolverSource.includes("authority-equivalence/oracle"),
    "product path does not depend on the oracle"
  );
  const oracleInputsBlock = input.runnerSource.match(/oracleInputs:\s*\{[\s\S]*?\}/);
  add(
    "runner feeds oracle the capability observation fields, not the product verdict",
    Boolean(oracleInputsBlock) &&
      input.runnerSource.includes("current.value.leadTakeoverActive") &&
      input.runnerSource.includes("current.value.lastOwnerInteractionAt") &&
      input.runnerSource.includes("current.value.numberKillSwitchActive") &&
      !oracleInputsBlock![0].includes("product.") &&
      !oracleInputsBlock![0].includes("resolution.humanActive") &&
      !oracleInputsBlock![0].includes("conversationAuthority") &&
      !/observeLegacyTakeover\(\s*\{[\s\S]*?humanActive/.test(input.runnerSource),
    "same observation, independent decisions"
  );
  return checks;
}
