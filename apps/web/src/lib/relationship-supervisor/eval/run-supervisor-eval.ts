/**
 * Next-work judgment eval — R1 SL-4.
 *
 * Runs the REAL judge against the recorded scenario set and scores it against
 * bars that were stated before the set was ever run (Methodology §14.1; SL-4
 * Definition of Done). The bars live in the scenario file, not here, so they
 * cannot be quietly adjusted from the runner.
 *
 * TWO BARS, BECAUSE THE TWO ERROR DIRECTIONS ARE NOT EQUALLY COSTLY.
 *
 *   * `failure_rate_bar` — ordinary semantic accuracy: did the supervisor
 *     choose a defensible posture for the situation?
 *   * `fabricated_work_bar` — ZERO. Manufactured work, a manufactured
 *     commitment, or a confident judgment on evidence the scenario says is too
 *     thin. S2's quality bar is built on deliberate no-op being a correct
 *     answer, so a supervisor that invents activity to look busy fails this
 *     Slice however accurate the rest of its judgments are.
 *
 * SCORING ACCEPTS MORE THAN ONE ANSWER, ON PURPOSE. S2 AC-31 says selection
 * must be "explainable via current context; no universal score required", so
 * several scenarios list more than one defensible posture and any of them
 * passes. What is scored strictly is the *rubric* conditions each scenario
 * names — those are the invariants, not the posture label.
 *
 * WHAT THIS RUN DOES NOT MEASURE, and must not be read as measuring:
 * multi-day posture coherence. A single-turn eval sees one situation at a time.
 * SA-4.3 is hosted RS-2 evidence over elapsed real time.
 *
 * Requires a real model. A run without `OPENROUTER_API_KEY` would measure
 * nothing, so it refuses rather than reporting a vacuous pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenRouterNextWorkJudge,
  type NextWorkProposal,
  type SupervisorJudgeInput,
} from "../next-work-judge";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads `apps/web/.env.local` when the key is not already exported.
 *
 * Next.js reads that file; `tsx` does not, so without this the runner would
 * report an environment blocker on a machine that is in fact configured. Only
 * fills variables that are unset, so an explicit export always wins.
 */
