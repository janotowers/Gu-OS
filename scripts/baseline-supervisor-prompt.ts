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
 * The base judge is written next to the real one for the length of the run, so
 * its own relative imports resolve, and removed again on exit.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreScenario } from "../apps/web/src/lib/relationship-supervisor/eval/run-supervisor-eval";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const JUDGE_DIR = path.join(ROOT, "apps/web/src/lib/relationship-supervisor");
const BASE = process.env.BASELINE_REF ?? "2a12441";
const RUNS = Math.max(1, Number(process.env.SUPERVISOR_EVAL_RUNS ?? 5));

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

async function main(): Promise<void> {
  loadEnvLocal();
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("baseline requires OPENROUTER_API_KEY — a run without it measures nothing.");
    process.exit(1);
  }

  const judgeRel = "apps/web/src/lib/relationship-supervisor/next-work-judge.ts";
  const setRel = "apps/web/src/lib/relationship-supervisor/eval/supervisor-scenarios.json";
  const basePath = path.join(JUDGE_DIR, "__baseline-judge.ts");
  writeFileSync(basePath, execSync(`git show ${BASE}:${judgeRel}`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString(), "utf8");
  process.on("exit", () => { try { unlinkSync(basePath); } catch {} });

  const oldSet = JSON.parse(execSync(`git show ${BASE}:${setRel}`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString());
  const { createOpenRouterNextWorkJudge } = (await import(pathToFileURL(basePath).href)) as {
    createOpenRouterNextWorkJudge: () => { modelId: string | null; propose: (i: unknown) => Promise<unknown> };
  };

  console.log(`baseline: judge and scenarios at ${BASE}; scorer = current (corrected detector)`);
  console.log(`scenarios: ${oldSet.scenarios.length} x ${RUNS} run(s)\n`);

  const runs: Array<{ rate: number; fab: number; reask: number; failures: string[] }> = [];
  const perScenario = new Map<string, number>();
  for (let r = 1; r <= RUNS; r += 1) {
    const judge = createOpenRouterNextWorkJudge();
    let failures = 0, fab = 0, reask = 0;
    const failed: string[] = [];
    for (const sc of oldSet.scenarios) {
      const proposal = (await judge.propose(sc.input)) as never;
      const s = scoreScenario(sc as never, proposal);
      const passed = s.violations.length === 0 && s.fabrication.length === 0 && s.reask.length === 0;
      if (!passed) { failures += 1; failed.push(sc.id); perScenario.set(sc.id, (perScenario.get(sc.id) ?? 0) + 1); }
      if (s.fabrication.length) fab += 1;
      if (s.reask.length) reask += 1;
    }
    runs.push({ rate: failures / oldSet.scenarios.length, fab, reask, failures: failed });
    console.log(`  run ${r}: ${(failures / oldSet.scenarios.length * 100).toFixed(1)}%  fab=${fab}  reask=${reask}  [${failed.join(", ")}]`);
  }

  console.log(`\nfailure rate: ${runs.map((x) => (x.rate * 100).toFixed(1) + "%").join(", ")} — SL-4's bar 20%`);
  console.log(`fabrications: ${runs.map((x) => x.fab).join(", ")} — bar 0`);
  console.log(`re-asks:      ${runs.map((x) => x.reask).join(", ")} — bar 0`);
  console.log("\nper-scenario failures (of runs):");
  for (const [id, n] of [...perScenario].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id}: ${n}/${RUNS}${n === RUNS ? "  (systematic)" : ""}`);
  }
  const out = process.env.BASELINE_JSON;
  if (out) {
    writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), baselineRef: BASE, scorer: "current (corrected outbound detector)", scenarios: oldSet.scenarios.length, runs, perScenario: Object.fromEntries(perScenario) }, null, 2) + "\n", "utf8");
    console.log(`\nartifact: ${out}`);
  }
}

void main();
