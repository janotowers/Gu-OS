/**
 * SAME-DAY BASELINE — SL-14's Definition of Done.
 *
 * It requires a same-day baseline whenever a later change altered the prompt.
 * SL-14 altered it for blocked situations only, so this measures what the
 * PRE-SL-14 judge does, TODAY, on the PRE-SL-14 scenarios, scored by the
 * CORRECTED verifier. Its whole purpose is attribution: it separates "SL-14
 * regressed an existing situation" from "this model varies on that situation",
 * which no amount of reasoning about the current run can settle.
 *
 * IT ESTABLISHES NOTHING ABOUT SL-14's BARS, in either direction. A baseline
 * failure does not license an SL-14 failure; it only says who owns it. SL-14's
 * own bars are measured by `eval:supervisor` and are not evaluated here.
 *
 * TWO BLOCKS, because attribution needs both and they answer different
 * questions:
 *
 *   A. THE DEFINITION OF DONE's baseline — the pre-SL-14 judge on the
 *      pre-SL-14 scenario set, exactly as both were frozen at `BASELINE_REF`.
 *      This is the drift measurement: it says what SL-4's own evidence would
 *      look like if it were produced today.
 *   B. THE ATTRIBUTION EXTENSION — the same pre-SL-14 judge on scenarios the
 *      current set carries that the baseline set does not, restricted to those
 *      whose Work list has nothing blocked. SA-14.1 requires their prompts to
 *      stay byte-identical to SL-4's, so the pre-SL-14 judge is the only thing
 *      that can say whether a failure there is SL-14's. THE BYTE-IDENTITY IS
 *      ASSERTED, not assumed: each one's prompt is built with the baseline
 *      judge and with the current judge and the two must be equal, and a
 *      scenario whose prompts differ is REFUSED rather than reported, because
 *      the pre-SL-14 judge would then be answering a different question.
 *
 * The base judge is written next to the real one for the length of the run, so
 * its own relative imports resolve, and removed again on exit.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  scoreScenario,
  evalArtifactModel,
} from "../apps/web/src/lib/relationship-supervisor/eval/run-supervisor-eval";
import { buildNextWorkPrompt as buildCurrentPrompt } from "../apps/web/src/lib/relationship-supervisor/next-work-judge";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const JUDGE_DIR = path.join(ROOT, "apps/web/src/lib/relationship-supervisor");
const BASE = process.env.BASELINE_REF ?? "2a12441";
const RUNS = Math.max(1, Number(process.env.SUPERVISOR_EVAL_RUNS ?? 5));

const JUDGE_REL = "apps/web/src/lib/relationship-supervisor/next-work-judge.ts";
const SET_REL = "apps/web/src/lib/relationship-supervisor/eval/supervisor-scenarios.json";

function loadEnvLocal(): void {
  try {
    for (const raw of readFileSync(path.join(ROOT, "apps/web/.env.local"), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0 || process.env[line.slice(0, i).trim()] !== undefined) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[line.slice(0, i).trim()] = v;
    }
  } catch {}
}

interface Scored {
  id: string;
  posture: string | null;
  passed: boolean;
  violations: string[];
  fabrication: string[];
  reask: string[];
  rationale: string | null;
}

interface BlockRun {
  run: number;
  failures: number;
  failureRate: number;
  fabrications: number;
  reasks: number;
  results: Scored[];
  modelId: string | null;
}

/** Nothing in this Work list is technically blocked, so SA-14.1 freezes its prompt. */
function hasNothingBlocked(scenario: { input: { workSummary?: readonly string[] } }): boolean {
  return !(scenario.input.workSummary ?? []).some((line) => /^\[w\d+\]/.test(String(line)));
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function measure(
  label: string,
  scenarios: ReadonlyArray<Record<string, unknown>>,
  makeJudge: () => { modelId: string | null; propose: (i: unknown) => Promise<unknown> }
): Promise<BlockRun[]> {
  const runs: BlockRun[] = [];
  console.log(`\n— ${label}: ${scenarios.length} scenario(s) × ${RUNS} run(s) —`);
  for (let r = 1; r <= RUNS; r += 1) {
    const judge = makeJudge();
    const results: Scored[] = [];
    for (const sc of scenarios) {
      const proposal = (await judge.propose((sc as { input: unknown }).input)) as never;
      const s = scoreScenario(sc as never, proposal);
      // The pre-SL-14 judge has no `recovery` field at all, so `blindRetry`
      // and `stranded` are structurally empty here; they are folded in anyway
      // so this scoring is literally the eval runner's, not a variant of it.
      const passed =
        s.violations.length === 0 &&
        s.fabrication.length === 0 &&
        s.reask.length === 0 &&
        s.blindRetry.length === 0 &&
        s.stranded.length === 0;
      results.push({
        id: String((sc as { id: unknown }).id),
        posture: (proposal as { posture?: string } | null)?.posture ?? null,
        passed,
        violations: s.violations,
        fabrication: s.fabrication,
        reask: s.reask,
        rationale: (proposal as { rationale?: string } | null)?.rationale ?? null,
      });
    }
    const failures = results.filter((x) => !x.passed).length;
    runs.push({
      run: r,
      failures,
      failureRate: failures / results.length,
      fabrications: results.filter((x) => x.fabrication.length > 0).length,
      reasks: results.filter((x) => x.reask.length > 0).length,
      results,
      modelId: judge.modelId,
    });
    const failed = results.filter((x) => !x.passed).map((x) => x.id);
    console.log(
      `  run ${r}: ${((failures / results.length) * 100).toFixed(1)}%` +
        `  fab=${runs[r - 1].fabrications}  reask=${runs[r - 1].reasks}  [${failed.join(", ")}]`
    );
  }
  return runs;
}

function report(label: string, runs: BlockRun[]): Record<string, number> {
  console.log(`\n${label}`);
  console.log(`  failure rate: ${runs.map((x) => (x.failureRate * 100).toFixed(1) + "%").join(", ")} — SL-4's bar 20%`);
  console.log(`  fabrications: ${runs.map((x) => x.fabrications).join(", ")} — bar 0`);
  console.log(`  re-asks:      ${runs.map((x) => x.reasks).join(", ")} — bar 0`);
  const perScenario: Record<string, number> = {};
  for (const run of runs) {
    for (const r of run.results) {
      if (!r.passed) perScenario[r.id] = (perScenario[r.id] ?? 0) + 1;
    }
  }
  const entries = Object.entries(perScenario).sort((a, b) => b[1] - a[1]);
  if (entries.length > 0) {
    console.log("  per-scenario failures (of runs):");
    for (const [id, n] of entries) {
      console.log(`    ${id}: ${n}/${RUNS}${n === RUNS ? "  (systematic)" : ""}`);
    }
  }
  return perScenario;
}

/**
 * ATTRIBUTION WITHOUT MODEL CALLS.
 *
 * The prose claim "SA-14.1 freezes this prompt, so SL-14 cannot own that
 * failure" is checkable, and a claim that can be checked should not be
 * asserted. `BASELINE_IDENTITY_ONLY=1` audits EVERY scenario in the current
 * set whose Work list has nothing blocked — not only the ones new to it — by
 * building its prompt with the judge as frozen at `BASE` and with the judge as
 * it is now, and reporting any that differ.
 *
 * It costs nothing and answers a different question from the measured baseline:
 * whether SL-14 could POSSIBLY own a failure, rather than how often the older
 * judge produced one.
 */
const IDENTITY_ONLY = process.env.BASELINE_IDENTITY_ONLY === "1";

async function main(): Promise<void> {
  loadEnvLocal();
  if (!IDENTITY_ONLY && !process.env.OPENROUTER_API_KEY) {
    console.error("baseline requires OPENROUTER_API_KEY — a run without it measures nothing.");
    process.exit(1);
  }

  const baseJudgeSource = execSync(`git show ${BASE}:${JUDGE_REL}`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const baseSetSource = execSync(`git show ${BASE}:${SET_REL}`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const basePath = path.join(JUDGE_DIR, "__baseline-judge.ts");
  writeFileSync(basePath, baseJudgeSource, "utf8");
  process.on("exit", () => {
    try {
      unlinkSync(basePath);
    } catch {}
  });

  const baseSet = JSON.parse(baseSetSource) as { scenarios: Array<Record<string, unknown>> };
  const currentSetBytes = readFileSync(path.join(ROOT, SET_REL));
  const currentSet = JSON.parse(currentSetBytes.toString("utf8")) as {
    scenarios: Array<Record<string, unknown>>;
  };

  const baseline = (await import(pathToFileURL(basePath).href)) as {
    createOpenRouterNextWorkJudge: () => { modelId: string | null; propose: (i: unknown) => Promise<unknown> };
    buildNextWorkPrompt: (input: never) => string;
  };

  if (IDENTITY_ONLY) {
    // Any set, not only main: a holdout's scenarios did not exist before SL-14,
    // but the prompt the two judges build for a given input can still be
    // compared, which is the only thing the claim rests on.
    const auditSetRel = process.env.IDENTITY_SET_REL ?? SET_REL;
    const auditSetBytes = readFileSync(path.join(ROOT, auditSetRel));
    const auditSet = JSON.parse(auditSetBytes.toString("utf8")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    const frozen = auditSet.scenarios.filter((s) => hasNothingBlocked(s as never));
    const differing: string[] = [];
    for (const sc of frozen) {
      const input = (sc as { input: never }).input;
      if (baseline.buildNextWorkPrompt(input) !== buildCurrentPrompt(input)) {
        differing.push(String(sc.id));
      }
    }
    console.log(
      `SA-14.1 byte-identity audit of ${auditSetRel} against the judge frozen at ${BASE}, no model calls.\n` +
        `  ${frozen.length} of ${auditSet.scenarios.length} scenario(s) have nothing blocked,` +
        ` so SA-14.1 requires their prompts to be unchanged:\n    ${
          frozen.length > 0 ? frozen.map((s) => String(s.id)).join(", ") : "(none)"
        }`
    );
    const out = process.env.BASELINE_JSON;
    if (out) {
      writeFileSync(
        out,
        JSON.stringify(
          {
            ranAt: new Date().toISOString(),
            what: `SA-14.1 byte-identity audit of ${auditSetRel}. For every scenario in it whose Work list has nothing blocked, the prompt built by the judge frozen at ${BASE} and by the judge as it is now. A scenario listed as identical is one SL-14 is STRUCTURALLY UNABLE to have affected, whatever it scores.`,
            notWhat:
              "This is not a measurement and holds no bar. It says what SL-14 could possibly own, not how often anything failed.",
            usedBy:
              "`run-supervisor-eval.ts` reads this through SUPERVISOR_EVAL_IDENTITY_AUDIT as the ONLY admissible proof for the closure rule of 2026-09-16, and refuses it unless `currentSetSha256` matches the set actually being measured.",
            baselineRef: BASE,
            baselineJudgeSha256: digest(baseJudgeSource),
            auditedSet: auditSetRel,
            currentSetSha256: digest(auditSetBytes.toString("utf8")),
            frozenByteIdentical: frozen
              .map((s) => String(s.id))
              .filter((id) => !differing.includes(id)),
            differing,
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      console.log(`  artifact: ${out}`);
    }
    if (differing.length > 0) {
      console.error(`\nFAILED — SA-14.1 breached for: ${differing.join(", ")}`);
      process.exit(1);
    }
    console.log("\nAll of them are BYTE-IDENTICAL. SL-14 cannot own a failure on any of these prompts.");
    return;
  }

  // Block B's membership, and the byte-identity that makes it legitimate.
  const baseIds = new Set(baseSet.scenarios.map((s) => String(s.id)));
  const candidates = currentSet.scenarios.filter(
    (s) => !baseIds.has(String(s.id)) && hasNothingBlocked(s as never)
  );
  const identical: Array<Record<string, unknown>> = [];
  const refused: string[] = [];
  for (const sc of candidates) {
    const input = (sc as { input: never }).input;
    if (baseline.buildNextWorkPrompt(input) === buildCurrentPrompt(input)) identical.push(sc);
    else refused.push(String(sc.id));
  }

  console.log(`baseline: judge and scenario set at ${BASE}; scorer = current (corrected outbound detector)`);
  console.log(`block A — the DoD baseline:      ${baseSet.scenarios.length} pre-SL-14 scenarios, as frozen at ${BASE}`);
  console.log(
    `block B — attribution extension: ${identical.length} scenario(s) new to the current set whose prompt is` +
      ` BYTE-IDENTICAL under both judges${identical.length > 0 ? `: ${identical.map((s) => s.id).join(", ")}` : ""}`
  );
  if (refused.length > 0) {
    console.log(
      `  REFUSED from block B (prompt differs under the two judges, so the pre-SL-14 judge would answer a` +
        ` different question): ${refused.join(", ")}`
    );
  }

  const blockA = await measure("block A — pre-SL-14 judge, pre-SL-14 scenarios", baseSet.scenarios, baseline.createOpenRouterNextWorkJudge);
  const blockB =
    identical.length > 0
      ? await measure("block B — pre-SL-14 judge, current byte-identical scenarios", identical, baseline.createOpenRouterNextWorkJudge)
      : [];

  const perScenarioA = report("BLOCK A — the Definition of Done's same-day baseline", blockA);
  const perScenarioB = blockB.length > 0 ? report("BLOCK B — attribution on byte-identical prompts", blockB) : {};

  console.log(
    "\nThis run establishes ATTRIBUTION ONLY. It states what the pre-SL-14 judge does today; it neither" +
      "\npasses nor fails any SL-14 bar, and a failure here never licenses one there."
  );

  const out = process.env.BASELINE_JSON;
  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          what: "SL-14's Definition-of-Done same-day baseline. The PRE-SL-14 judge, today, scored by the CURRENT verifier. Attribution evidence only: it establishes who owns a failure, never whether an SL-14 bar held.",
          baselineRef: BASE,
          baselineJudgeSha256: digest(baseJudgeSource),
          baselineSetSha256: digest(baseSetSource),
          currentSetSha256: digest(currentSetBytes.toString("utf8")),
          scorer: "current (corrected outbound detector)",
          model: evalArtifactModel([...blockA, ...blockB]),
          runCount: RUNS,
          blockA: {
            what: `the pre-SL-14 judge on the pre-SL-14 scenario set, both as frozen at ${BASE}`,
            scenarios: baseSet.scenarios.length,
            runs: blockA,
            perScenarioFailures: perScenarioA,
          },
          blockB: {
            what: "the pre-SL-14 judge on scenarios NEW to the current set whose Work list has nothing blocked, so SA-14.1 freezes their prompt",
            byteIdentityAsserted:
              "each scenario's prompt was built with the baseline judge AND the current judge and the two were equal; a scenario whose prompts differed was refused, not reported",
            scenarios: identical.map((s) => String(s.id)),
            refusedForDifferingPrompt: refused,
            runs: blockB,
            perScenarioFailures: perScenarioB,
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(`\nartifact: ${out}`);
  }
}

void main();
