// Hosted verification for the Work Portfolio v1 (R1 SL-7), RS-2.
//
// SL-7's Release Scope is RS-2 hosted (human decision of 2026-09-09): the
// reviewed application code, executed by the operator process against hosted
// staging persistence, with a REAL authenticated advisor session. Its protocol
// was fixed before implementation (Slice Plan SL-7, "RS-2 hosted protocol").
// Everything the deterministic suite owns — the six predicates, the
// presentation guard, tenancy, the action gates — is proven by
// `npm run test:work-portfolio` and `npm run test:rls`; this run complements
// them with integrated surface evidence and does not replace them.
//
// PHASES, AND WHO DOES WHAT
//
//   --phase seed        WRITES, once, after the human authorizes the one
//                       controlled Case. Creates it through the canonical write
//                       paths and runs ONE canonical supervisor reconsideration
//                       with a deterministic stub judge, so the Case carries a
//                       live human ask (open Work of a waiting_for_human_input
//                       settlement) and a due advisor commitment.
//   --phase checkpoint  READ-ONLY. --label t0 before the advisor's session,
//                       t1 after they snooze and hide the seeded Case, t2 after
//                       they complete the ask. Full rows of the seeded Case and
//                       a digest of EVERYTHING outside it.
//   --phase probe-snippet  Prints a snippet the ADVISOR runs in their own
//                       signed-in browser: it tries to write another user's
//                       presentation state and prints only the refusal code.
//   --phase verify      READ-ONLY. Evaluates the three pass criteria from the
//                       checkpoints, the advisor's page captures and the probe
//                       result; writes digest-only evidence.
//
// The advisor signs in personally and the operator never handles a credential:
// no phase reads, asks for or stores one. The app runs from the merged commit
// in the operator's process (`scripts/run-app-against-target.ts`); no Gu OS
// application runtime is deployed in staging and none is claimed.
//
// BOUNDARIES (Slice Plan SL-7): SL-4's evidence Cases are never written; no
// authority changes — the seeded Case is created under TD-3's default
// `legacy`; no hosted positive case is claimed for `stalled` or for the three
// predicates without a producer; no source system is reached.
//
// The stub judge is honest about being one: its `modelId` is null, so the
// reconsideration it produces records `model_id: null` and can never be read as
// a model's judgment. SL-7 evidences the Portfolio, not the supervisor.
//
// Usage (after merge, with M-PRESENTATION delivered to staging):
//   npx tsx scripts/verify-portfolio.ts --phase seed --env-file .env.staging.local --env staging \
//     --organization <uuid> --advisor-user <uuid> --run <label> --out seed.json --acknowledge-durable-write
//   npx tsx scripts/verify-portfolio.ts --phase checkpoint … --seed seed.json --label t0 --out t0.json
//   npx tsx scripts/verify-portfolio.ts --phase probe-snippet … --seed seed.json --other-user <uuid>
//   npx tsx scripts/verify-portfolio.ts --phase verify … --seed seed.json \
//     --checkpoints t0.json,t1.json,t2.json --captures <dir> --probe probe.json --json evidence.json

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  createOperationalCase,
  getActiveMembership,
  getGlobalOperationalCaseTypeBySlug,
  getLatestPublishedDefinitionForUser,
  getOrganizationById,
  getOrganizationFlag,
  insertCaseFact,
  type DbClient,
} from "@agents/db";
import type {
  CaseApproval,
  CaseFact,
  CaseSubject,
  OperationalCase,
  OperationalCaseEvent,
  PortfolioPresentationState,
  WorkItem,
} from "@agents/types";
import {
  buildWakeKey,
  runSupervisorWake,
  type NextWorkJudge,
} from "../apps/web/src/lib/relationship-supervisor";
import { buildCaseSnapshots } from "../apps/web/src/lib/work-portfolio/snapshot";
import { evaluateMustSurface } from "../apps/web/src/lib/work-portfolio/must-surface";
import { decidePresentation } from "../apps/web/src/lib/work-portfolio/presentation";
import {
  allPassed,
  evaluatePortfolioEvidence,
  fingerprint,
  OUTSIDE_TABLES,
  SEEDED_TABLES,
  type HostedCheck,
  type OutsideTable,
  type PortfolioCheckpoint,
  type ProjectedSeed,
  type Row,
  type SeededTable,
} from "./lib/portfolio-evidence";
import { assertBinding, describeTarget, parseTargetArgs, resolveTarget } from "./lib/target-env";

