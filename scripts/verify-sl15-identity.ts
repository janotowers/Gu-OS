/**
 * Hosted RS-2 procedure for SL-15 (SA-15.5, SA-15.9, SA-15.10, SA-15.11).
 *
 * One already-admitted real pilot Case → `backfillAdmittedLegacyLeadIdentity()`
 * → Contact + typed `legacy_lead` binding + `whatsapp_business`/`gu`
 * conversation binding under the opaque lead ref. Retry must converge.
 *
 * THIS RUN WRITES — but only through the reviewed helper. It does not:
 *   * invent a Case or a Contact;
 *   * run ad-hoc SQL;
 *   * open a Traditional Gu client;
 *   * write Traditional Gu;
 *   * reach a prospect-facing effect.
 *
 * Staging only. The expected staging project/ref is checked, and
 * `--acknowledge-durable-write` makes the Gu OS write a decision.
 *
 * Organization and Case must be named by the operator. This runner will not invent or select a Case and never auto-selects one.
 *
 * The named Case is proven from existing admission evidence
 * (`context.source_event_id` + the matching `source_events` row) before the
 * first write. Case + `legacy_lead_id` alone is not enough.
 *
 * PRIVACY: the evidence file records shapes, counts and digests — never a
 * lead id, Case id, Contact id or phone number.
 *
 * Usage:
 *   npx tsx scripts/verify-sl15-identity.ts \
 *     --env-file .env.staging.local --env staging \
 *     --organization <uuid> --case-id <uuid> \
 *     --acknowledge-durable-write \
 *     [--product-sha 12ed79e] \
 *     [--json evidence.json]
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  backfillAdmittedLegacyLeadIdentity,
  findBindingInOrganization,
  getContactById,
  getOperationalCase,
  getOrganizationById,
  getSourceEventById,
  listActiveGuConversationBindingsByRef,
  listConversationBindingsForCase,
  type DbClient,
} from "@agents/db";
import {
  evaluateGovernedAdmissionGate,
  evaluateHostedSl15Identity,
  evaluateSl15EvidencePins,
  evaluateSl15HostedWriteGate,
  SL15_HOSTED_ENVIRONMENT,
  SL15_STAGING_PROJECT_REF,
  type HostedCheck,
} from "./lib/sl15-identity-evidence";
import {
  assertBinding,
  describeTarget,
  parseTargetArgs,
  resolveTarget,
} from "./lib/target-env";

const checks: HostedCheck[] = [];
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

function redact(value: string | null): string | null {
  if (!value) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function requireVerifierSha(): string {
  const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("FAIL CLOSED - could not pin verifier SHA from git rev-parse HEAD");
  }
  return sha;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonPath = (() => {
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "--json") return (argv[++i] ?? "").trim() || undefined;
    }
    return undefined;
  })();

  const target = resolveTarget(parseTargetArgs(argv));
  assertBinding(target);

  const writeGate = evaluateSl15HostedWriteGate({
    argv,
    targetName: target.name,
    targetProjectRef: target.projectRef,
  });
  if (!writeGate.ok || !writeGate.organizationId || !writeGate.caseId || !writeGate.productSha) {
    throw new Error(`FAIL CLOSED - ${writeGate.reason}`);
  }

  const organizationId = writeGate.organizationId;
  const caseId = writeGate.caseId;
  const productSha = writeGate.productSha;
  const verifierSha = requireVerifierSha();
  const ranAt = new Date().toISOString();
  const pins = evaluateSl15EvidencePins({
    productSha,
    verifierSha,
    environment: target.name,
    projectRef: target.projectRef,
    ranAt,
  });
  if (!pins.ok) {
    throw new Error(`FAIL CLOSED - ${pins.reason}`);
  }

  console.log(describeTarget(target));
  console.log(`environment: ${SL15_HOSTED_ENVIRONMENT}`);
  console.log(`expected_project_ref: ${SL15_STAGING_PROJECT_REF}`);
  console.log(`product_sha: ${productSha}`);
  console.log(`verifier_sha: ${verifierSha}`);
  console.log(`organization: ${redact(organizationId)}`);
  console.log(`case: ${redact(caseId)}\n`);
  console.log("traditional_gu: not opened (SA-15.10)\n");

  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error(
      "FAIL CLOSED - SL-15 identity writes are service-role-only and need " +
        "GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL."
    );
  }

  const db = createClient(
    target.supabaseUrl,
    target.serviceRoleKey
  ) as unknown as DbClient;

  const organization = await getOrganizationById(db, organizationId);
  record(
    "preflight",
    "the Organization resolves in the declared Gu OS environment",
    Boolean(organization),
    organization ? `status=${organization.status}` : "not found"
  );

  const opportunity = await getOperationalCase(db, caseId);
  const sourceEventId =
    typeof opportunity?.context_jsonb?.source_event_id === "string"
      ? opportunity.context_jsonb.source_event_id.trim()
      : "";
  const sourceEvent = sourceEventId
    ? await getSourceEventById(db, organizationId, sourceEventId)
    : null;
  const gate = evaluateGovernedAdmissionGate({
    organizationId,
    caseId,
    opportunity,
    sourceEvent,
  });
  record(
    "SA-15.9",
    "the named Case is an already-admitted real lead_opportunity under the governed-admission gate",
    gate.ok,
    gate.ok
      ? `lead=${redact(gate.legacyLeadId)} source_event=${redact(gate.sourceEventId)}`
      : gate.reason
  );
  if (!gate.ok || !gate.legacyLeadId) {
    throw new Error(
      "FAIL CLOSED - governed admission evidence is absent, inconsistent or ambiguous. " +
        "No Contact, identity binding or conversation binding was written."
    );
  }

  const first = await backfillAdmittedLegacyLeadIdentity(db, {
    organizationId,
    caseId,
  });
  const retry = await backfillAdmittedLegacyLeadIdentity(db, {
    organizationId,
    caseId,
  });

  const identity = await findBindingInOrganization(db, {
    organizationId,
    sourceSystem: "traditional_gu",
    bindingKind: "legacy_lead",
    externalId: gate.legacyLeadId,
  });
  const contact = identity?.ref_contact_id
    ? await getContactById(db, organizationId, identity.ref_contact_id)
    : null;
  const conversationBindings = await listConversationBindingsForCase(db, {
    organizationId,
    caseId,
  });
  const leadRefBindings = await listActiveGuConversationBindingsByRef(db, {
    organizationId,
    externalConversationRef: gate.legacyLeadId,
    provider: "whatsapp_business",
  });

  const evaluated = evaluateHostedSl15Identity({
    organizationId,
    caseId,
    first: {
      contactId: first.contactId,
      conversationBindingId: first.conversationBinding.id,
    },
    retry: {
      contactId: retry.contactId,
      conversationBindingId: retry.conversationBinding.id,
    },
    opportunity,
    sourceEvent,
    identityBindings: identity ? [identity] : [],
    contacts: contact ? [contact] : [],
    conversationBindings,
    leadRefBindings,
    traditionalGuWrites: 0,
    redact,
  });
  for (const check of evaluated) {
    record(check.assertion, check.label, check.ok, check.detail);
  }

  const passed = checks.filter((check) => check.ok).length;
  const evidence = {
    slice: "SL-15",
    ranAt,
    productSha,
    verifierSha,
    guOsEnvironment: target.name,
    projectRef: target.projectRef,
    organizationDigest: redact(organizationId),
    caseDigest: redact(caseId),
    leadDigest: redact(gate.legacyLeadId),
    sourceEventDigest: redact(gate.sourceEventId),
    contactDigest: redact(first.contactId),
    conversationBindingDigest: redact(first.conversationBinding.id),
    helper: "backfillAdmittedLegacyLeadIdentity",
    traditionalGuWrites: 0,
    traditionalGuClientsOpened: 0,
    environmentMutations: "none — this procedure never writes Traditional Gu or feature flags",
    checks,
    passed,
    total: checks.length,
  };
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`\nwrote ${jsonPath}`);
  }

  console.log(`\nverify-sl15-identity: ${passed}/${checks.length} passed`);
  if (passed !== checks.length) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(`verify-sl15-identity: ${(error as Error).message}`);
  process.exitCode = 1;
});
