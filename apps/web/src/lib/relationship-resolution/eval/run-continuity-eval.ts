/**
 * Continuity-judgment eval — R1 SL-3.
 *
 * Runs the REAL judge against the recorded scenario set and scores it against a
 * bar that was stated before the set was ever run (Methodology §14.1; SL-3
 * Definition of Done). The bar lives in the scenario file, not here, so it
 * cannot be quietly adjusted from the runner.
 *
 * Two bars, because the two error directions are not equally costly:
 *
 *   * `failure_rate_bar` — overall semantic accuracy;
 *   * `false_merge_bar` — how many `distinct` pairs may be judged the same.
 *     Zero. The Slice's risk table is explicit that a false merge is worse than
 *     a missed one, because it conflates two real objectives.
 *
 * Requires a real model. A run without `OPENROUTER_API_KEY` would measure
 * nothing, so it refuses rather than reporting a vacuous pass.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenRouterContinuityJudge,
  type ContinuityJudgeInput,
  type ContinuityProposal,
} from "../continuity-judge";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads `apps/web/.env.local` when the key is not already exported.
 *
 * Next.js reads that file; `tsx` does not, so without this the runner would
 * report an environment blocker on a machine that is in fact configured. Only
 * fills variables that are unset, so an explicit export always wins.
 *
 * Inlined rather than shared with the SL-2 runner: these are standalone `tsx`
 * entry points, and an import edge between two eval runners for an env
 * bootstrap buys nothing.
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
  input: ContinuityJudgeInput;
  expected: {
    same_objective: boolean;
    /** Optional: asserted only when the scenario states it. */
    conflicting_facts?: boolean;
  };
  false_merge_trap?: boolean;
  note?: string;
}

interface EvalSet {
  failure_rate_bar: number;
  false_merge_bar: number;
  scenarios: Scenario[];
}

const evalSet = JSON.parse(
  readFileSync(path.join(__dirname, "continuity-scenarios.json"), "utf8")
) as EvalSet;

interface ScenarioResult {
  id: string;
  label: string;
  trap: boolean;
  proposal: ContinuityProposal | null;
  samenessMatch: boolean;
  conflictMatch: boolean;
  /** A `distinct` pair the judge called the same — the costly direction. */
  falseMerge: boolean;
  passed: boolean;
}

async function main(): Promise<void> {
  loadWebEnvLocal();
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      "eval:continuity requires OPENROUTER_API_KEY — the point of this run is to exercise a real model."
    );
    process.exit(1);
  }

  const judge = createOpenRouterContinuityJudge();
  const results: ScenarioResult[] = [];

  for (const scenario of evalSet.scenarios) {
    const proposal = await judge.judge(scenario.input);

    const samenessMatch =
      proposal?.same_objective === scenario.expected.same_objective;
    const conflictMatch =
      scenario.expected.conflicting_facts === undefined
        ? true
        : proposal?.conflicting_facts === scenario.expected.conflicting_facts;
    const falseMerge =
      scenario.expected.same_objective === false &&
      proposal?.same_objective === true;

    const passed = samenessMatch && conflictMatch;
    results.push({
      id: scenario.id,
      label: scenario.label,
      trap: scenario.false_merge_trap === true,
      proposal,
      samenessMatch,
      conflictMatch,
      falseMerge,
      passed,
    });

    const mark = passed ? "ok  " : "FAIL";
    const merge = falseMerge ? "  << FALSE MERGE" : "";
    console.log(
      `  ${mark} ${scenario.id} — said ${
        proposal === null ? "null" : String(proposal.same_objective)
      }, expected ${String(scenario.expected.same_objective)}${merge}`
    );
    if (!passed && proposal) {
      console.log(`       rationale: ${proposal.rationale}`);
    }
  }

  const total = results.length;
  const failures = results.filter((r) => !r.passed);
  const falseMerges = results.filter((r) => r.falseMerge);
  const failureRate = failures.length / total;
  const noJudgment = results.filter((r) => r.proposal === null);

  console.log("");
  console.log(`scenarios:        ${total}`);
  console.log(
    `failures:         ${failures.length} (${(failureRate * 100).toFixed(1)}%) ` +
      `— bar ${(evalSet.failure_rate_bar * 100).toFixed(0)}%`
  );
  console.log(
    `false merges:     ${falseMerges.length} — bar ${evalSet.false_merge_bar}` +
      ` (of which traps: ${falseMerges.filter((r) => r.trap).length})`
  );
  if (noJudgment.length > 0) {
    console.log(
      `no judgment:      ${noJudgment.length} — counted as failures, since a` +
        ` missing judgment cannot resolve anything`
    );
  }

  const rateHeld = failureRate <= evalSet.failure_rate_bar;
  const mergeHeld = falseMerges.length <= evalSet.false_merge_bar;

  if (!rateHeld || !mergeHeld) {
    console.error("");
    if (!rateHeld) console.error("FAILED: semantic failure rate above the frozen bar.");
    if (!mergeHeld) {
      console.error("FAILED: a distinct pair was judged the same objective.");
      for (const r of falseMerges) console.error(`  - ${r.id}: ${r.label}`);
    }
    console.error(
      "The bar was stated before this set was first run and is not to be moved to fit a result."
    );
    process.exit(1);
  }

  console.log("");
  console.log("continuity eval: both frozen bars held.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
