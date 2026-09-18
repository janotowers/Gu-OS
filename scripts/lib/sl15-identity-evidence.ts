/**
 * Hosted-evidence evaluation for R1 SL-15 RS-2 (SA-15.5, SA-15.9, SA-15.10).
 *
 * Split out of `verify-sl15-identity.ts` so the pass/fail logic is pure and
 * unit-tested. The runner owns I/O — resolving the target, calling
 * `backfillAdmittedLegacyLeadIdentity`, reading rows, writing evidence.
 *
 * This is the historical/pilot repair half. It does not invent a Case, a
 * Contact, or a Traditional Gu lead. It only decides whether the rows the
 * reviewed helper left behind satisfy the frozen contract.
 */

/** The only environment this harness may write. */
export const SL15_HOSTED_ENVIRONMENT = "staging";

/**
 * Public staging project ref already recorded in SL-1 / SL-3 hosted evidence.
 * Checked before any durable write so a mis-aimed env file cannot land RS-2.
 */
export const SL15_STAGING_PROJECT_REF = "wdtjqlbsxwiijasicint";

/**
 * Product / main SHA delivered to staging for this RS-2 pairing
 * (PR #77 merge `12ed79e`). A different SHA is a different pairing.
 */
export const SL15_STAGING_PRODUCT_SHA =
  "12ed79ec05f5228a243695a026889f28e18280af";

const AUTO_SELECT_FLAGS = [
  "--auto",
  "--auto-select",
  "--pick",
  "--first",
  "--first-eligible",
  "--any",
  "--any-case",
  "--select-case",
] as const;

