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
// `npm run test:admission --workspace @agents/web`.
//
// THIS RUN WRITES. Unlike `verify-legacy-reads.ts`, which is read-only, a real
// admission evaluation is supposed to leave durable Gu OS rows behind — that is
// the evidence. It writes ONLY Gu OS rows (source_events, operational_cases,
// case_facts, operational_case_events); it never writes to Traditional Gu and
// reaches no prospect-facing effect. `--acknowledge-durable-write` is required
// so that is a decision rather than a side effect.
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
//     [--activate-flags-for-run] [--json evidence.json] \
//     [--capture-eval-scenario <path OUTSIDE the repo>]
//
// EVAL CAPTURE: the Slice contract asks for a scenario set drawn from REAL
// recorded lead openings, and this run is the only authorized place a real
// opening is ever read. `--capture-eval-scenario` writes ONE scenario DRAFT to
// the path given, carrying the message the model was actually asked to judge,
// its context and its provenance, with `expected` left BLANK for a human to
// fill in. It is a draft, not evidence: the message text is prospect content,
// so the path must be outside the repository, a human reviews and redacts it
// before it ever enters version control, and nothing is captured at all unless
// this flag is passed.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  deleteOrganizationFlag,
  getActiveMembership,
  getOrganizationById,
  getOrganizationFlag,
  listCaseFacts,
  setOrganizationFlag,
  type DbClient,
} from "@agents/db";
import { closeLegacySourceConnections } from "../apps/web/src/lib/legacy-gateway";
import {
  createDefaultHardBoundProbe,
  createOpenRouterAdmissionInterpreter,
  ingestLegacyLead,
} from "../apps/web/src/lib/relationship-admission";
import {
  resolveTarget,
  assertBinding,
  describeTarget,
  parseTargetArgs,
} from "./lib/target-env";
import {
  assertProductionReadAcknowledged,
  describeLegacyTarget,
  parseLegacyArgs,
  resolveLegacyTarget,
} from "./lib/legacy-target";

interface Check {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
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

/** Flags this run may activate, each restored to exactly what it found. */
const RUN_FLAGS = [
  { key: "relationship_ops", enabled: true, value: null as string | null },
  { key: "relationship_admission_mode", enabled: true, value: "shadow" },
] as const;

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
  const activateFlags = argv.includes("--activate-flags-for-run");

  if (captureEvalPath) {
    // Real prospect text must not land in the repository by accident.
    const resolved = path.resolve(captureEvalPath);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

  const organization = await getOrganizationById(db, organizationId);
  record(
    "setup",
    "Organization resolves in the declared Gu OS environment",
    Boolean(organization),
    organization ? `${organization.name} (${organization.status})` : "not found"
  );
  if (!organization) process.exit(1);

  const membership = await getActiveMembership(db, organizationId, ownerUserId);
  record(
    "setup",
    "the declared Case owner is an active member",
    Boolean(membership),
    membership ? `role=${membership.role}` : "no active membership"
  );
  if (!membership) process.exit(1);

  // Bounded activation, restored on every exit path — including a crash. A
  // bounded activation that only unwinds on the happy path is not bounded.
  const priorFlags = new Map<
    string,
    { present: boolean; enabled: boolean; value: string | null }
  >();
  let restoreNeeded = false;

  const restoreFlags = async (): Promise<string[]> => {
    if (!restoreNeeded) return ["not touched by this run"];
    const notes: string[] = [];
    for (const flag of RUN_FLAGS) {
      const prior = priorFlags.get(flag.key);
      if (!prior) continue;
      if (!prior.present) {
        await deleteOrganizationFlag(db, { organizationId, flagKey: flag.key });
        notes.push(`${flag.key}: row removed - restored to absent, as found`);
      } else {
        await setOrganizationFlag(db, {
          organizationId,
          flagKey: flag.key,
          enabled: prior.enabled,
          valueText: prior.value,
        });
        notes.push(`${flag.key}: restored to enabled=${prior.enabled}`);
      }
    }
    return notes;
  };

  if (activateFlags) {
    for (const flag of RUN_FLAGS) {
      const existing = await getOrganizationFlag(db, organizationId, flag.key);
      priorFlags.set(flag.key, {
        present: Boolean(existing),
        enabled: existing?.enabled === true,
        value: existing?.value_text ?? null,
      });
      await setOrganizationFlag(db, {
        organizationId,
        flagKey: flag.key,
        enabled: flag.enabled,
        valueText: flag.value,
      });
      restoreNeeded = true;
    }
    console.log("  NOTE  admission flags activated for this run only\n");
  }

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
        `admission was inert: ${ingested.result.reason} (re-run with --activate-flags-for-run)`
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

      if (decision.disposition === "admitted") {
        const facts = case_id
          ? await listCaseFacts(db, ownerUserId, case_id)
          : [];
        const provenanced = facts.filter(
          (fact) => typeof fact.source_ref === "string" && fact.source_ref
        );
        record(
          "SA-2.2",
          "an admitted lead materialises exactly one Opportunity Case",
          Boolean(case_id),
          case_id ? `case=${redact(case_id)}` : "no Case created"
        );
        record(
          "SA-2.2",
          "every admitting fact carries provenance",
          facts.length > 0 && provenanced.length === facts.length,
          `${provenanced.length}/${facts.length} facts carry source_ref`
        );
      } else {
        record(
          "SA-2.2",
          "an unadmitted lead leaves no Opportunity Case",
          case_id === null,
          `disposition=${decision.disposition}; SA-2.2 needs an ADMITTED lead, ` +
            "so re-run against a lead the policy admits to complete it"
        );
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
                "Review, redact or paraphrase, fill in `expected`, then add it to",
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
    const notes = await restoreFlags();
    for (const note of notes) console.log(`  NOTE  ${note}`);
    evidence.flagRestore = notes;
    await closeLegacySourceConnections();
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed`
  );

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          slice: "SL-2",
          ranAt: new Date().toISOString(),
          guOsEnvironment: target.name,
          legacyEnvironment: legacy.environment,
          organizationDigest: redact(organizationId),
          leadDigest: redact(legacyLeadId),
          checks,
          ...evidence,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`evidence written to ${jsonPath}`);
  }

  process.exit(failed.length > 0 ? 1 : exitCode);
}

main().catch(async (error) => {
  console.error(error);
  await closeLegacySourceConnections().catch(() => undefined);
  process.exit(1);
});
