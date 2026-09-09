// Hosted verification for the Case Supervisor loop (R1 SL-4).
//
// SL-4's Release Scope is RS-2 hosted, and its Definition of Done owes one item
// no fixture can produce:
//
//   RS-2 hosted evidence of a MULTI-DAY posture history on shadow Opportunities.
//
// SA-4.3 spells out what that means: across multiple days, an Opportunity's
// posture history is coherent and ordered — successive reconsiderations
// attributable, non-contradictory, and explicable from the evidence available
// at each point. SA-4.2's hosted half and SA-4.5's replay ride along with it.
// Everything else in the Slice contract is deterministic and lives in
// `npm run test:supervisor`; the pass/fail logic of the hosted assertions is
// pure and unit-tested in `lib/supervisor-evidence.ts`.
//
// WHY THIS SCRIPT HAS PHASES, AND WHY THAT IS THE WHOLE POINT
//
// "Multi-day" is the one assertion a verifier could most easily fake. A single
// script that seeded three Cases, ran three reconsiderations and stamped them a
// day apart would produce a passing artifact describing something that never
// happened. So elapsed time is not simulated here at all:
//
//   --phase seed    once, day 1. Creates the controlled shadow Opportunities.
//   --phase wake    once per day. One reconsideration per Case, keyed on the
//                   UTC date, so running it twice in a day COALESCES (SA-4.6)
//                   rather than manufacturing a second day.
//   --phase verify  at the end. Reads back, replays, evaluates, writes evidence.
//
// The day count in the evidence comes from `operational_case_events.created_at`
// — the database's clock, never this process's — and a run whose
// reconsiderations share a day fails rather than passing with a caveat. The
// evaluator also checks the ELAPSED SPAN, because distinct UTC days are not
// sufficient on their own: this operator is at UTC-6, so 17:59 and 18:01 local
// are two different UTC days four minutes apart, and a pure day count would
// call that multi-day.
//
// WHY THE SCENARIOS ARE CONTROLLED
//
// The same reasoning SL-3 recorded. A real pilot Opportunity that happens to
// sit quiet for three days cannot be summoned, and waiting for one would mean
// widening reads over Traditional Gu production for no evidentiary gain: the
// prospect's actual words are not what the hosted layer proves. What only a
// hosted run can establish is the mechanics against real PostgreSQL — the
// M-WAKE-IDENTITY index under a genuine redelivery, the composite-FK
// containment of subject facts, `case_facts` supersession per subject, and a
// posture history that really does span days. So this verifier reaches NO
// source system: no Traditional Gu target, no legacy credential, zero legacy
// reads and zero legacy writes.
//
// THIS RUN WRITES — deliberately, and only what SL-4 itself writes. Controlled
// shadow Opportunity Cases for the pilot Organization, their facts, the
// reconsideration timeline, commitment subjects and `agent_proposed` Work. That
// IS the evidence: a supervisor that left nothing behind would prove nothing.
// The Cases are stamped `context_jsonb.scenario_kind = 'sl4_controlled'` so
// nothing downstream can mistake them for admitted pilot leads.
//
// IT DOES NOT CONFIGURE THE ENVIRONMENT. It never sets, clears or restores a
// feature flag. `relationship_ops` and the shadow mode are PRECONDITIONS: read,
// reported, and fail-closed when unmet. A run that quietly toggled authority to
// produce its own evidence would be generating the conditions it claims to
// observe.
//
// PRIVACY: scenario content is wholly synthetic — no prospect, message, contact,
// property or legacy identifier is read or reproduced. Row identifiers are
// digested, never literal, so the evidence file is safe to attach to a PR.
//
// Usage:
//   npx tsx scripts/verify-supervisor.ts --phase seed \
//     --env-file .env.staging.local --env staging \
//     --organization <uuid> --owner-user <uuid> --run <label> \
//     --acknowledge-durable-write
//   npx tsx scripts/verify-supervisor.ts --phase wake   … (once per day)
//   npx tsx scripts/verify-supervisor.ts --phase verify … [--json evidence.json]

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  createOperationalCase,
  getActiveMembership,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCase,
  getOrganizationById,
  getOrganizationFlag,
  getLatestPublishedDefinitionForUser,
  insertCaseFact,
  type DbClient,
} from "@agents/db";
import {
  buildWakeKey,
  createOpenRouterNextWorkJudge,
  reconstructSituation,
  runSupervisorWake,
  summarizePostureDistribution,
  type NextWorkJudge,
} from "../apps/web/src/lib/relationship-supervisor";
import {
  allPassed,
  evaluateHostedSupervisorEvidence,
  type HostedCheck,
  type HostedSupervisorInputs,
} from "./lib/supervisor-evidence";
import {
  assertBinding,
  describeTarget,
  parseTargetArgs,
  resolveTarget,
} from "./lib/target-env";