function loadWebEnvLocal(): void {
  const envPath = path.resolve(__dirname, "..", "..", "..", "..", ".env.local");
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

interface Scenario {
  id: string;
  label: string;
  covers?: string[];
  rubric: string;
  input: SupervisorJudgeInput;
  acceptable_postures: string[];
  must_propose_work?: boolean;
  must_not_propose_work?: boolean;
  must_detect_commitment?: boolean;
  /** No commitment exists in this situation at all. Reporting one is FABRICATION. */
  must_not_detect_commitment?: boolean;
  /**
   * A commitment exists but is already tracked. Repeating it is REDUNDANCY —
   * an ordinary semantic failure, not fabrication.
   *
   * The distinction is the one the frozen bar itself draws: `fabricated_work_bar`
   * is zero because "one fabricated commitment silently misrepresents a promise
   * the brokerage never made". A re-listed commitment misrepresents nothing —
   * the promise is real and already recorded, and `recordCommitments` is
   * idempotent on its key, so nothing durable is created twice. Scoring it as
   * fabrication would let a redundancy breach a bar written for invention.
   */
  must_not_repeat_commitment?: boolean;
  must_report_capability_gap?: boolean;
  must_report_insufficient_evidence?: boolean;
  /** The judge must never suggest reaching the prospect. */
  must_not_propose_outbound?: boolean;
  expected_commitment_actor?: string;
}

interface EvalSet {
  failure_rate_bar: number;
  fabricated_work_bar: number;
  scenarios: Scenario[];
}

const evalSet = JSON.parse(
  readFileSync(path.join(__dirname, "supervisor-scenarios.json"), "utf8")
) as EvalSet;

/**
 * Words that would indicate the judge proposed reaching the prospect.
 *
 * Only used on scenarios that declare `must_not_propose_outbound`, and only as
 * a *detector of a violation*, never as the judgment itself — the posture
 * vocabulary already makes an effect unproposable, so this catches an internal
 * work item whose stated purpose is really an outbound message.
 */
const OUTBOUND_MARKERS =
  /\b(send|message|whatsapp|contact|reach out|escribir|mensaje|contactar|enviar mensaje)\b/i;

interface ScenarioResult {
  id: string;
  label: string;
  proposal: NextWorkProposal | null;
  violations: string[];
  fabrication: string[];
  passed: boolean;
}

function scoreScenario(
  scenario: Scenario,
  proposal: NextWorkProposal | null
): { violations: string[]; fabrication: string[] } {
  const violations: string[] = [];
  const fabrication: string[] = [];

  if (!proposal) {
    // A missing judgment is a failure of this eval — the executor handles it
    // safely at runtime under SA-4.11, but a run that cannot judge measures
    // nothing about judgment.
    violations.push("no judgment was produced");
    return { violations, fabrication };
  }

  if (!scenario.acceptable_postures.includes(proposal.posture)) {
    violations.push(
      `posture ${proposal.posture} not in [${scenario.acceptable_postures.join(", ")}]`
    );
  }

  const hasWork = proposal.proposed_work.length > 0;
  if (scenario.must_propose_work && !hasWork) {
    violations.push("expected useful work to be proposed, none was");
  }
  if (scenario.must_not_propose_work && hasWork) {
    // Manufactured activity in a situation the set says has none.
    fabrication.push(
      `proposed work where none is warranted: ${proposal.proposed_work
        .map((w) => w.work_type)
        .join(", ")}`
    );
  }

  const hasCommitment = proposal.commitments.length > 0;
  if (scenario.must_detect_commitment && !hasCommitment) {
    violations.push("expected a commitment to be detected, none was");
  }
  if (scenario.must_not_detect_commitment && hasCommitment) {
    fabrication.push(
      `invented a commitment: ${proposal.commitments
        .map((c) => c.expected_outcome)
        .join(" | ")}`
    );
  }
  if (scenario.must_not_repeat_commitment && hasCommitment) {
    violations.push(
      `re-listed an already-tracked commitment: ${proposal.commitments
        .map((c) => c.expected_outcome)
        .join(" | ")}`
    );
  }
  if (scenario.expected_commitment_actor && hasCommitment) {
    const actors = proposal.commitments.map((c) => c.actor);
    if (!actors.includes(scenario.expected_commitment_actor as never)) {
      violations.push(
        `commitment actor ${actors.join(",")} ≠ ${scenario.expected_commitment_actor}`
      );
    }
  }

  if (scenario.must_report_capability_gap && !proposal.capability_gap) {
    violations.push("expected a capability gap to be named, none was");
  }
  if (scenario.must_report_insufficient_evidence && !proposal.insufficient_evidence) {
    fabrication.push(
      "produced a confident judgment on evidence the scenario states is too thin"
    );
  }

  if (scenario.must_not_propose_outbound) {
    const outbound = proposal.proposed_work.filter(
      (w) => OUTBOUND_MARKERS.test(w.work_type) || OUTBOUND_MARKERS.test(w.purpose)
    );
    if (outbound.length > 0) {
      fabrication.push(
        `proposed prospect-facing contact: ${outbound.map((w) => w.work_type).join(", ")}`
      );
    }
  }

  if (!proposal.rationale || proposal.rationale.trim().length < 10) {
    violations.push("no usable rationale — the judgment is not explainable");
  }

  return { violations, fabrication };
}

interface RunOutcome {
  index: number;
  results: ScenarioResult[];
  failures: number;
  failureRate: number;
  fabrications: number;
  noJudgment: number;
  held: boolean;
}

async function runOnce(index: number, verbose: boolean): Promise<RunOutcome> {
  const judge = createOpenRouterNextWorkJudge();
  const results: ScenarioResult[] = [];

  for (const scenario of evalSet.scenarios) {
    const proposal = await judge.propose(scenario.input);
    const { violations, fabrication } = scoreScenario(scenario, proposal);
    const passed = violations.length === 0 && fabrication.length === 0;
    results.push({
      id: scenario.id,
      label: scenario.label,
      proposal,
      violations,
      fabrication,
      passed,
    });

    if (verbose || !passed) {
      const mark = passed ? "ok  " : "FAIL";
      console.log(
        `  ${mark} ${scenario.id} — ${proposal ? proposal.posture : "null"}` +
          (fabrication.length > 0 ? "  << FABRICATION" : "")
      );
      for (const line of [...violations, ...fabrication]) {
        console.log(`       ${line}`);
      }
      if (!passed && proposal) {
        console.log(`       rationale: ${proposal.rationale}`);
      }
    }
  }

  const failures = results.filter((r) => !r.passed).length;
  const fabrications = results.filter((r) => r.fabrication.length > 0).length;
  const failureRate = failures / results.length;
  return {
    index,
    results,
    failures,
    failureRate,
    fabrications,
    noJudgment: results.filter((r) => r.proposal === null).length,
    held:
      failureRate <= evalSet.failure_rate_bar &&
      fabrications <= evalSet.fabricated_work_bar,
  };
}

async function main(): Promise<void> {
  loadWebEnvLocal();
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      "eval:supervisor requires OPENROUTER_API_KEY — the point of this run is to exercise a real model."
    );
    process.exit(1);
  }

  // Model-mediated behavior is not a single number, and one run cannot tell a
  // stable pass from a lucky one. `SUPERVISOR_EVAL_RUNS` repeats the whole set
  // and reports how many runs held the bars, which is the honest shape of the
  // evidence when the thing being measured is a judgment (Methodology §17.1 on
  // variance). Default 1, so an ordinary check stays cheap.
  const runCount = Math.max(1, Number(process.env.SUPERVISOR_EVAL_RUNS ?? 1));
  const runs: RunOutcome[] = [];

  for (let i = 1; i <= runCount; i += 1) {
    if (runCount > 1) console.log(`\n— run ${i} of ${runCount} —`);
    runs.push(await runOnce(i, runCount === 1));
  }

  const total = evalSet.scenarios.length;
  const heldRuns = runs.filter((r) => r.held).length;
  const rates = runs.map((r) => r.failureRate);

  console.log("");
  console.log(`scenarios:        ${total} × ${runCount} run(s)`);
  console.log(
    `failure rate:     ${rates
      .map((r) => `${(r * 100).toFixed(1)}%`)
      .join(", ")} — bar ${(evalSet.failure_rate_bar * 100).toFixed(0)}%`
  );
  console.log(
    `fabrications:     ${runs.map((r) => r.fabrications).join(", ")} — bar ${
      evalSet.fabricated_work_bar
    }`
  );
  const noJudgment = runs.reduce((sum, r) => sum + r.noJudgment, 0);
  if (noJudgment > 0) {
    console.log(
      `no judgment:      ${noJudgment} across all runs — counted as failures,` +
        ` since a missing judgment measures nothing about judgment`
    );
  }
  console.log(`runs holding:     ${heldRuns} of ${runCount}`);

  // Scenarios that fail in EVERY run are a systematic finding; ones that fail
  // in some are instability. Reporting them apart matters, because only the
  // first is something a prompt or a model change can be expected to fix.
  const failsPerScenario = new Map<string, number>();
  for (const run of runs) {
    for (const result of run.results) {
      if (!result.passed) {
        failsPerScenario.set(result.id, (failsPerScenario.get(result.id) ?? 0) + 1);
      }
    }
  }
  if (failsPerScenario.size > 0) {
    console.log("");
    console.log("per-scenario failures (of runs):");
    for (const [id, count] of [...failsPerScenario].sort((a, b) => b[1] - a[1])) {
      console.log(
        `  ${id}: ${count}/${runCount}${count === runCount ? "  (systematic)" : ""}`
      );
    }
  }

  const artifactPath = process.env.SUPERVISOR_EVAL_JSON;
  if (artifactPath) {
    // Outcomes and rationales only — the scenarios are synthetic, but the
    // artifact convention across R1 is that evidence carries no raw content it
    // does not need.
    writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          model:
            process.env.RELATIONSHIP_SUPERVISOR_MODEL_ID?.trim() ??
            "default (configuration)",
          failure_rate_bar: evalSet.failure_rate_bar,
          fabricated_work_bar: evalSet.fabricated_work_bar,
          scenarios: total,
          runCount,
          runsHoldingBothBars: heldRuns,
          runs: runs.map((run) => ({
            run: run.index,
            failures: run.failures,
            failureRate: run.failureRate,
            fabrications: run.fabrications,
            held: run.held,
            results: run.results.map((r) => ({
              id: r.id,
              posture: r.proposal?.posture ?? null,
              passed: r.passed,
              violations: r.violations,
              fabrication: r.fabrication,
              rationale: r.proposal?.rationale ?? null,
            })),
          })),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(`artifact:         ${artifactPath}`);
  }

  if (heldRuns < runCount) {
    console.error("");
    console.error(
      `FAILED: ${runCount - heldRuns} of ${runCount} run(s) breached a frozen bar.`
    );
    console.error(
      "The bars were stated before this set was first run and are not to be moved to fit a result."
    );
    process.exit(1);
  }

  console.log("");
  console.log(
    `supervisor eval: both frozen bars held in all ${runCount} run(s).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
