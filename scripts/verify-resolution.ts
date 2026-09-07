// Hosted verification for duplicate & supersession resolution (R1 SL-3).
//
// SL-3's Release Scope is RS-2 hosted: "duplicate resolution must be exercised
// in a hosted shadow environment to mean anything". Its Definition of Done owes
// one hosted item that no fixture can produce:
//
//   RS-2 hosted evidence that S1's EC-06 and AC-15 scenarios pass on shadow
//   traffic — controlled or pilot-derived as available; organically occurring
//   live duplicates are not a prerequisite.
//
//   EC-06  two existing Cases appear duplicate → preserve both until canonical
//          resolution, relate with traceability, never delete one and discard
//          history;
//   AC-15  suspected duplicate WITH CONFLICTING FACTS, resolution occurs → one
//          canonical active responsibility, lineage and history retained.
//
// SA-3.1 additionally names "hosted verification" as part of its evidence type.
// Everything else in the Slice contract is deterministic and lives in
// `npm run test:resolution --workspace @agents/web`; the pass/fail logic of the
// hosted assertions is pure and unit-tested in `lib/resolution-evidence.ts`.
//
// WHY THE SCENARIOS ARE CONTROLLED, AND NOT HARVESTED FROM THE PILOT
//
// The Definition of Done permits controlled shadow data and says explicitly
// that organically occurring live duplicates are not a prerequisite. Two real
// Opportunities that a model happens to consider the same objective cannot be
// summoned on demand, and hunting for them would mean widening reads over
// Traditional Gu production for no evidentiary gain — the pair's *content* is
// not what the hosted layer proves. What only a hosted run can establish is
// that the two governed operations behave correctly against the real database:
// the partial-unique indexes, the `case_facts` supersession mechanics, PostgREST
// filter semantics, and the M-RESOLUTION-IDENTITY convergence this Slice added.
// So this verifier reaches NO source system at all: no Traditional Gu target,
// no legacy credential, zero legacy reads and zero legacy writes.
//
// THIS RUN WRITES — deliberately, and only what SL-3 itself writes. Controlled
// shadow Opportunity Cases for the pilot Organization, their facts, the lineage
// edges, the closures and the timeline narrations. That IS the evidence: a
// resolution that left nothing behind would prove nothing. The Cases are
// stamped `scenario_kind: "sl3_t8_controlled"` in `context_jsonb` so nothing
// downstream can mistake them for admitted pilot leads.
//
// IT DOES NOT CONFIGURE THE ENVIRONMENT. It never sets, clears or restores a
// feature flag. `relationship_ops` is a PRECONDITION: read, reported, and
// fail-closed when unmet. A run that quietly toggled authority to produce its
// own evidence would be generating the conditions it claims to observe.
//
// PRIVACY: scenario content is wholly synthetic — no prospect, message,
// contact, property or legacy identifier is read or reproduced. Row identifiers
// are digested, never literal, so the evidence file is safe to attach to a PR.
//
// Usage:
//   npx tsx scripts/verify-resolution.ts \
//     --env-file .env.staging.local --env staging \
//     --organization <uuid> --owner-user <uuid> \
//     --acknowledge-durable-write \
//     [--json evidence.json] [--skip-judgment]

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  createOperationalCase,
  getActiveMembership,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCase,
  getOrganizationById,
  getOrganizationFlag,
  insertCaseFact,
  listCaseFacts,
  listCaseRelationships,
  type DbClient,
} from "@agents/db";
import { ADMISSION_FACT_KEYS } from "@agents/types";
import {
  createOpenRouterContinuityJudge,
  findIncompleteResolutions,
  proposeContinuity,
  resolveCanonicalization,
  type ContinuityProposal,
  type OpportunitySummary,
  type ResolutionKind,
  type ResolutionRequest,
} from "../apps/web/src/lib/relationship-resolution";
import {
  allPassed,
  evaluateHostedResolutionEvidence,
  type HostedCaseRow,
  type HostedCheck,
  type HostedFactRow,
  type HostedRelationshipRow,
  type HostedResolutionOutcome,
  type HostedSide,
  type HostedTimelineRow,
} from "./lib/resolution-evidence";
import {
  assertBinding,
  describeTarget,
  parseTargetArgs,
  resolveTarget,
} from "./lib/target-env";

