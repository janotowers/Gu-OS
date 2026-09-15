// Hosted verification for the Work Portfolio v2 (R1 SL-12), RS-2.
//
// SL-12's Release Scope is RS-2 hosted, in SL-7's topology (Slice Plan SL-12,
// "Release Scope" and "RS-2 evidence obligations"): the reviewed application,
// executed by the operator process against hosted staging persistence, with a
// REAL authenticated Alebrixe advisor session and the model called from that
// same process. The deterministic suite (`test:work-portfolio`,
// `test:work-portfolio-tools`, `test:rls`) and the eval own the guarantees and
// the judgment; this run shows the integrated surface and does not replace
// them.
//
// NOT BEFORE THE EVAL. TD-9 v2: the ranking "must pass an eval set with an
// S4-derived rubric before enablement". The activation phase below is an
// enablement, so it is run only after SA-12.6 is satisfied, and only on the
// human's authorization.
//
// PHASES, AND WHO DOES WHAT
//
//   --phase preflight          READ-ONLY. The Organization, the advisor's
//                              membership, the flags, the advisor's tool
//                              setting, the must-surface floor and the other
//                              Organizations — counts only.
//   --phase activate-ranking   WRITES one flag row, after the human authorizes
//                              it: `portfolio_contextual_ranking` on for the
//                              pilot, FOR THIS RUN ONLY. Records the prior
//                              state in the run manifest first, so restoration
//                              is against what was observed (SL-1's pattern).
//   --phase seed               OPTIONAL. WRITES, once, only if the human
//                              authorizes it because the pilot's Cases carry no
//                              contextual situation to rank: one controlled
//                              Case through the canonical write paths, with one
//                              canonical supervisor reconsideration by a
//                              deterministic stub judge (model_id null) whose
//                              recorded diagnosis needs a person, and NO
//                              governed predicate.
//   --phase checkpoint         READ-ONLY. --label t0 before the advisor's
//                              session, t1 after it. Ids, must-surface sets and
//                              fingerprints — no prospect content.
//   --phase snippets           Prints the page-capture script and the
//                              cross-user probe. Both run inside the advisor's
//                              own signed-in page and return only DOM data or
//                              status and row counts; the session never leaves
//                              the page.
//   --phase verify             READ-ONLY. Evaluates the four obligations and
//                              containment; writes digest-only evidence.
//   --phase restore-ranking    WRITES the flag row back exactly as found.
//
// The advisor signs in personally and the operator never handles a credential:
// no phase reads, asks for or stores one. No Gu OS runtime is deployed in
// staging and none is claimed.
//
// BOUNDARIES (Slice Plan SL-12): no write to SL-4's evidence Cases or to SL-7's
// seeded Case beyond what the advisor's session does through canonical
// mechanisms; no authority change; no persisted ranking; no source system is
// reached.
//
// Usage (after merge, and after SA-12.6):
//   npx tsx scripts/verify-portfolio-ranking.ts --phase preflight --env-file .env.staging.local --env staging \
//     --organization <uuid> --advisor-user <uuid>
//   npx tsx scripts/verify-portfolio-ranking.ts --phase activate-ranking … --organization <uuid> \
//     --advisor-user <uuid> --run <label> --manifest run.json --acknowledge-flag-write
//   npx tsx scripts/verify-portfolio-ranking.ts --phase seed … --manifest run.json --acknowledge-durable-write
//   npx tsx scripts/verify-portfolio-ranking.ts --phase checkpoint … --manifest run.json --label t0 --out t0.json
//   npx tsx scripts/verify-portfolio-ranking.ts --phase snippets … --manifest run.json --other-user <uuid>
//   npx tsx scripts/verify-portfolio-ranking.ts --phase verify … --manifest run.json --checkpoints t0.json,t1.json \
//     --captures <dir> --probe probe.json --json evidence.json
//   npx tsx scripts/verify-portfolio-ranking.ts --phase restore-ranking … --manifest run.json --acknowledge-flag-write

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  createOperationalCase,
  deleteOrganizationFlag,
  getActiveMembership,
  getGlobalOperationalCaseTypeBySlug,
  getLatestPublishedDefinitionForUser,
  getOrganizationById,
  getOrganizationFlag,
  insertCaseFact,
  setOrganizationFlag,
  type DbClient,
} from "@agents/db";
import type {
  CaseApproval,
  CaseFact,
  CaseSubject,
  OperationalCase,
  OperationalCaseEvent,
  WorkItem,
} from "@agents/types";
import {
  buildWakeKey,
  runSupervisorWake,
  type NextWorkJudge,
} from "../apps/web/src/lib/relationship-supervisor";
import { buildCaseSnapshots } from "../apps/web/src/lib/work-portfolio/snapshot";
import { evaluateMustSurface } from "../apps/web/src/lib/work-portfolio/must-surface";
import {
  allPassed,
  CAPTURE_SNIPPET,
  captureDigest,
  CITABLE_KINDS,
  CONTAINMENT_TABLES,
  evaluateRankingEvidence,
  fingerprint,
  PORTFOLIO_TOOL,
  RANKING_FLAG,
  RANKING_MODEL_ROLE,
  type CitableKind,
  type ContainmentTable,
  type HostedCheck,
  type PageCapture,
  type PortfolioToolCall,
  type ProbeResult,
  type RankingCheckpoint,
  type Row,
  type UsageRow,
} from "./lib/portfolio-ranking-evidence";
import { assertBinding, describeTarget, parseTargetArgs, resolveTarget } from "./lib/target-env";