const LEAD_OPPORTUNITY_CASE_TYPE = "lead_opportunity";
/** Stamped on every Case this verifier creates, so it is never mistaken for a lead. */
const SCENARIO_KIND = "sl4_controlled";
/** SA-4.3's "multiple days" as this run reads it: three is the smallest honest one. */
export const REQUIRED_DISTINCT_DAYS = 3;

const preflight: HostedCheck[] = [];

function recordPreflight(label: string, ok: boolean, detail?: string): void {
  preflight.push({ assertion: "preflight", label, ok, detail });
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  [preflight] ${label}${detail ? ` - ${detail}` : ""}`
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

// ============================================================================
// Controlled scenario content — wholly synthetic.
//
// Two Opportunities, because one posture repeated is a weaker history than two
// Cases that legitimately differ. Neither situation changes between days: that
// is deliberate and it is what makes coherence checkable — a stable situation
// SHOULD produce a stable, non-contradictory posture sequence, and a supervisor
// that oscillated across identical days would be exhibiting exactly the posture
// drift the Slice's risk table names.
// ============================================================================

interface ScenarioSeed {
  id: string;
  title: string;
  governing: string;
  objective: { objective: string; category: string };
  /** Recent conversation, oldest first. Supplied per wake; never read anywhere. */
  recentMessages: string[];
  availableCapabilities: string[];
}

export const SCENARIOS: ScenarioSeed[] = [
  {
    id: "quiescent-opportunity",
    title:
      "A viable Opportunity with nothing new — reconsidered daily, expected to stay quiet (AC-01, EC-01, EC-20)",
    governing: "S2 §8.1 invariant 8, §8.19, AC-01, EC-01, EC-20, EC-40; SA-4.1, SA-4.3",
    objective: {
      objective: "comprar casa de 3 recamaras en zona norte, presupuesto 4.5M",
      category: "buy_residential",
    },
    recentMessages: [
      "Prospecto: busco casa de 3 recamaras por el norte",
      "Asesor: perfecto, te comparto opciones en cuanto tenga algo que valga la pena",
      "Prospecto: va, quedo atento",
    ],
    availableCapabilities: ["read_case_facts", "read_recent_messages"],
  },
  {
    id: "commitment-bearing-opportunity",
    title:
      "An Opportunity carrying an advisor commitment — tracked as a Subject and carried across days (S2 §8.13, §8.15)",
    governing: "S2 §8.13, §8.14, §8.15; TD-14; SA-4.4, SA-4.3",
    objective: {
      objective: "comparar dos casas en el sur antes de decidir",
      category: "buy_residential",
    },
    recentMessages: [
      "Prospecto: me puedes comparar las dos casas que vimos?",
      "Asesor: si, te mando la comparacion el viernes",
    ],
    availableCapabilities: [
      "read_case_facts",
      "read_recent_messages",
      "prepare_comparison",
    ],
  },
];

// ============================================================================
// Phases
// ============================================================================

export interface RunContext {
  db: DbClient;
  organizationId: string;
  ownerUserId: string;
  runLabel: string;
}

async function findRunCases(
  ctx: RunContext
): Promise<Array<{ id: string; scenario: string }>> {
  const { data, error } = await ctx.db
    .from("operational_cases")
    .select("id, context_jsonb")
    .eq("organization_id", ctx.organizationId)
    .eq("context_jsonb->>sl4_run", ctx.runLabel)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; context_jsonb: Record<string, unknown> }>).map(
    (row) => ({
      id: row.id,
      scenario: String(row.context_jsonb?.scenario_id ?? "unknown"),
    })
  );
}

export async function phaseSeed(
  ctx: RunContext,
  caseTypeId: string,
  definitionId: string,
  definitionVersion: number
): Promise<void> {
  const existing = await findRunCases(ctx);
  if (existing.length > 0) {
    // Seeding twice would create a second, parallel history under one run label
    // and quietly halve the day span of each. Refuse rather than "help".
    throw new Error(
      `run label "${ctx.runLabel}" already has ${existing.length} controlled Case(s). ` +
        "Seed once per run; use --phase wake from here, or choose a new --run label."
    );
  }

  for (const scenario of SCENARIOS) {
    const opCase = await createOperationalCase(ctx.db, {
      userId: ctx.ownerUserId,
      caseType: LEAD_OPPORTUNITY_CASE_TYPE,
      caseTypeId,
      organizationId: ctx.organizationId,
      context: {
        scenario_kind: SCENARIO_KIND,
        scenario_id: scenario.id,
        sl4_run: ctx.runLabel,
        // Carried on the Case rather than only in this file, so a reader of the
        // hosted rows can see which contract clause the scenario exists for.
        title: scenario.title,
        governing: scenario.governing,
      },
      workflowDefinition: { id: definitionId, version: definitionVersion },
    });

    await insertCaseFact(ctx.db, {
      userId: ctx.ownerUserId,
      caseId: opCase.id,
      factKey: "opportunity.objective",
      value: scenario.objective,
      sourceKind: "derived",
      sourceRef: `sl4_verifier:${ctx.runLabel}`,
    });
    await insertCaseFact(ctx.db, {
      userId: ctx.ownerUserId,
      caseId: opCase.id,
      factKey: "opportunity.viability",
      value: { viability: "viable" },
      sourceKind: "derived",
      sourceRef: `sl4_verifier:${ctx.runLabel}`,
    });

    console.log(`  seeded  ${scenario.id} -> ${redact(opCase.id)}`);
  }
  console.log(
    `\nSeeded ${SCENARIOS.length} controlled Opportunities for run "${ctx.runLabel}".` +
      `\nRun --phase wake once per day for at least ${REQUIRED_DISTINCT_DAYS} distinct UTC days,` +
      `\nthen --phase verify.`
  );
}

export async function phaseWake(
  ctx: RunContext,
  judgeOverride?: NextWorkJudge
): Promise<void> {
  const cases = await findRunCases(ctx);
  if (cases.length === 0) {
    throw new Error(`no controlled Cases for run "${ctx.runLabel}" — seed first.`);
  }

  // The wake key is the UTC DATE, not the instant. That makes a second run on
  // the same day a genuine redelivery of the same logical wake, which SA-4.6
  // coalesces — and it makes it impossible for repeated runs to inflate the day
  // span the evidence reports.
  const today = new Date().toISOString().slice(0, 10);
  // Injectable so the phase I/O can be exercised without a model or a hosted
  // environment. Production always takes the default.
  const judge = judgeOverride ?? createOpenRouterNextWorkJudge();

  for (const entry of cases) {
    const scenario = SCENARIOS.find((s) => s.id === entry.scenario);
    const result = await runSupervisorWake({
      db: ctx.db,
      organizationId: ctx.organizationId,
      userId: ctx.ownerUserId,
      caseId: entry.id,
      wake: {
        reason: "scheduled_reconsideration",
        key: buildWakeKey.scheduled(today),
      },
      judge,
      recentMessages: scenario?.recentMessages ?? [],
      availableCapabilities: scenario?.availableCapabilities ?? [],
    });

    if (result.status === "reconsidered") {
      console.log(
        `  woke    ${entry.scenario} -> ${result.record.posture} / ${result.record.yield_posture}` +
          `${result.record.uncertainty ? ` (${result.record.uncertainty})` : ""}`
      );
      console.log(`          rationale: ${result.record.rationale}`);
    } else if (result.status === "already_reconsidered") {
      console.log(
        `  coalesced ${entry.scenario} -> already reconsidered for ${today}` +
          ` (SA-4.6; nothing durable created)`
      );
    } else if (result.status === "refused" && result.reason === "case_busy") {
      // Reported as the observable fact rather than as a guess. The kernel uses
      // one column for the lease and for the next scheduled reconsideration, so
      // "a worker holds it" and "it is not due yet" are indistinguishable from
      // the row — and the honest thing is to say how far out the wake sits and
      // let the operator read it, not to pick one and sound certain.
      const row = await getOperationalCase(ctx.db, entry.id);
      const dueAt = row?.next_action_at ?? null;
      const hours = dueAt
        ? ((new Date(dueAt).getTime() - Date.now()) / 3_600_000).toFixed(1)
        : null;
      console.log(
        `  skipped ${entry.scenario} -> lease not taken; next_action_at=${dueAt ?? "null"}` +
          (hours ? ` (${hours}h out)` : "") +
          " — either a worker holds it or its own reconsideration is not due yet; nothing was written"
      );
    } else {
      console.log(`  ${result.status.toUpperCase()}  ${entry.scenario} -> ${result.reason}`);
    }
  }
}

export async function phaseVerify(
  ctx: RunContext,
  jsonPath: string | undefined
): Promise<boolean> {
  const cases = await findRunCases(ctx);
  if (cases.length === 0) {
    throw new Error(`no controlled Cases for run "${ctx.runLabel}" — nothing to verify.`);
  }
  const caseIds = cases.map((c) => c.id);

  const caseRows = [];
  for (const id of caseIds) {
    const row = await getOperationalCase(ctx.db, id);
    if (row) {
      caseRows.push({
        id: row.id,
        organization_id: row.organization_id ?? null,
        case_type: row.case_type,
        status: row.status,
        next_action_at: row.next_action_at ?? null,
        runtime_authority:
          (row as unknown as { runtime_authority?: string | null }).runtime_authority ??
          null,
      });
    }
  }

  const reconsiderations: HostedSupervisorInputs["reconsiderations"] = [];
  const settlements: HostedSupervisorInputs["settlements"] = [];
  const { data: events, error: eventsError } = await ctx.db
    .from("operational_case_events")
    .select("case_id, created_at, payload_jsonb")
    .in("case_id", caseIds)
    .order("created_at", { ascending: true });
  if (eventsError) throw eventsError;
  for (const row of (events ?? []) as Array<{
    case_id: string;
    created_at: string;
    payload_jsonb: Record<string, unknown>;
  }>) {
    const kind = row.payload_jsonb?.kind;
    if (kind === "supervisor_reconsidered") {
      (reconsiderations as unknown[]).push({
        created_at: row.created_at,
        case_id: row.case_id,
        payload: row.payload_jsonb,
      });
    } else if (kind === "supervisor_reconsideration_settled") {
      (settlements as unknown[]).push({
        created_at: row.created_at,
        case_id: row.case_id,
        payload: row.payload_jsonb,
      });
    }
  }

  const { data: subjectRows, error: subjectsError } = await ctx.db
    .from("case_subjects")
    .select("id, case_id, subject_kind, attrs_jsonb")
    .in("case_id", caseIds);
  if (subjectsError) throw subjectsError;

  const { data: factRows, error: factsError } = await ctx.db
    .from("case_facts")
    .select("id, case_id, fact_key, subject_id, superseded_by, value_jsonb")
    .in("case_id", caseIds);
  if (factsError) throw factsError;

  const { data: workRows, error: workError } = await ctx.db
    .from("work_items")
    .select("id, case_id, work_type, origin, status")
    .in("case_id", caseIds);
  if (workError) throw workError;

  // SA-4.5 — reconstruct with a fresh reader that has seen none of the above.
  const replayCaseId = caseIds[0];
  const situation = await reconstructSituation({
    db: ctx.db,
    userId: ctx.ownerUserId,
    caseId: replayCaseId,
  });

  const observability = await summarizePostureDistribution({
    db: ctx.db,
    organizationId: ctx.organizationId,
  });

  const inputs: HostedSupervisorInputs = {
    organizationId: ctx.organizationId,
    requiredDistinctDays: REQUIRED_DISTINCT_DAYS,
    cases: caseRows,
    reconsiderations,
    settlements,
    subjects: (subjectRows ?? []) as HostedSupervisorInputs["subjects"],
    facts: (factRows ?? []) as HostedSupervisorInputs["facts"],
    work: (workRows ?? []) as HostedSupervisorInputs["work"],
    replay: situation
      ? {
          caseId: replayCaseId,
          objective: situation.objective,
          commitmentCount: situation.commitments.length,
          postureCount: situation.postureHistory.length,
          waitingOn: situation.waitingOn,
          nextWakeAt: situation.nextWakeAt,
        }
      : null,
    observability: {
      total: observability.total,
      noAction: observability.noAction,
      noActionRatio: observability.noActionRatio,
      distinctDays: observability.distinctDays,
    },
  };

  const checks = evaluateHostedSupervisorEvidence(inputs);
  console.log("");
  for (const c of checks) {
    console.log(
      `  ${c.ok ? "PASS" : "FAIL"}  [${c.assertion}] ${c.label}${
        c.detail ? ` - ${c.detail}` : ""
      }`
    );
  }

  const ok = allPassed(preflight) && allPassed(checks);

  if (jsonPath) {
    // Digests, outcomes and rationales only — never a raw identifier, and the
    // scenario content is synthetic to begin with.
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          slice: "SL-4",
          run: ctx.runLabel,
          organization: redact(ctx.organizationId),
          requiredDistinctDays: REQUIRED_DISTINCT_DAYS,
          model:
            process.env.RELATIONSHIP_SUPERVISOR_MODEL_ID?.trim() ??
            "default (configuration)",
          legacySourceReads: 0,
          legacySourceWrites: 0,
          preflight,
          checks,
          passed: ok,
          cases: caseRows.map((c) => ({
            id: redact(c.id),
            scenario: cases.find((x) => x.id === c.id)?.scenario ?? null,
            status: c.status,
            runtimeAuthority: c.runtime_authority,
          })),
          postureHistory: reconsiderations.map((r) => ({
            case: redact(r.case_id),
            recordedAt: r.created_at,
            wakeReason: r.payload.wake_reason ?? null,
            posture: r.payload.posture ?? null,
            yieldPosture:
              settlements.find((s) => s.payload.wake_key === r.payload.wake_key)
                ?.payload.yield_posture ?? null,
            uncertainty: r.payload.uncertainty ?? null,
            rationale: r.payload.rationale ?? null,
            nextActionAt: r.payload.next_action_at ?? null,
          })),
          commitments: (subjectRows ?? []).map((s: Record<string, unknown>) => ({
            id: redact(String(s.id)),
            case: redact(String(s.case_id)),
            kind: s.subject_kind,
            key: (s.attrs_jsonb as Record<string, unknown>)?.commitment_key ?? null,
          })),
          work: (workRows ?? []).map((w: Record<string, unknown>) => ({
            id: redact(String(w.id)),
            workType: w.work_type,
            origin: w.origin,
            status: w.status,
          })),
          observability: {
            total: observability.total,
            noAction: observability.noAction,
            // Reported, never judged: SA-4.9 contracts observability and no
            // governing artifact approves a target ratio.
            noActionRatio: observability.noActionRatio,
            byPosture: observability.byPosture,
            distinctDays: observability.distinctDays,
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(`\nartifact: ${jsonPath}`);
  }

  return ok;
}

// ============================================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetArgs = parseTargetArgs(argv);
  const phase = parseNamed(argv, "--phase");
  const organizationId = parseNamed(argv, "--organization");
  const ownerUserId = parseNamed(argv, "--owner-user");
  const runLabel = parseNamed(argv, "--run");
  const jsonPath = parseNamed(argv, "--json");

  if (argv.includes("--activate-flags-for-run")) {
    throw new Error(
      "--activate-flags-for-run is not supported. This verifier does not " +
        "configure the environment: enabling Relationship Operations is a " +
        "separate, explicitly authorized operation, and a run that toggled " +
        "authority to produce its own evidence would be generating the " +
        "conditions it claims to observe. Set the flag first, then re-run."
    );
  }
  if (phase !== "seed" && phase !== "wake" && phase !== "verify") {
    throw new Error("--phase <seed|wake|verify> is required.");
  }
  if (!organizationId) throw new Error("--organization <uuid> is required.");
  if (!ownerUserId) {
    throw new Error(
      "--owner-user <uuid> is required: an Opportunity carries durable " +
        "responsibility for a named advisor, and every `case_facts` write in " +
        "this repo is user-scoped."
    );
  }
  if (!runLabel) {
    throw new Error(
      "--run <label> is required: it ties the seed, the daily wakes and the " +
        "verification together across days, and keeps two evidence runs from " +
        "merging into one history."
    );
  }
  if (phase !== "verify" && !argv.includes("--acknowledge-durable-write")) {
    throw new Error(
      "--acknowledge-durable-write is required: this run creates durable Gu OS " +
        "rows (controlled shadow Opportunity Cases, their facts, the " +
        "reconsideration timeline, commitment subjects and agent_proposed " +
        "Work). It reaches no source system and no prospect-facing effect."
    );
  }

  const target = resolveTarget(targetArgs);
  assertBinding(target);
  console.log(describeTarget(target));
  console.log(`organization: ${organizationId}`);
  console.log(`run:          ${runLabel}`);
  console.log(`phase:        ${phase}`);
  console.log("legacy source: NOT REACHED — this Slice's evidence needs no source read\n");

  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error(
      "FAIL CLOSED - the supervisor writes Organization-scoped Cases, facts, " +
        "subjects and Work and needs GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL."
    );
  }
  if (phase === "wake" && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "FAIL CLOSED - OPENROUTER_API_KEY is required for --phase wake: the " +
        "posture history this Slice must evidence is the product of real " +
        "situational judgment, and a run with a stubbed judge would evidence " +
        "the executor only."
    );
  }

  const db = createClient(
    target.supabaseUrl,
    target.serviceRoleKey
  ) as unknown as DbClient;

  // ==========================================================================
  // PREFLIGHT — everything that must hold before a durable write.
  // ==========================================================================
  console.log("preflight — hosted Gu OS target\n");

  const organization = await getOrganizationById(db, organizationId);
  recordPreflight(
    "the Organization resolves in the declared Gu OS environment",
    Boolean(organization),
    organization ? `${organization.name} (${organization.status})` : "not found"
  );

  const membership = await getActiveMembership(db, organizationId, ownerUserId);
  recordPreflight(
    "the declared Case owner is an active member",
    Boolean(membership),
    membership ? `role=${membership.role}` : "no active membership"
  );

  // ── The flags are PRECONDITIONS. Read, reported, never written.
  const opsFlag = await getOrganizationFlag(db, organizationId, "relationship_ops");
  recordPreflight(
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
  recordPreflight(
    "the Organization is in the shadow stage",
    modeFlag?.enabled === true && modeFlag.value_text === "shadow",
    modeFlag ? `value=${modeFlag.value_text ?? "null"}` : "flag row absent"
  );

  const caseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    LEAD_OPPORTUNITY_CASE_TYPE
  );
  recordPreflight(
    "the global lead_opportunity Case type is registered",
    Boolean(caseType),
    caseType ? `skill=${caseType.default_skill_slug}` : "not found"
  );

  // The supervisor's root skill is bound through the case type, and SL-2 seeded
  // that binding before the skill existed. Verifying it resolves is the cheap
  // way to catch a rename that would silently unbind the whole loop.
  recordPreflight(
    "the case type binds the supervisor root skill",
    caseType?.default_skill_slug === "lead-opportunity-supervisor",
    caseType?.default_skill_slug ?? "none"
  );

  // Resolved the way `createOperationalCase` itself resolves it — by case type,
  // private-published over global-published — rather than by definition id. The
  // first hosted run caught this: `getPublishedDefinition` takes a definition
  // UUID, and passing the case-type slug failed with `invalid input syntax for
  // type uuid`. It failed in PREFLIGHT, before any durable write, which is
  // where a verifier defect should surface.
  const definition = caseType
    ? await getLatestPublishedDefinitionForUser(db, ownerUserId, LEAD_OPPORTUNITY_CASE_TYPE)
    : null;
  recordPreflight(
    "a published lead_opportunity definition resolves for this owner",
    Boolean(definition),
    definition
      ? `v${definition.version} status=${definition.status} scope=${definition.owner_scope}`
      : "not found"
  );

  // The M-SUBJECTS shape has to exist before a wake can record a commitment.
  // PostgREST rejects a select naming a column that does not exist, so a
  // successful zero-row read is first-hand proof of shape — and NOT of indexes,
  // constraints or triggers, which the API exposes no catalog for.
  const { error: subjectShape } = await db
    .from("case_subjects")
    .select("id, case_id, subject_kind, attrs_jsonb, actor_kind, source_kind")
    .limit(1);
  recordPreflight(
    "case_subjects is present with the TD-14 columns",
    !subjectShape,
    subjectShape ? (subjectShape as { message?: string }).message : "6 columns readable"
  );

  const { error: subjectFactShape } = await db
    .from("case_facts")
    .select("id, case_id, fact_key, subject_id")
    .limit(1);
  recordPreflight(
    "case_facts carries subject_id",
    !subjectFactShape,
    subjectFactShape
      ? (subjectFactShape as { message?: string }).message
      : "column readable"
  );

  if (!allPassed(preflight)) {
    console.error(
      "\nPreflight failed. Nothing was written. Fix the setup above and re-run."
    );
    process.exit(1);
  }

  const ctx: RunContext = { db, organizationId, ownerUserId, runLabel };
  console.log("");

  if (phase === "seed") {
    await phaseSeed(ctx, caseType!.id, definition!.id, definition!.version);
    return;
  }
  if (phase === "wake") {
    await phaseWake(ctx);
    return;
  }

  const ok = await phaseVerify(ctx, jsonPath);
  console.log("");
  if (!ok) {
    console.error("SL-4 hosted verification FAILED — see the checks above.");
    process.exit(1);
  }
  console.log("SL-4 hosted verification passed.");
}

// Only run the CLI when this file IS the entry point. Without the guard, a test
// that imports a phase would execute the whole verifier — including its
// fail-closed target resolution — as an import side effect.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