const LEAD_OPPORTUNITY_CASE_TYPE = "lead_opportunity";
/** Stamped on the one Case this verifier creates, so it is never mistaken for a lead. */
const SCENARIO_KIND = "sl7_controlled";
const PAGE = 1000;

function parseNamed(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return (argv[++i] ?? "").trim() || undefined;
  }
  return undefined;
}

/** Stable, non-reversible stand-in so evidence can correlate without exposing. */
function redact(value: string | null | undefined): string | null {
  if (!value) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export interface SeedManifest {
  run: string;
  organizationId: string;
  advisorUserId: string;
  caseId: string;
  askWorkItemId: string;
  commitmentSubjectId: string | null;
  seededAt: string;
}

// ============================================================================
// seed — the one controlled Case, through the canonical write paths
// ============================================================================

/**
 * The deterministic proposal the controlled seed runs the REAL supervisor
 * with. Wholly synthetic; its only job is to leave the two live must-surface
 * conditions the protocol names: an open human ask and a due advisor
 * commitment (a full instant, one hour in the past).
 */
export function seedJudge(dueAt: string): NextWorkJudge {
  return {
    // A stub: the record will say `model_id: null`, never a model's name.
    modelId: null,
    async propose() {
      return {
        posture: "targeted_human_input",
        diagnosis: "Semilla controlada SL-7: presupuesto por confirmar con el asesor.",
        rationale:
          "Semilla controlada SL-7 (sin modelo): se pide al asesor confirmar el presupuesto real antes de preparar opciones.",
        insufficient_evidence: false,
        capability_gap: null,
        proposed_work: [
          {
            work_type: "confirm_budget_with_advisor",
            purpose: "Confirmar con el asesor el presupuesto real del prospecto (semilla controlada SL-7)",
            durable: true,
          },
        ],
        commitments: [
          {
            expected_outcome: "Enviar al prospecto tres opciones (semilla controlada SL-7)",
            actor: "advisor",
            due_at: dueAt,
            due_stated: true,
            key: "sl7_seed_send_options",
          },
        ],
        reconsider_in_hours: 24,
      };
    },
  };
}

export async function phaseSeed(db: DbClient, args: { organizationId: string; advisorUserId: string; run: string; out: string }) {
  const { data: existing, error } = await db
    .from("operational_cases")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("context_jsonb->>sl7_run", args.run);
  if (error) throw error;
  if ((existing ?? []).length > 0) {
    throw new Error(`run "${args.run}" already has a controlled Case. Seed once per run.`);
  }

  const caseType = await getGlobalOperationalCaseTypeBySlug(db, LEAD_OPPORTUNITY_CASE_TYPE);
  const definition = await getLatestPublishedDefinitionForUser(db, args.advisorUserId, LEAD_OPPORTUNITY_CASE_TYPE);
  if (!caseType || !definition) throw new Error("lead_opportunity type or published definition missing");

  const opCase = await createOperationalCase(db, {
    userId: args.advisorUserId,
    caseTypeId: caseType.id,
    caseType: LEAD_OPPORTUNITY_CASE_TYPE,
    organizationId: args.organizationId,
    // TD-3's default for a relationship Case. Not an authority change: nothing
    // moves authority, and the Portfolio run never touches it.
    runtimeAuthority: "legacy",
    status: "active",
    currentStep: null,
    nextActionAt: null,
    context: {
      scenario_kind: SCENARIO_KIND,
      sl7_run: args.run,
      title: "Semilla controlada SL-7 — una pregunta abierta al asesor y un compromiso vencido del asesor",
      governing: "Slice Plan SL-7 RS-2 hosted protocol; SA-7.1, SA-7.5, SA-7.8",
    },
    workflowDefinition: { id: definition.id, version: definition.version },
  });
  await insertCaseFact(db, {
    userId: args.advisorUserId,
    caseId: opCase.id,
    factKey: "opportunity.objective",
    value: { objective: "Semilla controlada SL-7: casa de 3 recámaras al norte", category: "buy_residential" },
    sourceKind: "derived",
    sourceRef: `sl7_verifier:${args.run}`,
  });

  const now = new Date();
  const dueAt = new Date(now.getTime() - 3_600_000).toISOString();
  const result = await runSupervisorWake({
    db,
    organizationId: args.organizationId,
    userId: args.advisorUserId,
    caseId: opCase.id,
    wake: { reason: "manual", key: buildWakeKey.manual(`sl7-seed:${args.run}`) },
    judge: seedJudge(dueAt),
    availableCapabilities: [],
    now,
  });
  if (result.status !== "reconsidered") {
    throw new Error(`the canonical reconsideration did not run: ${JSON.stringify(result)}`);
  }
  const askWorkItemId = result.record.proposed_work_ids[0];
  if (!askWorkItemId || result.record.yield_posture !== "waiting_for_human_input") {
    throw new Error("the seed did not leave an open human ask — refusing to continue");
  }

  const manifest: SeedManifest = {
    run: args.run,
    organizationId: args.organizationId,
    advisorUserId: args.advisorUserId,
    caseId: opCase.id,
    askWorkItemId,
    commitmentSubjectId: result.commitments[0]?.subjectId ?? null,
    seededAt: now.toISOString(),
  };
  writeFileSync(args.out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`  seeded  case ${redact(opCase.id)} · ask ${redact(askWorkItemId)} · yield ${result.record.yield_posture}`);
  console.log(`  manifest (raw ids, keep out of the repo): ${args.out}`);
}

// ============================================================================
// checkpoint — read-only
// ============================================================================

async function readAll(db: DbClient, table: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select("*").order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < PAGE) return rows;
  }
}

