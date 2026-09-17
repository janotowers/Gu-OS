/**
 * Does the judge as it stands build the SAME prompt as the judge at a given
 * ref, for EVERY scenario in every eval set — blocked ones included?
 *
 * `baseline-supervisor-prompt.ts --identity` answers a narrower question on
 * purpose: it compares only the situations with nothing blocked, because that
 * is all SA-14.1 requires to be unchanged. A REVERT claims something stronger —
 * that nothing the model sees moved at all — and a claim that strong has to be
 * checkable, or the next measurement is comparing two states nobody verified
 * were one state. It found nothing wrong on the 2026-09-16 revert; it exists so
 * that a partial revert cannot be reported as a complete one.
 *
 * No model calls, so it costs nothing to run before any measurement.
 *
 *   REVERT_REF=70f5f1e npm run verify:supervisor-prompt-unchanged
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildNextWorkPrompt } from "../apps/web/src/lib/relationship-supervisor/next-work-judge";

const ROOT = process.cwd();
const JUDGE_REL = "apps/web/src/lib/relationship-supervisor/next-work-judge.ts";
const JUDGE_DIR = path.join(ROOT, path.dirname(JUDGE_REL));
const REF = process.env.REVERT_REF ?? "70f5f1e";
const SETS = [
  "supervisor-scenarios.json",
  "supervisor-holdout-scenarios.json",
  "supervisor-holdout-2-scenarios.json",
  "supervisor-holdout-3-scenarios.json",
  "supervisor-holdout-4-scenarios.json",
  "supervisor-holdout-5-scenarios.json",
  "supervisor-holdout-6-scenarios.json",
  "supervisor-holdout-7-scenarios.json",
  "supervisor-holdout-8-scenarios.json",
];

async function main(): Promise<void> {
  const src = execSync(`git show ${REF}:${JUDGE_REL}`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const tmp = path.join(JUDGE_DIR, "__revert-proof-judge.ts");
  writeFileSync(tmp, src, "utf8");
  process.on("exit", () => {
    try {
      unlinkSync(tmp);
    } catch {}
  });
  const frozen = (await import(pathToFileURL(tmp).href)) as {
    buildNextWorkPrompt: (input: never) => string;
  };

  // A scenario that exercises an input field the frozen judge did not have is
  // EXPECTED to differ — that is new behavior being measured, not a revert left
  // half-done. Which fields those are is read off the frozen source itself
  // rather than listed here, so this can never quietly excuse a real change.
  const POST_REF_FIELDS = ["retryExhaustedAliases", "capabilityGoneAliases"] as const;
  const absentAtRef = POST_REF_FIELDS.filter((field) => !src.includes(field));

  let total = 0;
  const expected: string[] = [];
  const differing: string[] = [];
  for (const file of SETS) {
    const p = path.join(JUDGE_DIR, "eval", file);
    let parsed: { scenarios: Array<{ id: string; input: never }> };
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      console.log(`  ${file}: absent, skipped`);
      continue;
    }
    let diff = 0;
    let skipped = 0;
    for (const sc of parsed.scenarios) {
      const input = sc.input as Record<string, unknown>;
      // An EMPTY declaration declares nothing, so it stays comparable: the
      // judge renders no line for it and the prompt must still match.
      const usesNewField = absentAtRef.some((field) => {
        const value = input[field];
        return Array.isArray(value) ? value.length > 0 : value !== undefined;
      });
      if (usesNewField) {
        skipped += 1;
        expected.push(`${file}:${sc.id}`);
        continue;
      }
      total += 1;
      if (frozen.buildNextWorkPrompt(sc.input) !== buildNextWorkPrompt(sc.input)) {
        diff += 1;
        differing.push(`${file}:${sc.id}`);
      }
    }
    console.log(
      `  ${file}: ${parsed.scenarios.length} scenario(s), ${diff} differing` +
        (skipped > 0 ? `, ${skipped} exercising a field ${REF} did not have` : "")
    );
  }
  if (expected.length > 0) {
    console.log(
      `\nNot comparable, and expected: ${absentAtRef.join(", ")} did not exist at ${REF}, so` +
        ` these scenarios are measuring behavior that is new by construction:\n  ${expected.join("\n  ")}`
    );
  }
  console.log(
    differing.length === 0
      ? `\nALL ${total} comparable prompts are byte-identical to ${REF}. The revert is complete.`
      : `\n${differing.length} of ${total} DIFFER from ${REF}:\n  ${differing.join("\n  ")}`
  );
  process.exit(differing.length === 0 ? 0 : 1);
}

void main();