const LEAD_OPPORTUNITY_CASE_TYPE = "lead_opportunity";
const CONFLICT_FACT_KEY = ADMISSION_FACT_KEYS.objective;
/** Stamped on every Case this verifier creates, so it is never mistaken for a lead. */
const SCENARIO_KIND = "sl3_t8_controlled";

const preflight: HostedCheck[] = [];

function recordPreflight(label: string, ok: boolean, detail?: string): void {
  preflight.push({ assertion: "preflight", label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [preflight] ${label}${detail ? ` - ${detail}` : ""}`);
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
    return { ok: false, detail: (error as { message?: string }).message ?? "unreadable" };
  }
  return { ok: true, detail: `${columns.length} columns readable` };
}

// ============================================================================
// Controlled scenario content — wholly synthetic.
//
// Shaped after the eval set's AC-15 cases: one underlying objective, stated
// twice with details that genuinely disagree. The disagreement is the point —
// AC-15 is not "duplicate", it is "suspected duplicate WITH CONFLICTING FACTS",
// and a pair that agrees on everything would be testing a weaker scenario than
// the Definition of Done asks for.
// ============================================================================

interface ScenarioCaseSeed {
  label: string;
  /** An earlier statement of the objective, superseded by the current one. */
  priorObjective?: { objective: string; category: string };
  objective: { objective: string; category: string };
}

interface Scenario {
  id: string;
  kind: ResolutionKind;
  title: string;
  governing: string;
  closing: ScenarioCaseSeed;
  surviving: ScenarioCaseSeed;
  /** The actor's own explanation, carried onto both governed halves. */
  determinationNote: string;
  /** Whether the continuity judge is asked about this pair. */
  judged: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    id: "ec06-ac15-duplicate",
    kind: "duplicate",
    title:
      "Two Opportunities for one objective, with conflicting recorded facts (EC-06, AC-15)",
    governing: "S1 §8.6, §8.10, §8.16; EC-06; AC-15; SA-3.1",
    closing: {
      label: "second Opportunity — same objective, reached through another channel",
      priorObjective: {
        objective: "pregunta por casas en el norte",
        category: "buy_residential",
      },
      objective: {
        objective: "comprar casa de 3 recamaras en zona norte, presupuesto 4.2M",
        category: "buy_residential",
      },
    },
    surviving: {
      label: "first Opportunity — the canonical one",
      objective: {
        objective: "comprar casa de 3 recamaras en zona norte, presupuesto 5.0M",
        category: "buy_residential",
      },
    },
    determinationNote:
      "Controlled T8 scenario: one underlying objective recorded twice with a conflicting budget. Canonicalized onto the first Opportunity; the budget disagreement is preserved on both sides rather than reconciled.",
    judged: true,
  },
  {
    id: "sa311-supersession",
    kind: "supersession",
    title:
      "A durable responsibility intentionally replaced by a successor Opportunity (SA-3.11)",
    governing: "S1 §8.10, §8.16; ADR-109 §§4, 7, 8; AC-6 §11.4; SA-3.11",
    closing: {
      label: "the replaced Opportunity",
      objective: {
        objective: "comprar departamento en preventa, torre A",
        category: "buy_residential",
      },
    },
    surviving: {
      label: "the successor Opportunity",
      objective: {
        objective: "comprar departamento en preventa, torre B tras el cambio de proyecto",
        category: "buy_residential",
      },
    },
    determinationNote:
      "Controlled T8 scenario: an authorized determination replaced the original durable responsibility with a successor Opportunity for a reason other than duplicate correction. SL-3 contracts what must be true after such a determination; it does not decide when Gu should reach one.",
    judged: false,
  },
];

// ============================================================================
// Hosted reads — the snapshots the pure evaluator consumes.
// ============================================================================

const CASE_COLUMNS =
  "id,user_id,organization_id,case_type,status,current_step,next_action_at,due_at,runtime_authority,assigned_to_user_id,workflow_definition_id,version,updated_at";

async function readCaseRow(db: DbClient, caseId: string): Promise<HostedCaseRow | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select(CASE_COLUMNS)
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw error;
  return (data as HostedCaseRow | null) ?? null;
}

/** EVERY fact row, superseded included — history is the thing being proved. */
async function readFactRows(
  db: DbClient,
  params: { userId: string; caseId: string }
): Promise<HostedFactRow[]> {
  const rows = await listCaseFacts(db, params.userId, params.caseId, {
    includeSuperseded: true,
    limit: 1000,
  });
  return rows.map((row) => ({
    id: row.id,
    case_id: row.case_id,
    fact_key: row.fact_key,
    source_kind: row.source_kind ?? null,
    source_ref: row.source_ref ?? null,
    value_jsonb: row.value_jsonb,
    superseded_by: row.superseded_by ?? null,
  }));
}

async function readTimeline(db: DbClient, caseId: string): Promise<HostedTimelineRow[]> {
  const { data, error } = await db
    .from("operational_case_events")
    .select("case_id,payload_jsonb")
    .eq("case_id", caseId);
  if (error) throw error;
  return (data ?? []) as HostedTimelineRow[];
}

async function readRelationships(
  db: DbClient,
  params: { organizationId: string; caseId: string }
): Promise<HostedRelationshipRow[]> {
  const rows = await listCaseRelationships(db, params);
  return rows as unknown as HostedRelationshipRow[];
}

async function snapshot(
  db: DbClient,
  params: { organizationId: string; userId: string; caseId: string }
): Promise<HostedSide> {
  return {
    case: await readCaseRow(db, params.caseId),
    facts: await readFactRows(db, { userId: params.userId, caseId: params.caseId }),
    timeline: await readTimeline(db, params.caseId),
    relationships: await readRelationships(db, {
      organizationId: params.organizationId,
      caseId: params.caseId,
    }),
  };
}

// ============================================================================
// Seeding
// ============================================================================

async function seedScenarioCase(
  db: DbClient,
  params: {
    organizationId: string;
    ownerUserId: string;
    caseTypeId: string;
    scenarioId: string;
    role: "closing" | "surviving";
    seed: ScenarioCaseSeed;
    runId: string;
  }
): Promise<string> {
  const created = await createOperationalCase(db, {
    userId: params.ownerUserId,
    caseTypeId: params.caseTypeId,
    caseType: LEAD_OPPORTUNITY_CASE_TYPE,
    organizationId: params.organizationId,
    // Same shape SL-2's admitted shadow Opportunity carries: Gu OS takes durable
    // responsibility, legacy keeps runtime decision authority (ADR-107).
    runtimeAuthority: "legacy",
    status: "active",
    // No workflow stage: Opportunity progression lives in facts (TD-8, AC-7).
    currentStep: null,
    // Shadow: nothing is scheduled to act on this Case.
    nextActionAt: null,
    context: {
      relationship_ops: true,
      // Never "traditional_gu": this Case was not admitted from a real lead, and
      // saying so is the difference between controlled evidence and fiction.
      source_system: "controlled_scenario",
      scenario_kind: SCENARIO_KIND,
      scenario_id: params.scenarioId,
      scenario_role: params.role,
      scenario_run_id: params.runId,
      admission_mode: "shadow",
    },
  });

  const factProvenance = {
    userId: params.ownerUserId,
    caseId: created.id,
    sourceKind: "derived" as const,
    factKey: CONFLICT_FACT_KEY,
  };

  // An earlier statement, superseded by the current one, so "history retained"
  // has a genuine history to retain rather than a single row.
  if (params.seed.priorObjective) {
    await insertCaseFact(db, {
      ...factProvenance,
      value: params.seed.priorObjective,
      sourceRef: `controlled_scenario:${params.runId}:${params.role}:prior`,
    });
  }
  await insertCaseFact(db, {
    ...factProvenance,
    value: params.seed.objective,
    sourceRef: `controlled_scenario:${params.runId}:${params.role}`,
  });

  return created.id;
}

/**
 * Builds the judge's view of an Opportunity from what staging actually holds.
 *
 * Read back rather than reused from the seed on purpose: the judgment must run
 * over hosted rows, or it is testing this process's memory.
 */
function summaryFromFacts(facts: HostedFactRow[]): OpportunitySummary {
  const current = facts.find(
    (row) => row.fact_key === CONFLICT_FACT_KEY && row.superseded_by === null
  );
  const value = (current?.value_jsonb ?? {}) as { objective?: string; category?: string };
  return {
    objective: value.objective ?? null,
    objectiveCategory: value.category ?? null,
    requirements: [],
    propertyContext: null,
    recentMessages: [],
  };
}

function toOutcome(result: unknown): HostedResolutionOutcome {
  const shaped = result as Record<string, unknown>;
  return {
    status: String(shaped.status),
    relationshipId: (shaped.relationshipId as string | null) ?? null,
    closureFactId: (shaped.closureFactId as string | null) ?? null,
    narratedBothTimelines: shaped.narratedBothTimelines as boolean | undefined,
    firstCompletion: shaped.firstCompletion as boolean | undefined,
    missing: shaped.missing as string | undefined,
    detail: shaped.detail as string | undefined,
    reason: shaped.reason as string | undefined,
  };
}

interface ScenarioEvidence {
  id: string;
  kind: ResolutionKind;
  title: string;
  governing: string;
  cases: { closing: string | null; surviving: string | null };
  continuityJudgment:
    | { ran: false; why: string }
    | {
        ran: true;
        proposal: ContinuityProposal | null;
        model: string;
        path: string;
      };
  result: HostedResolutionOutcome;
  repeat: HostedResolutionOutcome;
  relationship: {
    id: string | null;
    type: string | null;
    status: string | null;
    actorKind: string | null;
  };
  checks: HostedCheck[];
  passed: boolean;
}

async function runScenario(
  db: DbClient,
  params: {
    scenario: Scenario;
    organizationId: string;
    ownerUserId: string;
    caseTypeId: string;
    runId: string;
    judge: ReturnType<typeof createOpenRouterContinuityJudge> | null;
  }
): Promise<ScenarioEvidence> {
  const { scenario, organizationId, ownerUserId } = params;
  console.log(`\nscenario ${scenario.id} — ${scenario.title}\n`);

  const closingCaseId = await seedScenarioCase(db, {
    organizationId,
    ownerUserId,
    caseTypeId: params.caseTypeId,
    scenarioId: scenario.id,
    role: "closing",
    seed: scenario.closing,
    runId: params.runId,
  });
  const survivingCaseId = await seedScenarioCase(db, {
    organizationId,
    ownerUserId,
    caseTypeId: params.caseTypeId,
    scenarioId: scenario.id,
    role: "surviving",
    seed: scenario.surviving,
    runId: params.runId,
  });
  console.log(
    `  seeded controlled pair: closing=${redact(closingCaseId)} surviving=${redact(survivingCaseId)}`
  );

  const before = {
    closing: await snapshot(db, { organizationId, userId: ownerUserId, caseId: closingCaseId }),
    surviving: await snapshot(db, {
      organizationId,
      userId: ownerUserId,
      caseId: survivingCaseId,
    }),
  };

  // ── The semantic half, over hosted rows.
  //
  // AC-15's condition is a SUSPECTED duplicate. Running the deployed judgment
  // path over what staging actually holds is what makes the premise real rather
  // than asserted by this script. It never decides the resolution: the
  // determination below is the authorized one, and the judge cannot return
  // "resolve".
  //
  // Through `proposeContinuity`, not the judge directly, because that is the
  // deployed path — it re-reads the flag and wraps the call in the
  // Organization-scoped AI-usage context the §2 baseline requires from SL-2 on.
  // Calling the judge bare would skip both and evidence something the runtime
  // does not do.
  let continuityJudgment: ScenarioEvidence["continuityJudgment"];
  let proposal: ContinuityProposal | null = null;
  if (scenario.judged && params.judge) {
    proposal = await proposeContinuity(db, {
      organizationId,
      userId: ownerUserId,
      judge: params.judge,
      input: {
        left: summaryFromFacts(before.closing.facts),
        right: summaryFromFacts(before.surviving.facts),
      },
    });
    continuityJudgment = {
      ran: true,
      proposal,
      model: process.env.RELATIONSHIP_CONTINUITY_MODEL_ID ?? "default (configuration)",
      path: "proposeContinuity — the deployed path: flag re-read, call wrapped in the Organization-scoped AI-usage context",
    };
    console.log(
      `  continuity judge: same_objective=${proposal?.same_objective ?? "null"} conflicting_facts=${proposal?.conflicting_facts ?? "null"} confidence=${proposal?.confidence ?? "null"}`
    );
  } else if (scenario.judged) {
    continuityJudgment = { ran: false, why: "--skip-judgment was passed" };
  } else {
    continuityJudgment = {
      ran: false,
      why:
        "supersession is not a sameness judgment. S1 approves `superseded` for a reason OTHER than duplicate correction, and ADR-109 §7 leaves the determination downstream; asking the continuity judge here would be asking the wrong question.",
    };
  }

  const request: ResolutionRequest = {
    organizationId,
    ownerUserId,
    kind: scenario.kind,
    closingCaseId,
    survivingCaseId,
    determination: {
      // The determination arrives from the authorized human path, not from the
      // model: this run applies the T8 authorization, and `actor_kind` must say
      // so rather than presenting a person's decision as a system inference.
      actorKind: "human",
      actorUserId: ownerUserId,
      note: scenario.determinationNote,
      evidenceRefs: {
        scenario_id: scenario.id,
        scenario_run_id: params.runId,
        verifier: "npm run verify:resolution",
        governing: scenario.governing,
        ...(proposal
          ? {
              continuity_judgment: {
                same_objective: proposal.same_objective,
                confidence: proposal.confidence,
                conflicting_facts: proposal.conflicting_facts,
              },
            }
          : {}),
      },
    },
  };

  const result = toOutcome(await resolveCanonicalization(db, request));
  console.log(`  resolution: status=${result.status} firstCompletion=${result.firstCompletion}`);

  const after = {
    closing: await snapshot(db, { organizationId, userId: ownerUserId, caseId: closingCaseId }),
    surviving: await snapshot(db, {
      organizationId,
      userId: ownerUserId,
      caseId: survivingCaseId,
    }),
  };

  // ── The same determination again. SA-3.12 makes a retried resolution a normal
  // event, so convergence has to be observed hosted, where the partial-unique
  // indexes actually exist.
  const repeat = toOutcome(await resolveCanonicalization(db, request));
  console.log(`  repeat:     status=${repeat.status} firstCompletion=${repeat.firstCompletion}`);

  const afterRepeat = {
    closing: await snapshot(db, { organizationId, userId: ownerUserId, caseId: closingCaseId }),
    surviving: await snapshot(db, {
      organizationId,
      userId: ownerUserId,
      caseId: survivingCaseId,
    }),
  };

  const incomplete = await findIncompleteResolutions(db, {
    organizationId,
    ownerUserId,
    caseId: closingCaseId,
  });

  const checks = evaluateHostedResolutionEvidence({
    kind: scenario.kind,
    organizationId,
    closingCaseId,
    survivingCaseId,
    conflictingFactKey: CONFLICT_FACT_KEY,
    before,
    after,
    result,
    repeat,
    afterRepeat,
    incompleteAfter: incomplete.map((row) => ({
      relationshipId: row.relationship.id,
      missing: row.missing,
    })),
    redact,
  });

  for (const check of checks) {
    console.log(
      `  ${check.ok ? "PASS" : "FAIL"}  [${check.assertion}] ${check.label}${check.detail ? ` - ${check.detail}` : ""}`
    );
  }

  const edge =
    after.closing.relationships.find((row) => row.id === result.relationshipId) ?? null;

  return {
    id: scenario.id,
    kind: scenario.kind,
    title: scenario.title,
    governing: scenario.governing,
    cases: { closing: redact(closingCaseId), surviving: redact(survivingCaseId) },
    continuityJudgment,
    result: {
      ...result,
      relationshipId: redact(result.relationshipId ?? null),
      closureFactId: redact(result.closureFactId ?? null),
    },
    repeat: {
      ...repeat,
      relationshipId: redact(repeat.relationshipId ?? null),
      closureFactId: redact(repeat.closureFactId ?? null),
    },
    relationship: {
      id: redact(edge?.id ?? null),
      type: edge?.relationship_type ?? null,
      status: edge?.status ?? null,
      actorKind: edge?.actor_kind ?? null,
    },
    checks,
    passed: allPassed(checks),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetArgs = parseTargetArgs(argv);
  const organizationId = parseNamed(argv, "--organization");
  const ownerUserId = parseNamed(argv, "--owner-user");
  const jsonPath = parseNamed(argv, "--json");
  const skipJudgment = argv.includes("--skip-judgment");

  if (argv.includes("--activate-flags-for-run")) {
    throw new Error(
      "--activate-flags-for-run is not supported. This verifier does not " +
        "configure the environment: enabling Relationship Operations is a " +
        "separate, explicitly authorized operation, and a run that toggled " +
        "authority to produce its own evidence would be generating the " +
        "conditions it claims to observe. Set the flag first, then re-run."
    );
  }
  if (!organizationId) throw new Error("--organization <uuid> is required.");
  if (!ownerUserId) {
    throw new Error(
      "--owner-user <uuid> is required: an Opportunity carries durable " +
        "responsibility for a named advisor, and every `case_facts` write in " +
        "this repo is user-scoped."
    );
  }
  if (!argv.includes("--acknowledge-durable-write")) {
    throw new Error(
      "--acknowledge-durable-write is required: this run creates durable Gu OS " +
        "rows (controlled shadow Opportunity Cases, their facts, lineage edges, " +
        "closures and timeline events). It reaches no source system and no " +
        "prospect-facing effect."
    );
  }

  const target = resolveTarget(targetArgs);
  assertBinding(target);
  console.log(describeTarget(target));
  console.log(`organization: ${organizationId}`);
  console.log("legacy source: NOT REACHED — this Slice's evidence needs no source read\n");

  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error(
      "FAIL CLOSED - resolution writes Organization-scoped Cases, facts and " +
        "relationships and needs GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL."
    );
  }
  if (!skipJudgment && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "FAIL CLOSED - OPENROUTER_API_KEY is required: AC-15's condition is a " +
        "SUSPECTED duplicate, and a script asserting the suspicion itself would " +
        "be weaker evidence than the deployed judge making it. Pass " +
        "--skip-judgment to record its absence explicitly instead."
    );
  }

  const db = createClient(target.supabaseUrl, target.serviceRoleKey) as unknown as DbClient;

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

  // ── The flag is a PRECONDITION. Read, reported, never written.
  const opsFlag = await getOrganizationFlag(db, organizationId, "relationship_ops");
  recordPreflight(
    "relationship_ops is enabled for this Organization",
    opsFlag?.enabled === true,
    opsFlag
      ? `enabled=${opsFlag.enabled}`
      : "flag row absent. Required setup: enable relationship_ops for this " +
        "Organization (a separate authorized configuration change), then re-run"
  );

  const caseType = await getGlobalOperationalCaseTypeBySlug(db, LEAD_OPPORTUNITY_CASE_TYPE);
  recordPreflight(
    "the global lead_opportunity Case type is registered",
    Boolean(caseType),
    caseType ? `id=${redact(caseType.id)}` : "not registered"
  );

  const relationshipsShape = await probeColumns(db, "case_relationships", [
    "id",
    "organization_id",
    "from_case_id",
    "to_case_id",
    "relationship_type",
    "status",
    "actor_kind",
    "created_by_user_id",
    "reason",
    "evidence_refs_jsonb",
    "provenance_jsonb",
    "ended_at",
  ]);
  recordPreflight(
    "case_relationships exposes the typed lineage shape TD-7 specifies",
    relationshipsShape.ok,
    relationshipsShape.detail
  );

  const factsShape = await probeColumns(db, "case_facts", [
    "id",
    "case_id",
    "fact_key",
    "source_kind",
    "source_ref",
    "superseded_by",
  ]);
  recordPreflight(
    "case_facts exposes the provenance and supersession columns closure uses",
    factsShape.ok,
    factsShape.detail
  );

  const eventsShape = await probeColumns(db, "operational_case_events", [
    "case_id",
    "event_type",
    "payload_jsonb",
  ]);
  recordPreflight(
    "operational_case_events is readable for both-timeline narration",
    eventsShape.ok,
    eventsShape.detail
  );

  if (!preflight.every((check) => check.ok)) {
    console.error("\nFAIL CLOSED — preflight did not pass; nothing was written.\n");
    process.exitCode = 1;
    return;
  }

  const judge = skipJudgment ? null : createOpenRouterContinuityJudge();
  const runId = randomUUID();
  const ranAt = new Date().toISOString();

  const scenarios: ScenarioEvidence[] = [];
  for (const scenario of SCENARIOS) {
    scenarios.push(
      await runScenario(db, {
        scenario,
        organizationId,
        ownerUserId,
        caseTypeId: caseType!.id,
        runId,
        judge,
      })
    );
  }

  const passed = preflight.every((c) => c.ok) && scenarios.every((s) => s.passed);
  const totalChecks =
    preflight.length + scenarios.reduce((sum, s) => sum + s.checks.length, 0);
  const failed =
    preflight.filter((c) => !c.ok).length +
    scenarios.reduce((sum, s) => sum + s.checks.filter((c) => !c.ok).length, 0);

  console.log(
    `\n${passed ? "PASS" : "FAIL"} — ${totalChecks - failed}/${totalChecks} hosted checks passed\n`
  );

  if (jsonPath) {
    const evidence = {
      slice: "SL-3",
      artifact: "RS-2 hosted evidence — duplicate & supersession resolution",
      ranAt,
      guOsEnvironment: target.name,
      guOsProjectRef: target.projectRef,
      legacySource:
        "NOT REACHED. Zero Traditional Gu reads and zero Traditional Gu writes: SL-3's hosted contract is about Gu OS relationship and closure mechanics, and no source read would strengthen it.",
      organizationDigest: redact(organizationId),
      ownerUserDigest: redact(ownerUserId),
      scenarioRunDigest: redact(runId),
      behaviorStage: "shadow — no assisted mode, no live mode, no runtime-authority transfer, no prospect-facing effect",
      scenarioData:
        "WHOLLY SYNTHETIC controlled shadow Opportunities created by this run for the pilot Organization, stamped context_jsonb.scenario_kind = 'sl3_t8_controlled'. No prospect, message, contact, property or legacy identifier was read or reproduced. The Definition of Done permits controlled shadow data and states that organically occurring live duplicates are not a prerequisite.",
      environmentMutations:
        "none — this verifier reads flags and configuration and never writes them",
      durableWrites:
        "operational_cases (4 controlled shadow Opportunities), case_facts (their objectives, and the two governed closures), case_relationships (2 lineage edges), operational_case_events (4 narrations). Retained deliberately as audit evidence; ending an edge is a status transition and nothing here is deleted.",
      indexAndConstraintEvidence:
        "not observable through the target API — PostgREST exposes no catalog. M-RESOLUTION-IDENTITY is evidenced BEHAVIOURALLY instead: the repeat of each determination converges on one edge, one closure and one narration per side, which is what those partial unique indexes exist to guarantee.",
      provenanceIdentity: "case_relationships:<relationship_id>",
      preflight,
      scenarios,
      totals: { checks: totalChecks, failed, passed },
      notExercised: [
        "Gu OS production — nothing deployed, migrated or read there.",
        "Hosted RLS enforcement — this run holds a service-role credential, which bypasses row-level security by design. SA-3.8's tenancy assertion is evidenced by the DB-backed cross-tenant suite (`npm run test:rls`), not by this run.",
        "SA-3.12's fault injection — slice-local and deterministic by contract. What is hosted here is the recovery READ, so 'safely retryable' is observed against the real database rather than an in-memory fake.",
        "Hosted AI-usage correlation — the continuity judgment runs through `proposeContinuity`, so the Organization-scoped usage context IS bound on the hosted path, but with AI_USAGE_METERING_ENABLED unset the meter drops the event by design and `ai_usage_events` holds no row. Correlation BEHAVIOUR is proven by the deterministic executor-level selftest; no governing acceptance or DoD clause requires it hosted. Same position SL-2 recorded.",
        "Human-reviewed merge/split data movement — deferred post-R1; no code path performs it (SA-3.10, deterministic).",
        "assisted and live behavior stages, and any prospect-facing effect — out of scope for a shadow Slice and never enabled.",
      ],
    };
    writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`evidence written: ${jsonPath}`);
  }

  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