function belongsToSeed(table: string, row: Row, caseId: string, seededWorkIds: Set<string>): boolean {
  switch (table) {
    case "operational_cases":
      return row.id === caseId;
    case "work_item_attempts":
    case "work_item_events":
      return seededWorkIds.has(String(row.work_item_id));
    case "case_relationships":
      return row.from_case_id === caseId || row.to_case_id === caseId;
    case "portfolio_presentation_state":
      return row.subject_id === caseId;
    case "organizations":
    case "organization_memberships":
    case "organization_feature_flags":
    case "ai_usage_events":
      return false;
    default:
      return row.case_id === caseId;
  }
}

export async function phaseCheckpoint(db: DbClient, seed: SeedManifest, label: string, out: string) {
  const everything = new Map<string, Row[]>();
  for (const table of OUTSIDE_TABLES) everything.set(table, await readAll(db, table));
  const seededWorkIds = new Set(
    (everything.get("work_items") ?? []).filter((w) => w.case_id === seed.caseId).map((w) => String(w.id))
  );

  const seeded = {} as Record<SeededTable, Row[]>;
  for (const table of SEEDED_TABLES) {
    seeded[table] = (everything.get(table) ?? []).filter((row) => belongsToSeed(table, row, seed.caseId, seededWorkIds));
  }
  const outside = {} as Record<OutsideTable, ReturnType<typeof fingerprint>>;
  for (const table of OUTSIDE_TABLES) {
    outside[table] = fingerprint(
      (everything.get(table) ?? []).filter((row) => !belongsToSeed(table, row, seed.caseId, seededWorkIds))
    );
  }
  const checkpoint: PortfolioCheckpoint = {
    label,
    takenAt: new Date().toISOString(),
    seededCaseId: seed.caseId,
    seeded,
    outside,
    presentation: (everything.get("portfolio_presentation_state") ?? []).filter((r) => r.subject_id === seed.caseId),
  };
  writeFileSync(out, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  console.log(`  checkpoint ${label}: ${Object.values(outside).reduce((n, f) => n + f.rows, 0)} outside rows fingerprinted across ${OUTSIDE_TABLES.length} tables`);
  console.log(`  written (raw rows of the synthetic seed only, keep out of the repo): ${out}`);
}

// ============================================================================
// verify — read-only
// ============================================================================

/** The pure projection's view of the seeded Case, with the advisor's presentation. */
export function projectSeed(checkpoint: PortfolioCheckpoint, seed: SeedManifest): ProjectedSeed {
  const s = checkpoint.seeded;
  const [snapshot] = buildCaseSnapshots({
    organizationId: seed.organizationId,
    cases: s.operational_cases as unknown as OperationalCase[],
    facts: (s.case_facts as unknown as CaseFact[]).filter((f) => f.superseded_by === null),
    subjects: s.case_subjects as unknown as CaseSubject[],
    events: s.operational_case_events as unknown as OperationalCaseEvent[],
    approvals: s.case_approvals as unknown as CaseApproval[],
    work: s.work_items as unknown as WorkItem[],
  });
  const at = new Date(checkpoint.takenAt);
  const attention = snapshot ? evaluateMustSurface(snapshot, at) : [];
  const row = checkpoint.presentation.find((r) => r.user_id === seed.advisorUserId) as unknown as
    | PortfolioPresentationState
    | undefined;
  const decision = decidePresentation({ mustSurface: attention.length > 0 }, row ?? null, at);
  return {
    predicates: [...new Set(attention.map((a) => a.predicate))].sort(),
    visible: decision.visible,
    exemptBecauseMustSurface: decision.exemptBecauseMustSurface,
    userSuppression: decision.userSuppression,
  };
}

export async function phaseVerify(
  db: DbClient,
  seed: SeedManifest,
  args: { checkpoints: string[]; captures: string; probe: string | undefined; json: string | undefined }
): Promise<boolean> {
  const [t0, t1, t2] = args.checkpoints.map((file) => JSON.parse(readFileSync(file, "utf8")) as PortfolioCheckpoint);
  const capture = (name: string) => readFileSync(path.join(args.captures, name), "utf8");
  const captures = {
    myWork: capture("my-work.txt"),
    organizationWork: capture("organization-work.txt"),
    afterSuppress: capture("after-suppress.txt"),
    afterComplete: capture("after-complete.txt"),
  };
  const probe = args.probe ? (JSON.parse(readFileSync(args.probe, "utf8")) as { attempted: boolean; refused: boolean; code: string | null }) : null;

  // Every Case of every OTHER Organization — the negative the advisor's pages
  // must not contain. Read whole and filtered here: the environment is small,
  // and a filter the runner does not express cannot be mis-expressed.
  const otherOrganizationCaseIds = (await readAll(db, "operational_cases"))
    .filter((row) => row.organization_id != null && row.organization_id !== seed.organizationId)
    .map((row) => String(row.id));

  const checks: HostedCheck[] = evaluatePortfolioEvidence({
    organizationId: seed.organizationId,
    seededCaseId: seed.caseId,
    advisorUserId: seed.advisorUserId,
    askWorkItemId: seed.askWorkItemId,
    t0,
    t1,
    t2,
    projected: { t1: projectSeed(t1, seed), t2: projectSeed(t2, seed) },
    captures,
    otherOrganizationCaseIds,
    probe,
  });
  console.log("");
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  [${c.assertion}] ${c.label}${c.detail ? ` - ${c.detail}` : ""}`);
  }
  const ok = allPassed(checks);

  if (args.json) {
    const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          slice: "SL-7",
          releaseScope: "RS-2",
          run: seed.run,
          organization: redact(seed.organizationId),
          seededCase: redact(seed.caseId),
          advisor: redact(seed.advisorUserId),
          askWorkItem: redact(seed.askWorkItemId),
          topology: "application code executed by the operator process against hosted staging persistence; no deployed Gu OS runtime",
          legacySourceReads: 0,
          legacySourceWrites: 0,
          checkpoints: [t0, t1, t2].map((cp) => ({
            label: cp.label,
            takenAt: cp.takenAt,
            seeded: Object.fromEntries(SEEDED_TABLES.map((t) => [t, fingerprint(cp.seeded[t])])),
            outside: cp.outside,
            presentation: fingerprint(cp.presentation),
          })),
          captures: Object.fromEntries(Object.entries(captures).map(([k, v]) => [k, digest(v)])),
          otherOrganizationCases: otherOrganizationCaseIds.length,
          probe,
          checks,
          passed: ok,
          notExercised: [
            "stalled positive case (no Organization Case holds gu_os authority before SL-11)",
            "pending approval, authority conflict and unknown-outcome predicates (no producer before SL-9 / SL-6)",
            "deployment infrastructure, a hosted URL, production build or deployment, domain/CDN, scaling, production operation",
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(`\nartifact: ${args.json}`);
  }
  return ok;
}

// ============================================================================
// probe-snippet — for the ADVISOR to run, in their own browser
// ============================================================================

function probeSnippet(args: { supabaseUrl: string; publishableKey: string; projectRef: string; seed: SeedManifest; otherUserId: string }): string {
  return `/* SL-7 RS-2 probe — run in YOUR signed-in /portfolio tab. It tries to write
   another user's presentation state with YOUR session and prints only the
   result code. Your session never leaves this browser. */
(async () => {
  const name = "sb-${args.projectRef}-auth-token";
  const parts = document.cookie.split("; ").map((c) => c.split("=")).filter(([k]) => k === name || k.startsWith(name + "."));
  parts.sort(([a], [b]) => (a.split(".")[1] ?? "0") - (b.split(".")[1] ?? "0"));
  let raw = decodeURIComponent(parts.map(([, ...v]) => v.join("=")).join(""));
  if (raw.startsWith("base64-")) raw = atob(raw.slice(7).replace(/-/g, "+").replace(/_/g, "/"));
  const token = JSON.parse(raw).access_token;
  const res = await fetch("${args.supabaseUrl}/rest/v1/portfolio_presentation_state", {
    method: "POST",
    headers: { apikey: "${args.publishableKey}", Authorization: "Bearer " + token, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: "${args.otherUserId}", organization_id: "${args.seed.organizationId}", subject_kind: "case", subject_id: "${args.seed.caseId}" }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ attempted: true, refused: !res.ok, code: body.code ?? String(res.status) }));
})();`;
}

// ============================================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const phase = parseNamed(argv, "--phase");
  if (!["seed", "checkpoint", "probe-snippet", "verify"].includes(phase ?? "")) {
    throw new Error("--phase <seed|checkpoint|probe-snippet|verify> is required.");
  }
  const target = resolveTarget(parseTargetArgs(argv));
  assertBinding(target);
  console.log(describeTarget(target));
  console.log(`phase: ${phase}`);
  console.log("legacy source: NOT REACHED\n");
  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error("FAIL CLOSED - GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL are required.");
  }
  const db = createClient(target.supabaseUrl, target.serviceRoleKey) as unknown as DbClient;

  if (phase === "seed") {
    if (!argv.includes("--acknowledge-durable-write")) {
      throw new Error(
        "--acknowledge-durable-write is required: this creates ONE controlled Organization Case, its " +
          "objective fact, one supervisor reconsideration, one Work Item and one commitment subject, " +
          "through the canonical write paths. Run it only after the human authorizes the seed."
      );
    }
    const organizationId = parseNamed(argv, "--organization");
    const advisorUserId = parseNamed(argv, "--advisor-user");
    const run = parseNamed(argv, "--run");
    const out = parseNamed(argv, "--out");
    if (!organizationId || !advisorUserId || !run || !out) {
      throw new Error("--organization, --advisor-user, --run and --out are required.");
    }
    // Preconditions: read and reported, never configured.
    const organization = await getOrganizationById(db, organizationId);
    const membership = await getActiveMembership(db, organizationId, advisorUserId);
    const ops = await getOrganizationFlag(db, organizationId, "relationship_ops");
    const mode = await getOrganizationFlag(db, organizationId, "relationship_admission_mode");
    const problems = [
      !organization && "the Organization does not resolve",
      membership?.role !== "advisor" && "the declared user is not an active advisor of the Organization",
      ops?.enabled !== true && "relationship_ops is not enabled (a separate authorized change; this run never sets it)",
      (mode?.enabled !== true || mode.value_text !== "shadow") && "the Organization is not in the shadow stage",
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(`preflight failed, nothing written:\n  - ${problems.join("\n  - ")}`);
    await phaseSeed(db, { organizationId, advisorUserId, run, out });
    return;
  }

  const seedPath = parseNamed(argv, "--seed");
  if (!seedPath) throw new Error("--seed <manifest.json> is required.");
  const seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedManifest;

  if (phase === "checkpoint") {
    const label = parseNamed(argv, "--label");
    const out = parseNamed(argv, "--out");
    if (!label || !out) throw new Error("--label <t0|t1|t2> and --out are required.");
    await phaseCheckpoint(db, seed, label, out);
    return;
  }

  if (phase === "probe-snippet") {
    const otherUserId = parseNamed(argv, "--other-user");
    if (!otherUserId || otherUserId === seed.advisorUserId) {
      throw new Error("--other-user <uuid> is required and must not be the advisor.");
    }
    if (!target.publishableKey) throw new Error("the publishable key is required for the snippet.");
    console.log(probeSnippet({ supabaseUrl: target.supabaseUrl, publishableKey: target.publishableKey, projectRef: target.projectRef, seed, otherUserId }));
    return;
  }

  const checkpoints = (parseNamed(argv, "--checkpoints") ?? "").split(",").filter(Boolean);
  const captures = parseNamed(argv, "--captures");
  if (checkpoints.length !== 3 || !captures) {
    throw new Error("--checkpoints t0.json,t1.json,t2.json and --captures <dir> are required.");
  }
  const ok = await phaseVerify(db, seed, {
    checkpoints,
    captures,
    probe: parseNamed(argv, "--probe"),
    json: parseNamed(argv, "--json"),
  });
  console.log("");
  if (!ok) {
    console.error("SL-7 hosted verification FAILED — see the checks above.");
    process.exit(1);
  }
  console.log("SL-7 hosted verification passed.");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