const LEAD_OPPORTUNITY_CASE_TYPE = "lead_opportunity";
/** Stamped on the one Case the optional seed creates, so it is never mistaken for a lead. */
const SCENARIO_KIND = "sl12_controlled";
const PAGE = 1000;
const IN_CHUNK = 100;

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

export interface RunManifest {
  run: string;
  organizationId: string;
  advisorUserId: string;
  /** The flag exactly as found before this run touched it. */
  flagPrior: { present: boolean; enabled: boolean; valueText: string | null };
  activatedAt: string;
  seededCaseId: string | null;
}

// ============================================================================
// Reads
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

async function readWhereIn(db: DbClient, table: string, column: string, values: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    const { data, error } = await db.from(table).select("*").in(column, chunk);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
  }
  return rows;
}

async function flagEnabled(db: DbClient, organizationId: string, key: string): Promise<boolean> {
  return (await getOrganizationFlag(db, organizationId, key))?.enabled === true;
}

/** The pilot's Case rows and their evidence, as SL-7's pure projection reads them. */
async function readPilot(db: DbClient, organizationId: string) {
  const { data, error } = await db.from("operational_cases").select("*").eq("organization_id", organizationId);
  if (error) throw new Error(`operational_cases: ${error.message}`);
  const cases = (data ?? []) as Row[];
  const ids = cases.map((c) => String(c.id));
  const [facts, subjects, events, approvals, work] = await Promise.all([
    readWhereIn(db, "case_facts", "case_id", ids),
    readWhereIn(db, "case_subjects", "case_id", ids),
    readWhereIn(db, "operational_case_events", "case_id", ids),
    readWhereIn(db, "case_approvals", "case_id", ids),
    readWhereIn(db, "work_items", "case_id", ids),
  ]);
  return { cases, facts, subjects, events, approvals, work };
}

