// Hosted verification for governed admission (R1 SL-2, SA-2.1 and SA-2.2).
//
// SL-2's Release Scope is RS-2 hosted: admission "must be exercised against a
// real hosted Gu OS environment with real lead data to mean anything". Two of
// its ten acceptance assertions cannot be produced by a fixture:
//
//   SA-2.1  a REAL inbound lead for the pilot Organization is evaluated by
//           admission and yields a recorded disposition carrying provenance and
//           the effective policy version;
//   SA-2.2  an admitted lead materialises exactly one shadow Lead Opportunity
//           Case, with its admitting facts provenance-bearing.
//
// Everything else is deterministic and lives in
// `npm run test:admission --workspace @agents/web`. The pass/fail logic of the
// hosted assertions is pure and unit-tested in `lib/admission-evidence.ts`.
//
// THIS RUN WRITES — but only what admission itself writes. A real admission is
// supposed to leave durable Gu OS rows behind; that is the evidence. It touches
// `source_events`, `operational_cases`, `case_facts` and
// `operational_case_events`, never Traditional Gu, and reaches no
// prospect-facing effect. `--acknowledge-durable-write` makes that a decision
// rather than a side effect.
//
// IT DOES NOT CONFIGURE THE ENVIRONMENT. The verifier never sets, clears or
// restores a feature flag. Enabling Relationship Operations for an Organization
// is a separate, explicitly human-authorized operation with its own blast
// radius; a run that quietly toggled authority to produce its own evidence
// would be generating the conditions it claims to observe. So the flags are a
// PRECONDITION: read, reported, and fail-closed when unmet.
//
// PRIVACY: the evidence file records shapes, dispositions, provenance and
// policy attribution — never message text, never a phone number, never an
// unredacted identifier. Evidence from a real environment must be safe to
// attach to a PR.
//
// Usage:
//   npx tsx scripts/verify-admission.ts \
//     --env-file .env.staging.local --env staging \
//     --legacy-env stage --organization <uuid> \
//     --owner-user <uuid> --lead-file .lead.local \
//     --acknowledge-durable-write \
//     [--json evidence.json] \
//     [--capture-eval-scenario <path OUTSIDE the repo>]
//
// EVAL CAPTURE: the Slice contract asks for a scenario set drawn from REAL
// recorded lead openings, and this run is the only authorized place a real
// opening is ever read. `--capture-eval-scenario` writes ONE scenario DRAFT to
// the path given, carrying the message the model was actually asked to judge,
// its context and its provenance, with `expected` left BLANK for a human to
// fill in independently. It is a draft, not evidence: the message text is
// prospect content, so the path must be outside the repository, a human reviews
// and redacts it before it ever enters version control, and nothing is captured
// at all unless this flag is passed.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  getActiveMembership,
  getGlobalOperationalCaseTypeBySlug,
  getLatestPublishedDefinitionForUser,
  getOrganizationById,
  getOrganizationFlag,
  getPublishedPolicy,
  getRelationshipAdmissionMode,
  getSourceEventById,
  type DbClient,
} from "@agents/db";
import { closeLegacySourceConnections } from "../apps/web/src/lib/legacy-gateway";
import {
  createDefaultHardBoundProbe,
  createOpenRouterAdmissionInterpreter,
  ingestLegacyLead,
} from "../apps/web/src/lib/relationship-admission";
import {
  admissionSourceRef,
  evaluateHostedAdmissionEvidence,
  type HostedCaseRow,
  type HostedCheck,
  type HostedFactRow,
  type HostedTimelineRow,
} from "./lib/admission-evidence";
import {
  resolveTarget,
  assertBinding,
  describeTarget,
  parseTargetArgs,
  resolveEncryptionKeyForTarget,
} from "./lib/target-env";
import {
  assertProductionReadAcknowledged,
  describeLegacyTarget,
  parseLegacyArgs,
  resolveLegacyTarget,
} from "./lib/legacy-target";

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

/** Stable, non-reversible stand-in so evidence can correlate without exposing. */
function redact(value: string | null): string | null {
  if (!value) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function parseNamed(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return (argv[++i] ?? "").trim() || undefined;
  }
  return undefined;
}