export interface HostedCheck {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface HostedIdentityCaseRow {
  id: string;
  case_type: string;
  organization_id: string | null;
  context_jsonb: Record<string, unknown> | null;
}

export interface HostedSourceEventRow {
  id: string;
  organization_id: string;
  source_system: string;
  status: string;
  external_lead_ref: string | null;
  decision_jsonb: Record<string, unknown> | null;
  admitted_case_id: string | null;
}

export interface HostedIdentityBindingRow {
  organization_id: string;
  source_system: string;
  binding_kind: string;
  external_id: string;
  ref_contact_id: string | null;
  provenance_jsonb: Record<string, unknown> | null;
}

export interface HostedConversationBindingRow {
  organization_id: string;
  case_id: string;
  contact_id: string;
  provider: string;
  thread_kind: string;
  external_conversation_ref: string;
  status: string;
}

export interface HostedContactRow {
  id: string;
  organization_id: string;
}

export const RESERVED_IDENTITY_PROVENANCE_KEYS = [
  "source",
  "source_system",
  "binding_kind",
  "opaque_legacy_lead_ref",
  "organization_id",
] as const;

export interface HostedSl15IdentityInputs {
  organizationId: string;
  caseId: string;
  first: {
    contactId: string;
    conversationBindingId: string;
  };
  retry: {
    contactId: string;
    conversationBindingId: string;
  };
  opportunity: HostedIdentityCaseRow | null;
  sourceEvent: HostedSourceEventRow | null;
  identityBindings: HostedIdentityBindingRow[];
  contacts: HostedContactRow[];
  conversationBindings: HostedConversationBindingRow[];
  leadRefBindings: HostedConversationBindingRow[];
  traditionalGuWrites: number;
  redact: (value: string | null) => string | null;
}

function opaqueFromContext(
  context: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const raw = context?.[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function evaluateGovernedAdmissionGate(params: {
  organizationId: string;
  caseId: string;
  opportunity: HostedIdentityCaseRow | null;
  sourceEvent: HostedSourceEventRow | null;
}): { ok: boolean; legacyLeadId: string | null; sourceEventId: string | null; reason: string } {
  const opportunity = params.opportunity;
  if (!opportunity) {
    return { ok: false, legacyLeadId: null, sourceEventId: null, reason: "case not found" };
  }
  if (opportunity.organization_id !== params.organizationId) {
    return {
      ok: false,
      legacyLeadId: null,
      sourceEventId: null,
      reason: "case Organization does not match",
    };
  }
  if (opportunity.case_type !== "lead_opportunity") {
    return {
      ok: false,
      legacyLeadId: null,
      sourceEventId: null,
      reason: "case is not a lead_opportunity",
    };
  }
  if (opportunity.id !== params.caseId) {
    return {
      ok: false,
      legacyLeadId: null,
      sourceEventId: null,
      reason: "loaded Case is not the named Case",
    };
  }
  const legacyLeadId = opaqueFromContext(opportunity.context_jsonb, "legacy_lead_id");
  const sourceEventId = opaqueFromContext(opportunity.context_jsonb, "source_event_id");
  if (!legacyLeadId || !sourceEventId) {
    return {
      ok: false,
      legacyLeadId,
      sourceEventId,
      reason: "case is not proven governed admission",
    };
  }
  const event = params.sourceEvent;
  if (
    !event ||
    event.id !== sourceEventId ||
    event.organization_id !== params.organizationId ||
    event.source_system !== "traditional_gu" ||
    event.status !== "completed" ||
    event.decision_jsonb?.disposition !== "admitted" ||
    event.admitted_case_id !== params.caseId ||
    (event.external_lead_ref?.trim() ?? "") !== legacyLeadId
  ) {
    return {
      ok: false,
      legacyLeadId,
      sourceEventId,
      reason: "source event is not governed admitted evidence for this Case",
    };
  }
  return { ok: true, legacyLeadId, sourceEventId, reason: "governed admitted" };
}

export function evaluateSa15Provenance(params: {
  organizationId: string;
  caseId: string;
  sourceEventId: string;
  legacyLeadId: string;
  provenance: Record<string, unknown> | null;
}): { ok: boolean; reason: string } {
  const provenance = params.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return { ok: false, reason: "provenance is not an object" };
  }
  if (
    provenance.source !== "resolve_or_create_contact_for_legacy_lead" ||
    provenance.source_system !== "traditional_gu" ||
    provenance.binding_kind !== "legacy_lead" ||
    provenance.opaque_legacy_lead_ref !== params.legacyLeadId ||
    provenance.organization_id !== params.organizationId
  ) {
    return { ok: false, reason: "reserved provenance fields are missing or overridden" };
  }
  if (
    (provenance.basis !== "admission" && provenance.basis !== "historical_backfill") ||
    provenance.source_event_id !== params.sourceEventId ||
    provenance.case_id !== params.caseId ||
    provenance.provisional_materialization !== true
  ) {
    return { ok: false, reason: "SA-15.5 evidence basis is incomplete" };
  }
  return { ok: true, reason: "SA-15.5 satisfied" };
}

export function evaluateHostedSl15Identity(
  input: HostedSl15IdentityInputs
): HostedCheck[] {
  const checks: HostedCheck[] = [];
  const gate = evaluateGovernedAdmissionGate({
    organizationId: input.organizationId,
    caseId: input.caseId,
    opportunity: input.opportunity,
    sourceEvent: input.sourceEvent,
  });
  checks.push({
    assertion: "SA-15.9",
    label: "the named Case is a governed-admitted real lead_opportunity",
    ok: gate.ok,
    detail: gate.ok
      ? `case=${input.redact(input.caseId)} lead=${input.redact(gate.legacyLeadId)}`
      : gate.reason,
  });

  const identityBindings = input.identityBindings.filter(
    (row) =>
      row.source_system === "traditional_gu" &&
      row.binding_kind === "legacy_lead" &&
      row.external_id === gate.legacyLeadId
  );
  checks.push({
    assertion: "SA-15.2/SA-15.3",
    label: "exactly one traditional_gu / legacy_lead binding exists for the opaque lead",
    ok: gate.ok && identityBindings.length === 1 && Boolean(identityBindings[0]?.ref_contact_id),
    detail: `bindings=${identityBindings.length}`,
  });

  const contactId = identityBindings[0]?.ref_contact_id ?? null;
  const contacts = input.contacts.filter((row) => row.id === contactId);
  checks.push({
    assertion: "SA-15.3",
    label: "one Organization-scoped Contact exists for that binding",
    ok:
      Boolean(contactId) &&
      contacts.length === 1 &&
      contacts[0]?.organization_id === input.organizationId,
    detail: contactId ? `contact=${input.redact(contactId)}` : "no Contact",
  });

  const provenance = evaluateSa15Provenance({
    organizationId: input.organizationId,
    caseId: input.caseId,
    sourceEventId: gate.sourceEventId ?? "",
    legacyLeadId: gate.legacyLeadId ?? "",
    provenance: identityBindings[0]?.provenance_jsonb ?? null,
  });
  checks.push({
    assertion: "SA-15.5",
    label: "the identity binding carries the required SA-15.5 provenance",
    ok: gate.ok && provenance.ok,
    detail: provenance.reason,
  });

  const conversation = input.conversationBindings.filter(
    (row) =>
      row.organization_id === input.organizationId &&
      row.case_id === input.caseId &&
      row.provider === "whatsapp_business" &&
      row.thread_kind === "gu" &&
      row.status === "active" &&
      row.external_conversation_ref === gate.legacyLeadId &&
      row.contact_id === contactId
  );
  checks.push({
    assertion: "SA-15.9",
    label: "one whatsapp_business / gu conversation binding exists under the opaque lead ref",
    ok: gate.ok && conversation.length === 1,
    detail: `gu_bindings=${conversation.length}`,
  });

  checks.push({
    assertion: "SA-15.9",
    label: "the C2 Lead-ref reverse map sees exactly that Case binding",
    ok:
      gate.ok &&
      input.leadRefBindings.length === 1 &&
      input.leadRefBindings[0]?.case_id === input.caseId &&
      input.leadRefBindings[0]?.thread_kind === "gu" &&
      input.leadRefBindings[0]?.external_conversation_ref === gate.legacyLeadId,
    detail: `lead_ref_bindings=${input.leadRefBindings.length}`,
  });

  checks.push({
    assertion: "SA-15.2/SA-15.7",
    label: "retry converges without another Contact or duplicate binding",
    ok:
      input.first.contactId === input.retry.contactId &&
      input.first.conversationBindingId === input.retry.conversationBindingId &&
      input.contacts.length === 1 &&
      identityBindings.length === 1 &&
      conversation.length === 1,
    detail: `contact_same=${input.first.contactId === input.retry.contactId} binding_same=${input.first.conversationBindingId === input.retry.conversationBindingId}`,
  });

  const foreignIdentity = input.identityBindings.some(
    (row) => row.organization_id !== input.organizationId
  );
  const foreignConversation = input.conversationBindings.some(
    (row) => row.organization_id !== input.organizationId
  );
  const foreignContact = input.contacts.some(
    (row) => row.organization_id !== input.organizationId
  );
  checks.push({
    assertion: "SA-15.11",
    label: "Organization containment holds for the Contact and both bindings",
    ok: !foreignIdentity && !foreignConversation && !foreignContact,
    detail:
      foreignIdentity || foreignConversation || foreignContact
        ? "a row escaped the named Organization"
        : "all observed rows stay in the named Organization",
  });

  checks.push({
    assertion: "SA-15.10",
    label: "zero Traditional Gu writes occurred",
    ok: input.traditionalGuWrites === 0,
    detail: `traditional_gu_writes=${input.traditionalGuWrites}`,
  });

  return checks;
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

export function normalizeSl15ProductSha(
  value: string | null | undefined
): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  const expected = SL15_STAGING_PRODUCT_SHA.toLowerCase();
  if (!trimmed) return SL15_STAGING_PRODUCT_SHA;
  if (trimmed === expected) return SL15_STAGING_PRODUCT_SHA;
  if (trimmed.length >= 7 && expected.startsWith(trimmed)) {
    return SL15_STAGING_PRODUCT_SHA;
  }
  return null;
}

export interface Sl15HostedWriteGateInput {
  argv: string[];
  targetName: string;
  targetProjectRef: string;
}

export interface Sl15HostedWriteGate {
  ok: boolean;
  reason: string;
  organizationId: string | null;
  caseId: string | null;
  productSha: string | null;
}

/**
 * Fail-closed write preconditions. Pure: no I/O. The runner must call this
 * after target resolution / `assertBinding` and before `createClient` or
 * `backfillAdmittedLegacyLeadIdentity`.
 */
export function evaluateSl15HostedWriteGate(
  input: Sl15HostedWriteGateInput
): Sl15HostedWriteGate {
  const fail = (reason: string): Sl15HostedWriteGate => ({
    ok: false,
    reason,
    organizationId: null,
    caseId: null,
    productSha: null,
  });

  if (
    input.argv.some(
      (arg) => arg.startsWith("--legacy") || arg === "--lead" || arg === "--lead-file"
    )
  ) {
    return fail(
      "Traditional Gu target / raw lead flags are refused; name --organization and --case-id"
    );
  }
  if (input.argv.some((arg) => (AUTO_SELECT_FLAGS as readonly string[]).includes(arg))) {
    return fail("this procedure never auto-selects a Case");
  }
  if (!input.argv.includes("--acknowledge-durable-write")) {
    return fail("--acknowledge-durable-write is required before any durable write");
  }

  const envFlag = parseNamedArg(input.argv, "--env");
  if (envFlag !== SL15_HOSTED_ENVIRONMENT) {
    return fail(`--env ${SL15_HOSTED_ENVIRONMENT} is required; other environments are refused`);
  }
  if (input.targetName !== SL15_HOSTED_ENVIRONMENT) {
    return fail(`target environment must be ${SL15_HOSTED_ENVIRONMENT}`);
  }
  if (input.targetProjectRef !== SL15_STAGING_PROJECT_REF) {
    return fail("target project ref is not the expected staging project");
  }

  const organizationId = parseNamedArg(input.argv, "--organization") ?? null;
  const caseId = parseNamedArg(input.argv, "--case-id") ?? null;
  if (!organizationId) {
    return fail("--organization <uuid> must be supplied explicitly");
  }
  if (!caseId) {
    return fail("--case-id <uuid> must be supplied explicitly; a Case is never selected");
  }

  const productSha = normalizeSl15ProductSha(parseNamedArg(input.argv, "--product-sha"));
  if (!productSha) {
    return fail("product SHA is not the Gu OS SHA delivered to staging");
  }

  return {
    ok: true,
    reason: "write preconditions satisfied",
    organizationId,
    caseId,
    productSha,
  };
}

export interface TrackedTreeInspection {
  unstagedStatus: number;
  stagedStatus: number;
}

/**
 * Repository-wide tracked-diff inspection. Equivalent to:
 *   git diff --quiet HEAD --
 *   git diff --cached --quiet HEAD --
 *
 * Untracked and ignored files (for example `.env.staging.local`) are invisible
 * to both commands and must not be treated as a tracked-code mismatch.
 */
export function inspectTrackedWorkingTree(
  runGit: (args: readonly string[]) => { status: number }
): TrackedTreeInspection {
  const unstaged = runGit(["diff", "--quiet", "HEAD", "--"]);
  const staged = runGit(["diff", "--cached", "--quiet", "HEAD", "--"]);
  return {
    unstagedStatus: unstaged.status,
    stagedStatus: staged.status,
  };
}

export function evaluateTrackedTreeMatchesHead(
  inspection: TrackedTreeInspection
): { ok: boolean; reason: string } {
  if (inspection.unstagedStatus !== 0) {
    return {
      ok: false,
      reason:
        inspection.unstagedStatus === 1
          ? "tracked working tree differs from HEAD"
          : "could not prove tracked working tree matches HEAD",
    };
  }
  if (inspection.stagedStatus !== 0) {
    return {
      ok: false,
      reason:
        inspection.stagedStatus === 1
          ? "staged tracked files differ from HEAD"
          : "could not prove staged tree matches HEAD",
    };
  }
  return { ok: true, reason: "executed tracked code matches HEAD" };
}

export function evaluateVerifierSha(
  sha: string | null | undefined
): { ok: boolean; sha: string | null; reason: string } {
  const trimmed = (sha ?? "").trim();
  if (!/^[0-9a-f]{40}$/i.test(trimmed)) {
    return {
      ok: false,
      sha: null,
      reason: "verifier SHA is not a full git HEAD SHA",
    };
  }
  return { ok: true, sha: trimmed.toLowerCase(), reason: "full HEAD SHA" };
}

export function evaluateSl15EvidencePins(pins: {
  productSha: string | null;
  verifierSha: string | null;
  environment: string | null;
  projectRef: string | null;
  ranAt: string | null;
}): { ok: boolean; reason: string } {
  if (pins.environment !== SL15_HOSTED_ENVIRONMENT) {
    return { ok: false, reason: "environment is not staging" };
  }
  if (pins.projectRef !== SL15_STAGING_PROJECT_REF) {
    return { ok: false, reason: "project ref is not the expected staging project" };
  }
  if (normalizeSl15ProductSha(pins.productSha) !== SL15_STAGING_PRODUCT_SHA) {
    return { ok: false, reason: "product SHA is not the delivered staging SHA" };
  }
  if (!evaluateVerifierSha(pins.verifierSha).ok) {
    return { ok: false, reason: "verifier SHA is missing or not a full git SHA" };
  }
  if (!pins.ranAt || Number.isNaN(Date.parse(pins.ranAt))) {
    return { ok: false, reason: "execution timestamp is missing" };
  }
  return { ok: true, reason: "pins present" };
}

const ALLOWED_VERIFIER_IMPORTS = new Set([
  "node:crypto",
  "node:fs",
  "node:child_process",
  "@supabase/supabase-js",
  "@agents/db",
  "./lib/sl15-identity-evidence",
  "./lib/target-env",
]);

/**
 * Structural contract for `scripts/verify-sl15-identity.ts`.
 * Proves the fail-closed shape from source so a hosted run cannot depend on
 * unreproducible working-tree edits that weaken the gate.
 */
export function evaluateSl15VerifierSourceContract(source: string): HostedCheck[] {
  const checks: HostedCheck[] = [];
  const add = (label: string, ok: boolean, detail?: string) => {
    checks.push({ assertion: "harness", label, ok, detail });
  };

  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  const unexpected = imports.filter((spec) => !ALLOWED_VERIFIER_IMPORTS.has(spec));
  const firstHelperCall = source.search(/await backfillAdmittedLegacyLeadIdentity\(/);
  const assertBindingCall = source.search(/assertBinding\(target\)/);
  const writeGateCall = source.search(/evaluateSl15HostedWriteGate\(/);
  const admissionGateCall = source.search(/evaluateGovernedAdmissionGate\(/);
  const createClientCall = source.search(/createClient\(/);
  const treeGuardCall = source.search(/requireExecutedTrackedCodeMatchesHead\(/);
  add(
    "imports only the reviewed helper, target binding, and evidence evaluator",
    unexpected.length === 0,
    unexpected.length > 0 ? `unexpected=${unexpected.join(",")}` : "allowed imports only"
  );

  add(
    "has no Traditional Gu write client/path",
    !imports.some((spec) => /legacy-gateway|traditional|td-13|source-clients/i.test(spec)),
    "no legacy/Traditional Gu import"
  );

  add(
    "requires evaluateSl15HostedWriteGate before createClient",
    writeGateCall >= 0 && createClientCall >= 0 && writeGateCall < createClientCall,
    "write gate precedes client construction"
  );

  add(
    "proves executed tracked code matches HEAD before createClient and before the helper",
    treeGuardCall >= 0 &&
      createClientCall >= 0 &&
      firstHelperCall >= 0 &&
      treeGuardCall < createClientCall &&
      treeGuardCall < firstHelperCall &&
      source.includes("inspectTrackedWorkingTree") &&
      source.includes("evaluateTrackedTreeMatchesHead") &&
      source.includes("evaluateVerifierSha"),
    "dirty tracked tree cannot record verifierSha"
  );

  add(
    "checks the expected staging project/ref before any durable write",
    source.includes("SL15_STAGING_PROJECT_REF") &&
      assertBindingCall >= 0 &&
      firstHelperCall >= 0 &&
      assertBindingCall < firstHelperCall &&
      writeGateCall >= 0 &&
      writeGateCall < firstHelperCall,
    "assertBinding and expected ref precede the helper"
  );

  add(
    "permits staging only",
    source.includes("SL15_HOSTED_ENVIRONMENT") &&
      source.includes("evaluateSl15HostedWriteGate"),
    "non-staging targets fail the write gate"
  );

  add(
    "requires --acknowledge-durable-write",
    source.includes("--acknowledge-durable-write") &&
      source.includes("evaluateSl15HostedWriteGate"),
    "ack flag is a write-gate input"
  );

  add(
    "requires Organization and Case to be supplied explicitly",
    source.includes("--organization") &&
      source.includes("--case-id") &&
      source.includes("will not invent or select"),
    "no implicit Case"
  );

  add(
    "never auto-selects a Case",
    source.includes("never auto-selects") ||
      source.includes("will not invent or select"),
    "auto-select flags are refused"
  );

  add(
    "proves governed admission before the first write",
    admissionGateCall >= 0 &&
      firstHelperCall >= 0 &&
      admissionGateCall < firstHelperCall &&
      source.includes("No Contact, identity binding or conversation binding was written"),
    "gate failure throws before the helper"
  );

  const helperCalls = source.match(/await backfillAdmittedLegacyLeadIdentity\(/g) ?? [];
  add(
    "performs business writes only through backfillAdmittedLegacyLeadIdentity, twice",
    helperCalls.length === 2 &&
      !/\.from\s*\(/.test(source) &&
      !/\.rpc\s*\(/.test(source) &&
      !/\b(?:executeSql|execSql)\b/.test(source),
    `helper_calls=${helperCalls.length}`
  );

  add(
    "has no ad-hoc SQL business write",
    !/\.from\s*\(/.test(source) &&
      !/\.rpc\s*\(/.test(source) &&
      !/\b(?:query|sql)\s*`/.test(source),
    "no PostgREST write or raw SQL in the runner"
  );

  add(
    "verifies Contact, typed binding, GU conversation, C2 reverse map, containment, TG writes=0",
    source.includes("findBindingInOrganization") &&
      /["']legacy_lead["']/.test(source) &&
      source.includes("listActiveGuConversationBindingsByRef") &&
      source.includes("whatsapp_business") &&
      source.includes("evaluateHostedSl15Identity") &&
      source.includes("traditionalGuWrites: 0"),
    "hosted evaluator is the pass/fail authority"
  );

  add(
    "pins product SHA, verifier SHA, staging environment, and timestamp",
    source.includes("productSha") &&
      source.includes("verifierSha") &&
      source.includes("evaluateSl15EvidencePins") &&
      source.includes("ranAt"),
    "evidence envelope is pinned"
  );

  return checks;
}