/** Must-surface predicates per Case, by SL-7's own rules, at `now`. */
export function mustSurfaceByCase(
  organizationId: string,
  pilot: Awaited<ReturnType<typeof readPilot>>,
  now: Date
): Record<string, string[]> {
  const snapshots = buildCaseSnapshots({
    organizationId,
    cases: pilot.cases as unknown as OperationalCase[],
    facts: (pilot.facts as unknown as CaseFact[]).filter((f) => f.superseded_by === null),
    subjects: pilot.subjects as unknown as CaseSubject[],
    events: pilot.events as unknown as OperationalCaseEvent[],
    approvals: pilot.approvals as unknown as CaseApproval[],
    work: pilot.work as unknown as WorkItem[],
  });
  const out: Record<string, string[]> = {};
  for (const snapshot of snapshots) {
    out[snapshot.case.id] = [...new Set(evaluateMustSurface(snapshot, now).map((a) => a.predicate))].sort();
  }
  return out;
}

function citableByCase(pilot: Awaited<ReturnType<typeof readPilot>>): RankingCheckpoint["citable"] {
  const out: RankingCheckpoint["citable"] = {};
  const add = (caseId: unknown, kind: CitableKind, id: unknown) => {
    const key = String(caseId);
    const entry = (out[key] ??= {});
    (entry[kind] ??= []).push(String(id));
  };
  for (const c of pilot.cases) out[String(c.id)] = { case: [String(c.id)] };
  for (const r of pilot.facts) add(r.case_id, "case_fact", r.id);
  for (const r of pilot.subjects) add(r.case_id, "case_subject", r.id);
  for (const r of pilot.work) add(r.case_id, "work_item", r.id);
  for (const r of pilot.events) add(r.case_id, "case_event", r.id);
  return out;
}

export function reduceToolCall(row: Row): PortfolioToolCall {
  const args = (row.arguments_json ?? {}) as Row;
  const result = (row.result_json ?? {}) as Row;
  const read = (result.result ?? {}) as Row;
  const needs = Array.isArray(read.needs_attention)
    ? (read.needs_attention as Row[]).map((n) => ({ case_id: String(n.case_id), kind: String(n.kind) }))
    : [];
  const others = Array.isArray(read.others) ? (read.others as Row[]).map((o) => String(o.case_id)) : [];
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    status: String(row.status),
    view: args.view === "organization" ? "organization" : "mine",
    toolStatus: typeof result.status === "string" ? result.status : null,
    readStatus: typeof read.status === "string" ? read.status : null,
    needs,
    others,
  };
}

