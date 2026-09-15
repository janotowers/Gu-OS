/**
 * Contextual-ranking eval — R1 SL-12 (Portfolio v2; Technical Plan TD-9 v2).
 *
 * Runs the REAL ranking judge on each recorded scenario, passes its answer
 * through the SAME deterministic merge the Portfolio uses, and scores the final
 * Needs Attention order. The bars live in the scenario file, not here, so they
 * cannot be adjusted from the runner. They were proposed and frozen before
 * implementation and ratified by the Accountable, also before implementation,
 * for SL-12's RS-2 only (Slice Plan v1.29 §4, v1.30).
 *
 * THREE BARS, BECAUSE THE ERRORS ARE NOT EQUALLY COSTLY.
 *
 *   * `failure_rate_bar` — ordinary semantic accuracy: no judgment, a need the
 *     scenario says should be admitted left out, or a stated pair out of order.
 *   * `unsupported_attention_bar` — ZERO. Admitting a Case the scenario says
 *     must stay out is interrupting a person without cause (S4 invariant 2).
 *   * `floor_violation_bar` — ZERO. A governed Case missing from the final
 *     order. The merge makes it impossible; the eval measures it anyway.
 *
 * WHAT THIS DOES NOT MEASURE: whether a person would have wanted the
 * interruption, or behavior on the production distribution. The scenarios are
 * synthetic; their `recorded.gap` says so.
 *
 * Requires a real model. Without `OPENROUTER_API_KEY` it refuses rather than
 * reporting a vacuous pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RankingInput, RankingJudgeResult } from "../contract";
import { createOpenRouterRankingJudge } from "../judge";
import { frameFromInput, mergeRanking, needsAttentionOrder } from "../merge";
import { RANKING_TIMEOUT_MS } from "../contract";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Loads `apps/web/.env.local` for unset variables only (same as the supervisor eval). */
function loadWebEnvLocal(): void {
  const envPath = path.resolve(__dirname, "..", "..", "..", "..", "..", ".env.local");
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export interface RankingScenario {
  id: string;
  label: string;
  covers?: string[];
  rubric: string;
  governed: string[];
  expect_contextual: string[];
  must_not_admit: string[];
  order_pairs: Array<[string, string]>;
  input: RankingInput;
}

export interface RankingEvalSet {
  failure_rate_bar: number;
  unsupported_attention_bar: number;
  floor_violation_bar: number;
  batches: number;
  runs_per_batch: number;
  scenarios: RankingScenario[];
}

export function loadRankingEvalSet(): RankingEvalSet {
  return JSON.parse(
    readFileSync(path.join(__dirname, "ranking-scenarios.json"), "utf8")
  ) as RankingEvalSet;
}

export interface RankingScenarioScore {
  violations: string[];
  unsupported: string[];
  floor: string[];
  order: string[];
  admitted: string[];
}

/**
 * Scores one scenario from the judge's raw result, through the Portfolio's own
 * deterministic merge — so what is scored is what a person would see.
 */
export function scoreRankingScenario(
  scenario: RankingScenario,
  judged: RankingJudgeResult
): RankingScenarioScore {
  if (!judged.ok) {
    return {
      violations: [`no judgment (${judged.reason})`],
      unsupported: [],
      floor: [],
      order: [],
      admitted: [],
    };
  }
  const frame = frameFromInput(scenario.input);
  const merged = mergeRanking(frame, judged.output);
  const order = needsAttentionOrder(frame, merged);
  const admitted = [...merged.contextual.keys()];
  const violations: string[] = [];
  for (const ref of scenario.expect_contextual) {
    if (!merged.contextual.has(ref)) violations.push(`expected ${ref} to be admitted; it was not`);
  }
  for (const [higher, lower] of scenario.order_pairs) {
    const a = order.indexOf(higher);
    const b = order.indexOf(lower);
    if (a < 0 || b < 0 || a > b) violations.push(`expected ${higher} above ${lower}; order was ${order.join(" > ") || "(empty)"}`);
  }
  const unsupported = scenario.must_not_admit
    .filter((ref) => merged.contextual.has(ref))
    .map((ref) => `admitted ${ref} without a supported human need`);
  const floor = scenario.governed
    .filter((ref) => !order.includes(ref))
    .map((ref) => `governed ${ref} missing from Needs Attention`);
  return { violations, unsupported, floor, order, admitted };
}

interface RunOutcome {
  index: number;
  failures: number;
  failureRate: number;
  unsupported: number;
  floorViolations: number;
  held: boolean;
  modelId: string | null;
  results: Array<{ id: string; passed: boolean } & RankingScenarioScore>;
}

async function runOnce(set: RankingEvalSet, index: number, verbose: boolean): Promise<RunOutcome> {
  const judge = createOpenRouterRankingJudge();
  const results: RunOutcome["results"] = [];
  for (const scenario of set.scenarios) {
    let judged: RankingJudgeResult;
    try {
      judged = await judge.rank(scenario.input, AbortSignal.timeout(RANKING_TIMEOUT_MS));
    } catch {
      judged = { ok: false, reason: "model_error" };
    }
    const score = scoreRankingScenario(scenario, judged);
    const passed = score.violations.length === 0 && score.unsupported.length === 0 && score.floor.length === 0;
    results.push({ id: scenario.id, passed, ...score });
    if (verbose || !passed) {
      console.log(
        `  ${passed ? "ok  " : "FAIL"} ${scenario.id} — order ${score.order.join(" > ") || "(empty)"}` +
          (score.unsupported.length > 0 ? "  << UNSUPPORTED ATTENTION" : "") +
          (score.floor.length > 0 ? "  << FLOOR" : "")
      );
      for (const line of [...score.violations, ...score.unsupported, ...score.floor]) console.log(`       ${line}`);
    }
  }
  const failures = results.filter((r) => !r.passed).length;
  const unsupported = results.filter((r) => r.unsupported.length > 0).length;
  const floorViolations = results.filter((r) => r.floor.length > 0).length;
  const failureRate = failures / results.length;
  return {
    index,
    failures,
    failureRate,
    unsupported,
    floorViolations,
    held:
      failureRate <= set.failure_rate_bar &&
      unsupported <= set.unsupported_attention_bar &&
      floorViolations <= set.floor_violation_bar,
    modelId: judge.modelId,
    results,
  };
}

async function main(): Promise<void> {
  loadWebEnvLocal();
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("eval:portfolio-ranking requires OPENROUTER_API_KEY — the point is to exercise a real model.");
    process.exit(1);
  }
  const set = loadRankingEvalSet();
  const runCount = Math.max(1, Number(process.env.PORTFOLIO_RANKING_EVAL_RUNS ?? 1));
  const runs: RunOutcome[] = [];
  for (let i = 1; i <= runCount; i += 1) {
    if (runCount > 1) console.log(`\n— run ${i} of ${runCount} —`);
    runs.push(await runOnce(set, i, runCount === 1));
  }
  const heldRuns = runs.filter((r) => r.held).length;
  console.log("");
  console.log(`scenarios:          ${set.scenarios.length} × ${runCount} run(s)`);
  console.log(`failure rate:       ${runs.map((r) => `${(r.failureRate * 100).toFixed(1)}%`).join(", ")} — bar ${(set.failure_rate_bar * 100).toFixed(0)}%`);
  console.log(`unsupported:        ${runs.map((r) => r.unsupported).join(", ")} — bar ${set.unsupported_attention_bar}`);
  console.log(`floor violations:   ${runs.map((r) => r.floorViolations).join(", ")} — bar ${set.floor_violation_bar}`);
  console.log(`runs holding:       ${heldRuns} of ${runCount}`);
  const failsPerScenario = new Map<string, number>();
  for (const run of runs) for (const r of run.results) if (!r.passed) failsPerScenario.set(r.id, (failsPerScenario.get(r.id) ?? 0) + 1);
  if (failsPerScenario.size > 0) {
    console.log("\nper-scenario failures (of runs):");
    for (const [id, count] of [...failsPerScenario].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${id}: ${count}/${runCount}${count === runCount ? "  (systematic)" : ""}`);
    }
  }
  const artifactPath = process.env.PORTFOLIO_RANKING_EVAL_JSON;
  if (artifactPath) {
    writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          model: { source: "the judge that ran each pass (PortfolioRankingJudge.modelId)", ids: [...new Set(runs.map((r) => r.modelId))] },
          failure_rate_bar: set.failure_rate_bar,
          unsupported_attention_bar: set.unsupported_attention_bar,
          floor_violation_bar: set.floor_violation_bar,
          scenarios: set.scenarios.length,
          runCount,
          runsHoldingAllBars: heldRuns,
          runs: runs.map((run) => ({
            run: run.index,
            failures: run.failures,
            failureRate: run.failureRate,
            unsupported: run.unsupported,
            floorViolations: run.floorViolations,
            held: run.held,
            results: run.results,
          })),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(`artifact:           ${artifactPath}`);
  }
  if (heldRuns < runCount) {
    console.error(`\nFAILED: ${runCount - heldRuns} of ${runCount} run(s) breached a bar. The bars are not moved to fit a result.`);
    process.exit(1);
  }
  console.log(`\nportfolio ranking eval: every bar held in all ${runCount} run(s).`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