/**
 * Probes that a table exposes the columns this implementation depends on.
 *
 * PostgREST rejects a select naming a column that does not exist, so a
 * successful zero-row read is first-hand proof of shape. It is NOT proof of
 * indexes, constraints or triggers — the API exposes no catalog — which is
 * stated rather than glossed.
 */
async function probeColumns(
  db: DbClient,
  table: string,
  columns: string[]
): Promise<{ ok: boolean; detail: string }> {
  const { error } = await db.from(table).select(columns.join(",")).limit(1);
  if (error) {
    return {
      ok: false,
      detail: `${(error as { message?: string }).message ?? "unreadable"}`,
    };
  }
  return { ok: true, detail: `${columns.length} columns readable` };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetArgs = parseTargetArgs(argv);
  const legacyArgs = parseLegacyArgs(argv);
  const organizationId = parseNamed(argv, "--organization");
  const ownerUserId = parseNamed(argv, "--owner-user");
  // `--lead-file` exists because a legacy lead id embeds three phone numbers.
  // Passing it on a command line puts personal data into shell history.
  const leadFile = parseNamed(argv, "--lead-file");
  const legacyLeadId =
    parseNamed(argv, "--lead") ??
    (leadFile ? readFileSync(leadFile, "utf8").trim() || undefined : undefined);
  const jsonPath = parseNamed(argv, "--json");
  const captureEvalPath = parseNamed(argv, "--capture-eval-scenario");

  if (argv.includes("--activate-flags-for-run")) {
    throw new Error(
      "--activate-flags-for-run has been removed. This verifier does not " +
        "configure the environment: enabling Relationship Operations is a " +
        "separate, explicitly authorized operation, and a run that toggled " +
        "authority to produce its own evidence would be generating the " +
        "conditions it claims to observe. Set the flags first, then re-run."
    );
  }

  if (captureEvalPath) {
    // Real prospect text must not land in the repository by accident.
    const resolved = path.resolve(captureEvalPath);
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      ".."
    );
    if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
      throw new Error(
        "--capture-eval-scenario must point OUTSIDE the repository: the draft " +
          "carries real prospect message text and must be human-reviewed and " +
          "redacted before it is ever committed."
      );
    }
  }

  if (!organizationId) throw new Error("--organization <uuid> is required.");
  if (!ownerUserId) {
    throw new Error(
      "--owner-user <uuid> is required: an admitted Case carries durable " +
        "responsibility for a named advisor, and admission never guesses one."
    );
  }
  if (!legacyLeadId) {
    throw new Error(
      "--lead <legacy lead id> or --lead-file <path> is required: SA-2.1 asks " +
        "for a REAL inbound lead, and there is no hosted evidence without one."
    );
  }
  if (!argv.includes("--acknowledge-durable-write")) {
    throw new Error(
      "--acknowledge-durable-write is required: this run creates durable Gu OS " +
        "rows (source_events, and on admission an Opportunity Case with facts). " +
        "It writes nothing to Traditional Gu and reaches no prospect-facing effect."
    );
  }

  const target = resolveTarget(targetArgs);
  assertBinding(target);
  const legacy = resolveLegacyTarget({
    envFile: legacyArgs.envFile,
    legacyEnv: legacyArgs.legacyEnv,
  });
  assertProductionReadAcknowledged(legacy, legacyArgs.acknowledgeProductionRead);

  console.log(describeTarget(target));
  console.log(describeLegacyTarget(legacy));
  console.log(`organization: ${organizationId}`);
  console.log(`lead: ${redact(legacyLeadId)} (identifier redacted in output)\n`);

  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error(
      "FAIL CLOSED - admission resolves Organization-scoped credentials from a " +
        "service-role-only table and needs GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL."
    );
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "FAIL CLOSED - OPENROUTER_API_KEY is required: the semantic judgment is " +
        "half of what this run exists to evidence, and a stub would prove nothing."
    );
  }
  const db = createClient(
    target.supabaseUrl,
    target.serviceRoleKey
  ) as unknown as DbClient;

  // Admission resolves the legacy credential per Organization out of
  // `organization_tool_secrets` and decrypts it server-side. That decrypt needs
  // the key the DECLARED environment encrypts with — an ambient ENCRYPTION_KEY
  // is deliberately refused, because material encrypted for one environment
  // must never be decryptable with another's key. Same resolution as
  // `verify-legacy-reads.ts`; without it the gateway refuses every read with
  // `no_usable_credential` even though the credential is stored and active.
  process.env.ENCRYPTION_KEY = resolveEncryptionKeyForTarget(
    targetArgs.envFile,
    target.name
  );

  // The gateway's global kill-switch. Admission reaches the source through the
  // SL-1 top-level entry points, which read `process.env` rather than taking an
  // override, so this process must carry what a deployed runtime would.
  // Process-local only: it configures this run, never the hosted environment.
  // The per-call `env` passed into ingestion below covers admission's own gate;
  // this covers the gateway's internal ones, and the two must agree.
  process.env.LEGACY_GATEWAY_ENABLED = "true";

  // ==========================================================================
  // PREFLIGHT — everything that can be established about the Gu OS target,
  // BEFORE consuming separately-authorized Traditional Gu access.
  //
  // Reading a real prospect's records is the expensive, separately authorized
  // part of this run. Discovering only afterwards that the hosted target is
  // missing an SL-2 capability would have spent that access for nothing.
  // ==========================================================================
  console.log("preflight — hosted Gu OS target\n");

  const organization = await getOrganizationById(db, organizationId);
  record(
    "preflight",
    "the Organization resolves in the declared Gu OS environment",
    Boolean(organization),
    organization ? `${organization.name} (${organization.status})` : "not found"
  );

  const membership = await getActiveMembership(db, organizationId, ownerUserId);
  record(
    "preflight",
    "the declared Case owner is an active member",
    Boolean(membership),
    membership ? `role=${membership.role}` : "no active membership"
  );

  // ── Flags are a PRECONDITION. Read, reported, never written.
  const opsFlag = await getOrganizationFlag(db, organizationId, "relationship_ops");
  record(
    "preflight",
    "relationship_ops is enabled for this Organization",
    opsFlag?.enabled === true,
    opsFlag
      ? `enabled=${opsFlag.enabled}`
      : "flag row absent. Required setup: enable relationship_ops for this " +
        "Organization (a separate authorized configuration change), then re-run"
  );

  const modeFlag = await getOrganizationFlag(
    db,
    organizationId,
    "relationship_admission_mode"
  );
  const resolvedMode = await getRelationshipAdmissionMode(db, organizationId);
  record(
    "preflight",
    "relationship_admission_mode resolves to shadow",
    resolvedMode === "shadow",
    modeFlag
      ? `raw enabled=${modeFlag.enabled} value=${modeFlag.value_text ?? "null"} → resolved=${resolvedMode}`
      : `flag row absent → resolver default = ${resolvedMode}` +
        (resolvedMode === "shadow"
          ? " (acceptable; SL-2 ships shadow only)"
          : ". Required setup: set relationship_admission_mode = shadow")
  );

  // ── The SL-2 hosted capabilities this branch depends on.
  const policyProbe = await getPublishedPolicy(
    db,
    organizationId,
    "relationship_admission"
  )
    .then((policy) => ({
      ok: true,
      detail: policy
        ? `published version ${policy.version}`
        : "readable; no published Organization policy (platform baseline will apply)",
    }))
    .catch((error: unknown) => ({
      ok: false,
      detail: `unreadable: ${(error as { message?: string }).message ?? String(error)}`,
    }));
  record(
    "preflight",
    "organization_policies is readable by the service-role path",
    policyProbe.ok,
    policyProbe.detail
  );

  const sourceEventsProbe = await probeColumns(db, "source_events", [
    "id",
    "organization_id",
    "dedup_key",
    "status",
    "claim_epoch",
    "claimed_by",
    "claim_expires_at",
    "decision_jsonb",
    "admitted_case_id",
    "completed_at",
  ]);
  record(
    "preflight",
    "source_events exists with the current processing/fencing shape",
    sourceEventsProbe.ok,
    sourceEventsProbe.detail
  );

  const usageProbe = await probeColumns(db, "ai_usage_events", [
    "id",
    "organization_id",
  ]);
  record(
    "preflight",
    "ai_usage_events supports organization_id correlation",
    usageProbe.ok,
    usageProbe.detail
  );

  const factsProbe = await probeColumns(db, "case_facts", [
    "id",
    "fact_key",
    "source_ref",
    "superseded_by",
  ]);
  record(
    "preflight",
    "case_facts exposes the provenance columns admission evidence uses",
    factsProbe.ok,
    factsProbe.detail
  );

  const caseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    "lead_opportunity"
  );
  record(
    "preflight",
    "the global lead_opportunity Case type is registered",
    Boolean(caseType),
    caseType ? `id=${redact(caseType.id)}` : "not found — the SL-2 migration has not been applied to this target"
  );

  const definition = await getLatestPublishedDefinitionForUser(
    db,
    ownerUserId,
    "lead_opportunity"
  );
  record(
    "preflight",
    "a published lead_opportunity definition resolves for Case pinning",
    Boolean(definition),
    definition ? `version ${definition.version}` : "no published definition"
  );

  // Honest about the ceiling: PostgREST exposes no catalog, so index and
  // constraint presence cannot be established from here.
  console.log(
    "\n  NOTE  This preflight proves table/column shape and configuration " +
      "state only.\n" +
      "        Index, constraint and trigger presence (the dedup, fencing and\n" +
      "        artifact-identity guarantees) are NOT observable through the\n" +
      "        target API. Their hosted evidence is the migration/deployment\n" +
      "        record for this environment, established separately.\n"
  );

  const preflightFailures = checks.filter((check) => !check.ok);
  if (preflightFailures.length > 0) {
    console.log(
      `\npreflight FAILED (${preflightFailures.length} unmet precondition(s)). ` +
        "No Traditional Gu read was performed."
    );
    writeEvidence({ jsonPath, target, legacy, organizationId, legacyLeadId });
    process.exit(1);
  }
  console.log("preflight ok — proceeding to the authorized legacy read\n");

  const evidence: Record<string, unknown> = {};
  let exitCode = 0;

  try {
    const ingested = await ingestLegacyLead({
      ctx: { db, organizationId },
      legacyLeadId,
      ownerUserId,
      interpreter: createOpenRouterAdmissionInterpreter(),
      hardBounds: createDefaultHardBoundProbe({
        isOrganizationAuthorized: async () => true,
      }),
      env: { LEGACY_GATEWAY_ENABLED: "true" },
    });

    if (ingested.result.status === "inert") {
      record(
        "SA-2.1",
        "a real inbound lead is evaluated by admission",
        false,
        `admission was inert: ${ingested.result.reason}. The flags satisfied ` +
          "preflight, so this indicates they changed mid-run"
      );
      exitCode = 1;
    } else if (ingested.result.status === "in_flight") {
      // Another worker owns this event right now. Saying anything about the
      // disposition here would be inventing one.
      record(
        "SA-2.1",
        "a real inbound lead is evaluated by admission",
        false,
        `the event is already being processed by ${ingested.result.claimedBy ?? "another worker"} ` +
          `(lease until ${ingested.result.claimExpiresAt ?? "unknown"}); re-run after it settles`
      );
      exitCode = 1;
    } else {
      const { decision, case_id, source_event_id, deduplicated } =
        ingested.result.outcome;

      record(
        "SA-2.1",
        "a real inbound lead is evaluated and yields a recorded disposition",
        Boolean(source_event_id),
        `disposition=${decision.disposition} reason=${decision.reason}` +
          (deduplicated ? " (already evaluated; original outcome returned)" : "")
      );
      record(
        "SA-2.1",
        "the disposition carries the effective policy version",
        Boolean(decision.policy?.policy_id) &&
          typeof decision.policy?.version === "number",
        `policy=${decision.policy?.policy_id}@${decision.policy?.version} ` +
          `source=${decision.policy?.source}`
      );
      record(
        "SA-2.1",
        "the read carried gateway provenance and freshness",
        Boolean(ingested.provenance.context.freshness?.readAt),
        `store=${ingested.provenance.context.store} ` +
          `binding=${ingested.provenance.context.bindingState} ` +
          `ageSeconds=${ingested.provenance.context.freshness?.ageSeconds ?? "unknown"}`
      );

      // ── Read back what the hosted target actually holds, and evaluate it.
      const hostedChecks = await collectAndEvaluate({
        db,
        organizationId,
        ownerUserId,
        sourceEventId: source_event_id,
        returnedCaseId: case_id,
        decision,
      });
      for (const check of hostedChecks) {
        record(check.assertion, check.label, check.ok, check.detail);
      }

      if (captureEvalPath) {
        // A DRAFT, deliberately incomplete: `expected` is blank because the
        // point of the artifact is a human judgment about what the right answer
        // is, not a recording of what the model happened to say.
        writeFileSync(
          captureEvalPath,
          JSON.stringify(
            {
              _README: [
                "EVAL SCENARIO DRAFT — NOT evidence, and NOT safe to commit as-is.",
                "`input.message` and `input.priorMessages` are REAL prospect text.",
                "Review, redact or paraphrase, decide `expected` INDEPENDENTLY",
                "(do not copy `modelSaid` — that would make the eval grade the",
                "model against itself), then add it to",
                "apps/web/src/lib/relationship-admission/eval/admission-scenarios.json.",
              ],
              id: `real-${redact(legacyLeadId)?.slice(7, 19)}`,
              label: "(describe the opening)",
              capturedAt: new Date().toISOString(),
              provenance: {
                guOsEnvironment: target.name,
                legacyEnvironment: legacy.environment,
                organizationDigest: redact(organizationId),
                leadDigest: redact(legacyLeadId),
                capability: ingested.provenance.messages.capability,
                sourceUpdatedAt:
                  ingested.provenance.messages.freshness?.sourceUpdatedAt ?? null,
              },
              input: ingested.interpreterInput,
              expected: {
                has_actionable_objective: null,
                objective_category: null,
              },
              modelSaid: {
                has_actionable_objective:
                  decision.proposal?.has_actionable_objective ?? null,
                objective_category: decision.proposal?.objective_category ?? null,
                confidence: decision.proposal?.confidence ?? null,
              },
            },
            null,
            2
          ),
          "utf8"
        );
        console.log(
          `  NOTE  eval scenario DRAFT written to ${captureEvalPath} — review and redact before committing`
        );
      }

      evidence.outcome = {
        disposition: decision.disposition,
        reason: decision.reason,
        hardBound: decision.hard_bound,
        policy: decision.policy,
        deduplicated,
        caseDigest: redact(case_id),
        sourceEventDigest: redact(source_event_id),
        hadInboundMessage: ingested.hadInboundMessage,
        // Confidence band only — never the model's rationale text, which can
        // quote the prospect.
        proposalConfidence: decision.proposal?.confidence ?? null,
        proposalHadObjective:
          decision.proposal?.has_actionable_objective ?? null,
        proposalCategory: decision.proposal?.objective_category ?? null,
      };
      evidence.provenance = {
        context: {
          store: ingested.provenance.context.store,
          adapter: ingested.provenance.context.adapter,
          capability: ingested.provenance.context.capability,
          bindingState: ingested.provenance.context.bindingState,
          freshness: ingested.provenance.context.freshness,
        },
        messages: {
          store: ingested.provenance.messages.store,
          adapter: ingested.provenance.messages.adapter,
          capability: ingested.provenance.messages.capability,
          bindingState: ingested.provenance.messages.bindingState,
          freshness: ingested.provenance.messages.freshness,
        },
      };
    }
  } catch (error) {
    record(
      "SA-2.1",
      "a real inbound lead is evaluated by admission",
      false,
      error instanceof Error ? error.message : String(error)
    );
    exitCode = 1;
  } finally {
    await closeLegacySourceConnections();
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed`
  );

  writeEvidence({
    jsonPath,
    target,
    legacy,
    organizationId,
    legacyLeadId,
    extra: evidence,
  });

  process.exit(failed.length > 0 ? 1 : exitCode);
}

/** Reads back the hosted rows this outcome should have produced. */
async function collectAndEvaluate(params: {
  db: DbClient;
  organizationId: string;
  ownerUserId: string;
  sourceEventId: string | null;
  returnedCaseId: string | null;
  decision: {
    disposition: string;
    reason: string;
    policy?: { policy_id?: string; version?: number; source?: string } | null;
    proposal?: { objective?: string | null } | null;
  };
}): Promise<HostedCheck[]> {
  const { db, organizationId, sourceEventId } = params;
  if (!sourceEventId) {
    return [
      {
        assertion: "SA-2.1",
        label: "the outcome names a source event to verify against",
        ok: false,
        detail: "no source_event_id was returned",
      },
    ];
  }

  const sourceEvent = await getSourceEventById(db, organizationId, sourceEventId);

  // Every Case in this Organization whose context names this source event —
  // the identity the implementation uses, so "exactly one" is countable.
  const { data: caseData, error: caseError } = await db
    .from("operational_cases")
    .select(
      "id, case_type, organization_id, runtime_authority, current_step, next_action_at, context_jsonb"
    )
    .eq("organization_id", organizationId)
    .eq("context_jsonb->>source_event_id", sourceEventId);
  if (caseError) throw caseError;
  const matchingCases = (caseData ?? []) as HostedCaseRow[];

  const caseId = params.returnedCaseId ?? matchingCases[0]?.id ?? null;

  let caseFacts: HostedFactRow[] = [];
  let timeline: HostedTimelineRow[] = [];
  if (caseId) {
    const { data: factData, error: factError } = await db
      .from("case_facts")
      .select("fact_key, source_ref, value_jsonb, superseded_by")
      .eq("case_id", caseId)
      .is("superseded_by", null);
    if (factError) throw factError;
    caseFacts = (factData ?? []) as HostedFactRow[];

    const { data: eventData, error: eventError } = await db
      .from("operational_case_events")
      .select("payload_jsonb")
      .eq("case_id", caseId);
    if (eventError) throw eventError;
    timeline = (eventData ?? []) as HostedTimelineRow[];
  }

  return evaluateHostedAdmissionEvidence({
    organizationId,
    sourceEventId,
    decision: params.decision,
    returnedCaseId: params.returnedCaseId,
    matchingCases,
    sourceEvent: sourceEvent
      ? {
          status: sourceEvent.status,
          decision_jsonb: sourceEvent.decision_jsonb,
          admitted_case_id: sourceEvent.admitted_case_id,
        }
      : null,
    caseFacts,
    timeline,
    redact,
  });
}

function writeEvidence(params: {
  jsonPath: string | undefined;
  target: { name: string };
  legacy: { environment: string };
  organizationId: string;
  legacyLeadId: string;
  extra?: Record<string, unknown>;
}): void {
  if (!params.jsonPath) return;
  writeFileSync(
    params.jsonPath,
    JSON.stringify(
      {
        slice: "SL-2",
        ranAt: new Date().toISOString(),
        guOsEnvironment: params.target.name,
        legacyEnvironment: params.legacy.environment,
        organizationDigest: redact(params.organizationId),
        leadDigest: redact(params.legacyLeadId),
        // Stated in the artifact itself so a reader is never left inferring it.
        environmentMutations:
          "none — this verifier reads configuration and never writes it",
        indexAndConstraintEvidence:
          "not observable through the target API; established by the " +
          "migration/deployment record for this environment",
        provenanceIdentity: admissionSourceRef("<source_event_id>"),
        checks,
        ...(params.extra ?? {}),
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`evidence written to ${params.jsonPath}`);
}

main().catch(async (error) => {
  console.error(error);
  await closeLegacySourceConnections().catch(() => undefined);
  process.exit(1);
});