async function readPortfolioToolCalls(db: DbClient, advisorUserId: string): Promise<PortfolioToolCall[]> {
  const { data: sessions, error } = await db.from("agent_sessions").select("id").eq("user_id", advisorUserId);
  if (error) throw new Error(`agent_sessions: ${error.message}`);
  const sessionIds = ((sessions ?? []) as Row[]).map((s) => String(s.id));
  const calls = (await readWhereIn(db, "tool_calls", "session_id", sessionIds)).filter((c) => c.tool_name === PORTFOLIO_TOOL);
  return calls.map(reduceToolCall).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function readRankingUsage(db: DbClient): Promise<UsageRow[]> {
  const { data, error } = await db
    .from("ai_usage_events")
    .select("id, occurred_at, organization_id, user_id, channel, status, model_role")
    .eq("model_role", RANKING_MODEL_ROLE);
  if (error) throw new Error(`ai_usage_events: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => ({
    id: String(r.id),
    occurred_at: String(r.occurred_at),
    organization_id: (r.organization_id as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    channel: (r.channel as string | null) ?? null,
    status: String(r.status),
    model_role: String(r.model_role),
  }));
}

// ============================================================================
// checkpoint — read-only
// ============================================================================

export async function takeCheckpoint(db: DbClient, manifest: RunManifest, label: string, now = new Date()): Promise<RankingCheckpoint> {
  const pilot = await readPilot(db, manifest.organizationId);
  const containment = {} as Record<ContainmentTable, ReturnType<typeof fingerprint>>;
  for (const table of CONTAINMENT_TABLES) containment[table] = fingerprint(await readAll(db, table));
  return {
    label,
    takenAt: now.toISOString(),
    flags: {
      relationshipOps: await flagEnabled(db, manifest.organizationId, "relationship_ops"),
      contextualRanking: await flagEnabled(db, manifest.organizationId, RANKING_FLAG),
    },
    cases: pilot.cases.map((c) => ({
      id: String(c.id),
      assigned_to_user_id: (c.assigned_to_user_id as string | null) ?? null,
      runtime_authority: (c.runtime_authority as string | null) ?? null,
    })),
    citable: citableByCase(pilot),
    mustSurface: mustSurfaceByCase(manifest.organizationId, pilot, now),
    containment,
    rankingUsage: await readRankingUsage(db),
    portfolioToolCalls: await readPortfolioToolCalls(db, manifest.advisorUserId),
  };
}

// ============================================================================
// activate / restore — the bounded flag activation (SL-1's pattern)
// ============================================================================

/**
 * Records the flag exactly as found, writes the manifest, and only then turns
 * the ranking on for this run. The manifest is on disk before the write, so a
 * crash between the two can still be restored against observed state.
 */
export async function phaseActivateRanking(
  db: DbClient,
  args: { organizationId: string; advisorUserId: string; run: string; manifestPath: string },
  now = new Date()
): Promise<RunManifest> {
  const prior = await getOrganizationFlag(db, args.organizationId, RANKING_FLAG);
  const manifest: RunManifest = {
    run: args.run,
    organizationId: args.organizationId,
    advisorUserId: args.advisorUserId,
    flagPrior: prior
      ? { present: true, enabled: prior.enabled, valueText: prior.value_text ?? null }
      : { present: false, enabled: false, valueText: null },
    activatedAt: now.toISOString(),
    seededCaseId: null,
  };
  writeFileSync(args.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await setOrganizationFlag(db, { organizationId: args.organizationId, flagKey: RANKING_FLAG, enabled: true });
  return manifest;
}

/** Puts the flag back exactly as the manifest recorded it. */
export async function phaseRestoreRanking(db: DbClient, manifest: RunManifest): Promise<string> {
  if (!manifest.flagPrior.present) {
    await deleteOrganizationFlag(db, { organizationId: manifest.organizationId, flagKey: RANKING_FLAG });
    return "flag row removed - restored to absent, exactly as found";
  }
  await setOrganizationFlag(db, {
    organizationId: manifest.organizationId,
    flagKey: RANKING_FLAG,
    enabled: manifest.flagPrior.enabled,
    valueText: manifest.flagPrior.valueText,
  });
  return `restored to enabled=${manifest.flagPrior.enabled}`;
}

// ============================================================================
// seed — optional, one controlled Case, canonical write paths
// ============================================================================

/**
 * The deterministic proposal the controlled seed runs the REAL supervisor
 * with. Wholly synthetic. It leaves a contextual situation — a recorded human
 * need the ranking may judge — and no governed predicate: `wait` proposes no
 * work and no commitment, and the Case stays under `legacy` authority.
 */
export function seedJudge(): NextWorkJudge {
  return {
    // A stub: the record will say `model_id: null`, never a model's name.
    modelId: null,
    async propose() {
      return {
        posture: "wait",
        diagnosis:
          "Semilla controlada SL-12: el prospecto pidió hablar hoy con una persona sobre cómo combinar su crédito Infonavit con uno bancario; si no, buscará otro asesor.",
        rationale: "Semilla controlada SL-12 (sin modelo): Gu no puede asesorar sobre financiamiento.",
        insufficient_evidence: false,
        capability_gap: "asesoría de financiamiento",
        proposed_work: [],
        commitments: [],
        reconsider_in_hours: 24,
      };
    },
  };
}

export async function phaseSeed(db: DbClient, manifest: RunManifest, now = new Date()): Promise<string> {
  const { data: existing, error } = await db
    .from("operational_cases")
    .select("id")
    .eq("organization_id", manifest.organizationId)
    .eq("context_jsonb->>sl12_run", manifest.run);
  if (error) throw error;
  if ((existing ?? []).length > 0) throw new Error(`run "${manifest.run}" already has a controlled Case. Seed once per run.`);

  const caseType = await getGlobalOperationalCaseTypeBySlug(db, LEAD_OPPORTUNITY_CASE_TYPE);
  const definition = await getLatestPublishedDefinitionForUser(db, manifest.advisorUserId, LEAD_OPPORTUNITY_CASE_TYPE);
  if (!caseType || !definition) throw new Error("lead_opportunity type or published definition missing");

  const opCase = await createOperationalCase(db, {
    userId: manifest.advisorUserId,
    caseTypeId: caseType.id,
    caseType: LEAD_OPPORTUNITY_CASE_TYPE,
    organizationId: manifest.organizationId,
    // TD-3's default for a relationship Case; nothing moves authority.
    runtimeAuthority: "legacy",
    status: "active",
    currentStep: null,
    nextActionAt: null,
    context: {
      scenario_kind: SCENARIO_KIND,
      sl12_run: manifest.run,
      title: "Semilla controlada SL-12 — una necesidad humana registrada, sin predicado gobernado",
      governing: "Slice Plan SL-12 RS-2 evidence obligations; SA-12.12",
    },
    workflowDefinition: { id: definition.id, version: definition.version },
  });
  await insertCaseFact(db, {
    userId: manifest.advisorUserId,
    caseId: opCase.id,
    factKey: "opportunity.objective",
    value: { objective: "Semilla controlada SL-12: primera casa con crédito", category: "buy_residential" },
    sourceKind: "derived",
    sourceRef: `sl12_verifier:${manifest.run}`,
  });
  const result = await runSupervisorWake({
    db,
    organizationId: manifest.organizationId,
    userId: manifest.advisorUserId,
    caseId: opCase.id,
    wake: { reason: "manual", key: buildWakeKey.manual(`sl12-seed:${manifest.run}`) },
    judge: seedJudge(),
    availableCapabilities: [],
    now,
  });
  if (result.status !== "reconsidered") throw new Error(`the canonical reconsideration did not run: ${JSON.stringify(result)}`);
  if (result.record.proposed_work_ids.length > 0 || result.commitments.length > 0) {
    throw new Error("the seed left work or a commitment — it must leave no governed predicate");
  }
  return opCase.id;
}

// ============================================================================
// snippets — for the advisor's own page
// ============================================================================

export function probeSnippet(args: {
  supabaseUrl: string;
  publishableKey: string;
  projectRef: string;
  otherOrganizationId: string;
  otherUserId: string;
}): string {
  return `/* SL-12 RS-2 cross-user probe — run in the advisor's signed-in page. It reads,
   with THAT session, another Organization's Cases and another user's
   presentation state, and returns only status codes and row counts. The
   session token is read and used inside the page and never leaves it. */
(async () => {
  const name = "sb-${args.projectRef}-auth-token";
  const parts = document.cookie.split("; ").map((c) => c.split("=")).filter(([k]) => k === name || k.startsWith(name + "."));
  parts.sort(([a], [b]) => (a.split(".")[1] ?? "0") - (b.split(".")[1] ?? "0"));
  let raw = decodeURIComponent(parts.map(([, ...v]) => v.join("=")).join(""));
  if (raw.startsWith("base64-")) raw = atob(raw.slice(7).replace(/-/g, "+").replace(/_/g, "/"));
  const token = JSON.parse(raw).access_token;
  const read = async (target, query) => {
    const res = await fetch("${args.supabaseUrl}/rest/v1/" + query, { headers: { apikey: "${args.publishableKey}", Authorization: "Bearer " + token } });
    const body = await res.json().catch(() => null);
    return { target, status: res.status, rows: Array.isArray(body) ? body.length : 0 };
  };
  return JSON.stringify({
    attempted: true,
    reads: [
      await read("other_organization_cases", "operational_cases?select=id&organization_id=eq.${args.otherOrganizationId}"),
      await read("other_user_presentation", "portfolio_presentation_state?select=id&user_id=eq.${args.otherUserId}"),
    ],
  });
})()`;
}

// ============================================================================
// verify — read-only
// ============================================================================

export async function phaseVerify(
  db: DbClient,
  manifest: RunManifest,
  args: {
    t0: RankingCheckpoint;
    t1: RankingCheckpoint;
    captures: { organizationWork: PageCapture; myWork: PageCapture; chatAnswer: string };
    probe: (ProbeResult & { how?: string }) | null;
    json?: string;
  }
): Promise<{ ok: boolean; checks: HostedCheck[] }> {
  const allCases = await readAll(db, "operational_cases");
  const otherOrganizationCaseIds = allCases
    .filter((row) => row.organization_id != null && row.organization_id !== manifest.organizationId)
    .map((row) => String(row.id));
  const otherUserPresentationRows = (await readAll(db, "portfolio_presentation_state")).filter(
    (row) => row.organization_id === manifest.organizationId && row.user_id !== manifest.advisorUserId
  ).length;

  const checks = evaluateRankingEvidence({
    organizationId: manifest.organizationId,
    advisorUserId: manifest.advisorUserId,
    t0: args.t0,
    t1: args.t1,
    captures: args.captures,
    otherOrganizationCaseIds,
    otherUserPresentationRows,
    probe: args.probe,
  });
  const ok = allPassed(checks);
  if (args.json) {
    const usage = args.t1.rankingUsage.filter((u) => !args.t0.rankingUsage.some((b) => b.id === u.id));
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          slice: "SL-12",
          releaseScope: "RS-2",
          run: manifest.run,
          organization: redact(manifest.organizationId),
          advisor: redact(manifest.advisorUserId),
          seededCase: redact(manifest.seededCaseId),
          topology:
            "application code executed by the operator process against hosted staging persistence, the model called from that process; no deployed Gu OS runtime",
          flag: { key: RANKING_FLAG, prior: manifest.flagPrior, activatedAt: manifest.activatedAt, scope: "this run only" },
          legacySourceReads: 0,
          legacySourceWrites: 0,
          checkpoints: [args.t0, args.t1].map((cp) => ({
            label: cp.label,
            takenAt: cp.takenAt,
            flags: cp.flags,
            cases: cp.cases.length,
            mustSurface: Object.values(cp.mustSurface).filter((p) => p.length > 0).length,
            containment: cp.containment,
            rankingUsageRows: cp.rankingUsage.length,
            portfolioToolCalls: cp.portfolioToolCalls.length,
          })),
          session: {
            rankingCalls: usage.length,
            rankingCallsOk: usage.filter((u) => u.status === "ok").length,
          },
          captures: {
            organizationWork: captureDigest(args.captures.organizationWork),
            myWork: captureDigest(args.captures.myWork),
            chatAnswer: captureDigest(args.captures.chatAnswer),
          },
          citableKinds: CITABLE_KINDS,
          otherOrganizationCases: otherOrganizationCaseIds.length,
          otherUserPresentationRows,
          probe: args.probe,
          checks,
          passed: ok,
          notExercised: [
            "the model's judgment on the production distribution (the eval, SA-12.6, owns the judgment)",
            "an owner or org_admin session",
            "Telegram or voice (excluded; the tool refuses without a web session)",
            "deployment infrastructure, a hosted URL, production build or deployment, domain/CDN, scaling, production operation",
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
  return { ok, checks };
}

// ============================================================================

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const phase = parseNamed(argv, "--phase");
  const phases = ["preflight", "activate-ranking", "seed", "checkpoint", "snippets", "verify", "restore-ranking"];
  if (!phases.includes(phase ?? "")) throw new Error(`--phase <${phases.join("|")}> is required.`);
  const target = resolveTarget(parseTargetArgs(argv));
  assertBinding(target);
  console.log(describeTarget(target));
  console.log(`phase: ${phase}`);
  console.log("legacy source: NOT REACHED\n");
  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error("FAIL CLOSED - GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL are required.");
  }
  const db = createClient(target.supabaseUrl, target.serviceRoleKey) as unknown as DbClient;

  if (phase === "preflight" || phase === "activate-ranking") {
    const organizationId = parseNamed(argv, "--organization");
    const advisorUserId = parseNamed(argv, "--advisor-user");
    if (!organizationId || !advisorUserId) throw new Error("--organization and --advisor-user are required.");
    // Preconditions: read and reported, never configured here.
    const organization = await getOrganizationById(db, organizationId);
    const membership = await getActiveMembership(db, organizationId, advisorUserId);
    const ops = await getOrganizationFlag(db, organizationId, "relationship_ops");
    const mode = await getOrganizationFlag(db, organizationId, "relationship_admission_mode");
    const ranking = await getOrganizationFlag(db, organizationId, RANKING_FLAG);
    const problems = [
      !organization && "the Organization does not resolve",
      membership?.role !== "advisor" && "the declared user is not an active advisor of the Organization",
      ops?.enabled !== true && "relationship_ops is not enabled (a separate authorized change; this run never sets it)",
      (mode?.enabled !== true || mode.value_text !== "shadow") && "the Organization is not in the shadow stage",
    ].filter(Boolean) as string[];
    if (phase === "preflight") {
      const pilot = await readPilot(db, organizationId);
      const floor = Object.values(mustSurfaceByCase(organizationId, pilot, new Date())).filter((p) => p.length > 0).length;
      const { data: setting } = await db
        .from("user_tool_settings")
        .select("enabled")
        .eq("user_id", advisorUserId)
        .eq("tool_id", PORTFOLIO_TOOL)
        .maybeSingle();
      const others = (await readAll(db, "operational_cases")).filter(
        (row) => row.organization_id != null && row.organization_id !== organizationId
      ).length;
      console.log(`  organization ${redact(organizationId)} · advisor ${redact(advisorUserId)}`);
      console.log(`  ${RANKING_FLAG}: ${ranking ? `present, enabled=${ranking.enabled}` : "absent"}`);
      console.log(`  ${PORTFOLIO_TOOL} for the advisor: ${(setting as { enabled?: boolean } | null)?.enabled === true ? "enabled" : "not enabled"}`);
      console.log(`  pilot Cases: ${pilot.cases.length} · must-surface now: ${floor} · other-Organization Cases: ${others}`);
      console.log(problems.length === 0 ? "\n  preflight: ready" : `\n  preflight FAILED:\n  - ${problems.join("\n  - ")}`);
      if (problems.length > 0) process.exit(1);
      return;
    }
    if (problems.length > 0) throw new Error(`preflight failed, nothing written:\n  - ${problems.join("\n  - ")}`);
    if (!argv.includes("--acknowledge-flag-write")) {
      throw new Error(
        `--acknowledge-flag-write is required: this sets ${RANKING_FLAG} on for the pilot, for this run only. ` +
          "Run it only after SA-12.6 is satisfied (TD-9 v2) and the human authorizes it."
      );
    }
    const run = parseNamed(argv, "--run");
    const manifestPath = parseNamed(argv, "--manifest");
    if (!run || !manifestPath) throw new Error("--run and --manifest are required.");
    const manifest = await phaseActivateRanking(db, { organizationId, advisorUserId, run, manifestPath });
    console.log(`  ${RANKING_FLAG} enabled for run "${run}" (prior: ${manifest.flagPrior.present ? `present, enabled=${manifest.flagPrior.enabled}` : "absent"})`);
    console.log(`  manifest (raw ids, keep out of the repo): ${manifestPath}`);
    return;
  }

  const manifestPath = parseNamed(argv, "--manifest");
  if (!manifestPath) throw new Error("--manifest <run.json> is required.");
  const manifest = readJson<RunManifest>(manifestPath);

  if (phase === "restore-ranking") {
    if (!argv.includes("--acknowledge-flag-write")) throw new Error("--acknowledge-flag-write is required to restore the flag.");
    console.log(`  ${await phaseRestoreRanking(db, manifest)}`);
    return;
  }

  if (phase === "seed") {
    if (!argv.includes("--acknowledge-durable-write")) {
      throw new Error(
        "--acknowledge-durable-write is required: this creates ONE controlled Organization Case, its objective " +
          "fact and one supervisor reconsideration through the canonical write paths. Run it only if the human " +
          "authorizes it because the pilot's Cases carry no contextual situation to rank."
      );
    }
    const caseId = await phaseSeed(db, manifest);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, seededCaseId: caseId }, null, 2) + "\n", "utf8");
    console.log(`  seeded case ${redact(caseId)} — no governed predicate; the manifest records it`);
    return;
  }

  if (phase === "checkpoint") {
    const label = parseNamed(argv, "--label");
    const out = parseNamed(argv, "--out");
    if (!label || !out) throw new Error("--label <t0|t1> and --out are required.");
    const cp = await takeCheckpoint(db, manifest, label);
    writeFileSync(out, JSON.stringify(cp, null, 2) + "\n", "utf8");
    console.log(
      `  checkpoint ${label}: ${cp.cases.length} pilot Case(s), ${Object.values(cp.mustSurface).filter((p) => p.length > 0).length} must-surface, ` +
        `${cp.rankingUsage.length} ranking usage row(s), ${cp.portfolioToolCalls.length} ${PORTFOLIO_TOOL} call(s)`
    );
    console.log(`  written (ids only, keep out of the repo): ${out}`);
    return;
  }

  if (phase === "snippets") {
    const otherUserId = parseNamed(argv, "--other-user");
    if (!otherUserId || otherUserId === manifest.advisorUserId) {
      throw new Error("--other-user <uuid> is required and must not be the advisor.");
    }
    if (!target.publishableKey) throw new Error("the publishable key is required for the probe.");
    const other = (await readAll(db, "operational_cases")).find(
      (row) => row.organization_id != null && row.organization_id !== manifest.organizationId
    );
    if (!other) throw new Error("no other Organization holds a Case — the cross-user attempt would not be exercised.");
    console.log("— page capture (run in each /portfolio view of the advisor's page) —\n");
    console.log(CAPTURE_SNIPPET);
    console.log("\n— cross-user probe (run once in the advisor's page) —\n");
    console.log(
      probeSnippet({
        supabaseUrl: target.supabaseUrl,
        publishableKey: target.publishableKey,
        projectRef: target.projectRef,
        otherOrganizationId: String(other.organization_id),
        otherUserId,
      })
    );
    return;
  }

  // verify
  const [t0Path, t1Path] = (parseNamed(argv, "--checkpoints") ?? "").split(",").filter(Boolean);
  const captures = parseNamed(argv, "--captures");
  if (!t0Path || !t1Path || !captures) throw new Error("--checkpoints t0.json,t1.json and --captures <dir> are required.");
  const probePath = parseNamed(argv, "--probe");
  const { ok, checks } = await phaseVerify(db, manifest, {
    t0: readJson<RankingCheckpoint>(t0Path),
    t1: readJson<RankingCheckpoint>(t1Path),
    captures: {
      organizationWork: readJson<PageCapture>(path.join(captures, "organization-work.json")),
      myWork: readJson<PageCapture>(path.join(captures, "my-work.json")),
      chatAnswer: readFileSync(path.join(captures, "chat-answer.txt"), "utf8"),
    },
    probe: probePath ? readJson<ProbeResult>(probePath) : null,
    json: parseNamed(argv, "--json"),
  });
  console.log("");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  [${c.assertion}] ${c.label}${c.detail ? ` - ${c.detail}` : ""}`);
  console.log("");
  if (!ok) {
    console.error("SL-12 hosted verification FAILED — see the checks above.");
    process.exit(1);
  }
  console.log("SL-12 hosted verification passed.");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
