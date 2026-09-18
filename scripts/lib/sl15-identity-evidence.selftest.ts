/**
 * Selftests for the SL-15 hosted-evidence evaluator and fail-closed harness.
 *
 * The hosted run cannot be tested without staging. These prove the assertions
 * fail when the thing they name is not true: a constructed Case, a WAMID
 * conversation ref, a rewritten provenance, a second Contact, or a Traditional
 * Gu write cannot pass.
 *
 * They also prove, without a hosted write, that the verifier:
 *   * permits staging only;
 *   * checks the expected staging project/ref before any durable write;
 *   * requires --acknowledge-durable-write;
 *   * requires Organization and Case explicitly;
 *   * never auto-selects a Case;
 *   * proves governed admission before the first write;
 *   * writes only through backfillAdmittedLegacyLeadIdentity, twice;
 *   * has no ad-hoc SQL business write and no Traditional Gu write path;
 *   * pins product SHA, verifier SHA, staging environment, and timestamp;
 *   * records verifierSha only when the tracked working tree matches HEAD.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateGovernedAdmissionGate,
  evaluateHostedSl15Identity,
  evaluateSa15Provenance,
  evaluateSl15EvidencePins,
  evaluateSl15HostedWriteGate,
  evaluateSl15VerifierSourceContract,
  evaluateTrackedTreeMatchesHead,
  evaluateVerifierSha,
  inspectTrackedWorkingTree,
  SL15_HOSTED_ENVIRONMENT,
  SL15_STAGING_PRODUCT_SHA,
  SL15_STAGING_PROJECT_REF,
  type HostedSl15IdentityInputs,
} from "./sl15-identity-evidence";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const CASE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EVENT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const LEAD = "5215500000001521550000000252155000000003";
const CONTACT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BINDING = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function redact(value: string | null): string | null {
  return value ? `sha256:${value.slice(0, 8)}` : null;
}

function opportunity() {
  return {
    id: CASE,
    case_type: "lead_opportunity",
    organization_id: ORG,
    context_jsonb: {
      legacy_lead_id: LEAD,
      source_event_id: EVENT,
      source_system: "traditional_gu",
    },
  };
}

function sourceEvent() {
  return {
    id: EVENT,
    organization_id: ORG,
    source_system: "traditional_gu",
    status: "completed",
    external_lead_ref: LEAD,
    decision_jsonb: { disposition: "admitted" },
    admitted_case_id: CASE,
  };
}

function provenance() {
  return {
    source: "resolve_or_create_contact_for_legacy_lead",
    source_system: "traditional_gu",
    binding_kind: "legacy_lead",
    opaque_legacy_lead_ref: LEAD,
    organization_id: ORG,
    basis: "historical_backfill",
    source_event_id: EVENT,
    case_id: CASE,
    provisional_materialization: true,
  };
}

function happy(overrides: Partial<HostedSl15IdentityInputs> = {}): HostedSl15IdentityInputs {
  return {
    organizationId: ORG,
    caseId: CASE,
    first: { contactId: CONTACT, conversationBindingId: BINDING },
    retry: { contactId: CONTACT, conversationBindingId: BINDING },
    opportunity: opportunity(),
    sourceEvent: sourceEvent(),
    identityBindings: [
      {
        organization_id: ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_lead",
        external_id: LEAD,
        ref_contact_id: CONTACT,
        provenance_jsonb: provenance(),
      },
    ],
    contacts: [{ id: CONTACT, organization_id: ORG }],
    conversationBindings: [
      {
        organization_id: ORG,
        case_id: CASE,
        contact_id: CONTACT,
        provider: "whatsapp_business",
        thread_kind: "gu",
        external_conversation_ref: LEAD,
        status: "active",
      },
    ],
    leadRefBindings: [
      {
        organization_id: ORG,
        case_id: CASE,
        contact_id: CONTACT,
        provider: "whatsapp_business",
        thread_kind: "gu",
        external_conversation_ref: LEAD,
        status: "active",
      },
    ],
    traditionalGuWrites: 0,
    redact,
    ...overrides,
  };
}

function failed(checks: ReturnType<typeof evaluateHostedSl15Identity>, assertion: string) {
  return checks.filter((check) => check.assertion === assertion && !check.ok);
}

function writeArgv(overrides: string[] = []): string[] {
  return [
    "--env-file",
    ".env.staging.local",
    "--env",
    SL15_HOSTED_ENVIRONMENT,
    "--organization",
    ORG,
    "--case-id",
    CASE,
    "--acknowledge-durable-write",
    ...overrides,
  ];
}

function writeGate(
  argv: string[],
  target: { name?: string; projectRef?: string } = {}
) {
  return evaluateSl15HostedWriteGate({
    argv,
    targetName: target.name ?? SL15_HOSTED_ENVIRONMENT,
    targetProjectRef: target.projectRef ?? SL15_STAGING_PROJECT_REF,
  });
}

{
  const gate = evaluateGovernedAdmissionGate({
    organizationId: ORG,
    caseId: CASE,
    opportunity: {
      id: CASE,
      case_type: "lead_opportunity",
      organization_id: ORG,
      context_jsonb: { legacy_lead_id: LEAD },
    },
    sourceEvent: null,
  });
  assert.equal(gate.ok, false, "Case + legacy_lead_id is not governed admission");
}

{
  const ok = evaluateSa15Provenance({
    organizationId: ORG,
    caseId: CASE,
    sourceEventId: EVENT,
    legacyLeadId: LEAD,
    provenance: { ...provenance(), source: "attacker" },
  });
  assert.equal(ok.ok, false, "reserved provenance cannot be overridden");
}

{
  const checks = evaluateHostedSl15Identity(happy());
  assert.equal(checks.every((check) => check.ok), true, "honest hosted shape passes");
}

{
  const checks = evaluateHostedSl15Identity(
    happy({
      opportunity: {
        id: CASE,
        case_type: "lead_opportunity",
        organization_id: ORG,
        context_jsonb: { legacy_lead_id: LEAD },
      },
      sourceEvent: null,
    })
  );
  assert.ok(failed(checks, "SA-15.9").length > 0, "constructed Case cannot pass SA-15.9");
}

{
  const checks = evaluateHostedSl15Identity(
    happy({
      conversationBindings: [
        {
          organization_id: ORG,
          case_id: CASE,
          contact_id: CONTACT,
          provider: "whatsapp_business",
          thread_kind: "gu",
          external_conversation_ref: "wamid.HBg-hosted-pilot",
          status: "active",
        },
      ],
    })
  );
  assert.ok(
    checks.some((check) => !check.ok && check.label.includes("opaque lead ref")),
    "a WAMID conversation ref cannot satisfy the C2 Lead-ref contract"
  );
}

{
  const checks = evaluateHostedSl15Identity(
    happy({
      retry: { contactId: "other-contact", conversationBindingId: BINDING },
      contacts: [
        { id: CONTACT, organization_id: ORG },
        { id: "other-contact", organization_id: ORG },
      ],
    })
  );
  assert.ok(failed(checks, "SA-15.2/SA-15.7").length > 0, "retry must not mint a second Contact");
}

{
  const checks = evaluateHostedSl15Identity(happy({ traditionalGuWrites: 1 }));
  assert.ok(failed(checks, "SA-15.10").length === 1, "any Traditional Gu write fails SA-15.10");
}

{
  const checks = evaluateHostedSl15Identity(
    happy({
      identityBindings: [
        {
          organization_id: OTHER,
          source_system: "traditional_gu",
          binding_kind: "legacy_lead",
          external_id: LEAD,
          ref_contact_id: CONTACT,
          provenance_jsonb: provenance(),
        },
      ],
    })
  );
  assert.ok(failed(checks, "SA-15.11").length === 1, "a foreign-org binding fails containment");
}

{
  const ok = writeGate(writeArgv());
  assert.equal(ok.ok, true, "honest staging write preconditions pass");
  assert.equal(ok.organizationId, ORG);
  assert.equal(ok.caseId, CASE);
  assert.equal(ok.productSha, SL15_STAGING_PRODUCT_SHA);
}

{
  const denied = writeGate(writeArgv(), { name: "production" });
  assert.equal(denied.ok, false, "production target is refused");
}

{
  const denied = writeGate(
    writeArgv().map((arg) => (arg === SL15_HOSTED_ENVIRONMENT ? "production" : arg))
  );
  assert.equal(denied.ok, false, "--env production is refused");
}

{
  const denied = writeGate(writeArgv(), { projectRef: "aaaaaaaaaaaaaaaaaaaa" });
  assert.equal(denied.ok, false, "unexpected project ref is refused before write");
}

{
  const denied = writeGate(writeArgv().filter((arg) => arg !== "--acknowledge-durable-write"));
  assert.equal(denied.ok, false, "missing durable-write acknowledgement is refused");
}

{
  const argv = writeArgv().filter((arg) => arg !== ORG);
  const orgIdx = argv.indexOf("--organization");
  argv.splice(orgIdx, 1);
  const denied = writeGate(argv);
  assert.equal(denied.ok, false, "missing --organization is refused");
}

{
  const argv = writeArgv().filter((arg) => arg !== CASE);
  const caseIdx = argv.indexOf("--case-id");
  argv.splice(caseIdx, 1);
  const denied = writeGate(argv);
  assert.equal(denied.ok, false, "missing --case-id is refused");
}

{
  const denied = writeGate(writeArgv(["--auto"]));
  assert.equal(denied.ok, false, "auto-select is refused");
}

{
  const denied = writeGate(writeArgv(["--lead", "not-a-case"]));
  assert.equal(denied.ok, false, "raw lead flag is refused");
}

{
  const denied = writeGate(writeArgv(["--legacy-env", "prod"]));
  assert.equal(denied.ok, false, "Traditional Gu target flag is refused");
}

{
  const denied = writeGate(writeArgv(["--product-sha", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]));
  assert.equal(denied.ok, false, "a different product SHA is refused");
}

{
  const ok = writeGate(writeArgv(["--product-sha", "12ed79e"]));
  assert.equal(ok.ok, true, "the delivered short SHA is accepted");
  assert.equal(ok.productSha, SL15_STAGING_PRODUCT_SHA);
}

{
  const pins = evaluateSl15EvidencePins({
    productSha: SL15_STAGING_PRODUCT_SHA,
    verifierSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    environment: SL15_HOSTED_ENVIRONMENT,
    projectRef: SL15_STAGING_PROJECT_REF,
    ranAt: "2026-09-18T19:00:00.000Z",
  });
  assert.equal(pins.ok, true, "honest evidence pins pass");
}

{
  const pins = evaluateSl15EvidencePins({
    productSha: SL15_STAGING_PRODUCT_SHA,
    verifierSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    environment: "production",
    projectRef: SL15_STAGING_PROJECT_REF,
    ranAt: "2026-09-18T19:00:00.000Z",
  });
  assert.equal(pins.ok, false, "non-staging evidence environment is refused");
}

{
  const pins = evaluateSl15EvidencePins({
    productSha: SL15_STAGING_PRODUCT_SHA,
    verifierSha: "not-a-sha",
    environment: SL15_HOSTED_ENVIRONMENT,
    projectRef: SL15_STAGING_PROJECT_REF,
    ranAt: "2026-09-18T19:00:00.000Z",
  });
  assert.equal(pins.ok, false, "missing verifier SHA is refused");
}

{
  const short = evaluateVerifierSha("12ed79e");
  assert.equal(short.ok, false, "a short HEAD prefix is not a verifier SHA");
  const full = evaluateVerifierSha(SL15_STAGING_PRODUCT_SHA);
  assert.equal(full.ok, true, "a full 40-character SHA is accepted");
  assert.equal(full.sha, SL15_STAGING_PRODUCT_SHA);
}

{
  const calls: string[][] = [];
  inspectTrackedWorkingTree((args) => {
    calls.push([...args]);
    return { status: 0 };
  });
  assert.deepEqual(
    calls,
    [
      ["diff", "--quiet", "HEAD", "--"],
      ["diff", "--cached", "--quiet", "HEAD", "--"],
    ],
    "inspection is the repository-wide tracked-diff pair"
  );
}

{
  assert.equal(
    evaluateTrackedTreeMatchesHead({ unstagedStatus: 0, stagedStatus: 0 }).ok,
    true,
    "a clean tracked tree passes"
  );
  assert.equal(
    evaluateTrackedTreeMatchesHead({ unstagedStatus: 1, stagedStatus: 0 }).ok,
    false,
    "an unstaged tracked modification fails closed"
  );
  assert.equal(
    evaluateTrackedTreeMatchesHead({ unstagedStatus: 0, stagedStatus: 1 }).ok,
    false,
    "a staged tracked modification fails closed"
  );
  assert.equal(
    evaluateTrackedTreeMatchesHead({ unstagedStatus: 128, stagedStatus: 0 }).ok,
    false,
    "a git inspection error fails closed"
  );
}

{
  const root = mkdtempSync(join(tmpdir(), "sl15-tree-"));
  const git = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "sl15-test",
        GIT_AUTHOR_EMAIL: "sl15-test@example.com",
        GIT_COMMITTER_NAME: "sl15-test",
        GIT_COMMITTER_EMAIL: "sl15-test@example.com",
      },
    });
  const inspect = () =>
    inspectTrackedWorkingTree((args) => {
      const result = git([...args]);
      return { status: result.status ?? 128 };
    });
  try {
    assert.equal(git(["init", "-b", "main"]).status, 0);
    assert.equal(git(["config", "core.autocrlf", "false"]).status, 0);
    assert.equal(git(["config", "commit.gpgsign", "false"]).status, 0);
    writeFileSync(join(root, "tracked.ts"), "export const x = 1;\n");
    writeFileSync(join(root, ".gitignore"), ".env.staging.local\n");
    assert.equal(git(["add", "tracked.ts", ".gitignore"]).status, 0);
    assert.equal(git(["commit", "-m", "init"]).status, 0);

    const head = evaluateVerifierSha(git(["rev-parse", "HEAD"]).stdout);
    assert.equal(head.ok, true, "verifier SHA is the full HEAD SHA");
    assert.match(head.sha ?? "", /^[0-9a-f]{40}$/);
    assert.equal((git(["rev-parse", "HEAD"]).stdout ?? "").trim().toLowerCase(), head.sha);

    assert.equal(
      evaluateTrackedTreeMatchesHead(inspect()).ok,
      true,
      "a clean tracked tree passes against a real git repo"
    );

    writeFileSync(join(root, "tracked.ts"), "export const x = 2;\n");
    assert.equal(
      evaluateTrackedTreeMatchesHead(inspect()).ok,
      false,
      "a tracked unstaged modification fails closed against a real git repo"
    );

    assert.equal(git(["add", "tracked.ts"]).status, 0);
    assert.equal(git(["restore", "--source=HEAD", "--worktree", "tracked.ts"]).status, 0);
    const stagedOnly = inspect();
    assert.equal(stagedOnly.unstagedStatus, 0, "worktree restored to HEAD");
    assert.equal(stagedOnly.stagedStatus, 1, "index still differs from HEAD");
    assert.equal(
      evaluateTrackedTreeMatchesHead(stagedOnly).ok,
      false,
      "a staged tracked modification fails closed against a real git repo"
    );

    assert.equal(git(["restore", "--staged", "--worktree", "tracked.ts"]).status, 0);
    writeFileSync(join(root, ".env.staging.local"), "GUOS_STAGING_SUPABASE_URL=https://example.invalid\n");
    writeFileSync(join(root, "operator-notes.local"), "untracked operator material\n");
    assert.equal(
      evaluateTrackedTreeMatchesHead(inspect()).ok,
      true,
      "untracked/ignored operator environment material is not a tracked-code mismatch"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../verify-sl15-identity.ts"), "utf8");
  const checks = evaluateSl15VerifierSourceContract(source);
  const failedChecks = checks.filter((check) => !check.ok);
  assert.equal(
    failedChecks.length,
    0,
    `verifier source contract failed: ${failedChecks.map((check) => check.label).join("; ")}`
  );
}

{
  const weakened = `
    import { createClient } from "@supabase/supabase-js";
    import { backfillAdmittedLegacyLeadIdentity } from "@agents/db";
    import { createLegacyWriteClient } from "./lib/legacy-gateway";
    const target = resolveTarget();
    const db = createClient(target.supabaseUrl, target.serviceRoleKey);
    await db.from("contacts").insert({});
    await backfillAdmittedLegacyLeadIdentity(db, {});
  `;
  const checks = evaluateSl15VerifierSourceContract(weakened);
  assert.ok(
    checks.some((check) => !check.ok && check.label.includes("Traditional Gu")),
    "a Traditional Gu client import fails the source contract"
  );
  assert.ok(
    checks.some((check) => !check.ok && check.label.includes("ad-hoc SQL")),
    "an ad-hoc SQL write fails the source contract"
  );
  assert.ok(
    checks.some((check) => !check.ok && check.label.includes("twice")),
    "a single helper call fails the source contract"
  );
  assert.ok(
    checks.some((check) => !check.ok && check.label.includes("tracked code matches HEAD")),
    "omitting the dirty-tree guard fails the source contract"
  );
}

console.log("sl15-identity-evidence selftest: ok");
