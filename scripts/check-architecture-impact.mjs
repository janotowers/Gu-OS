#!/usr/bin/env node
/**
 * CI process invariant: a PR that changes implemented architecture must carry
 * an explicit documentation-impact assessment.
 *
 * The architecture documentation coherence audit (PRs #32–#35) repaired
 * canonical current-state documents that had drifted from the system they
 * describe. The rule requiring that repair already existed — `AGENTS.md` §8.
 * What was missing was a moment where somebody is asked, cheaply and on the
 * record, *which claims this change invalidated*. This is that moment.
 *
 * WHAT IT ENFORCES. That the assessment happened and named an owning artifact.
 * Not that the assessment is correct — deciding whether a prose claim is still
 * true needs the semantic judgment the audit itself required, and a validator
 * pretending to do that would create exactly the false confidence being
 * prevented. Both `updated` and `none` pass; `none` is cheap and legitimate,
 * because the goal is accurate assessment, not documentation churn.
 *
 * SAFETY. The PR body is read from the GitHub event payload JSON on disk
 * (`GITHUB_EVENT_PATH`), never interpolated into a shell command. Author-
 * controlled text therefore never reaches a shell.
 *
 * CONTEXT. Meaningful only for `pull_request`. On `push` (including merges to
 * `main`) and on local runs there is no PR body, so the check reports and exits
 * clean rather than failing on an absence it cannot do anything about.
 *
 * Usage:
 *   node scripts/check-architecture-impact.mjs
 *   node scripts/check-architecture-impact.mjs --base <sha> --head <sha>
 *   node scripts/check-architecture-impact.mjs --paths-from <file> --body-from <file>
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTION_HEADING, validate } from "./lib/architecture-impact.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Changed paths for base..head. Fails loudly rather than passing on a bad diff. */
function changedPaths(base, head) {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "diff", "--name-only", base, head], {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    console.error(
      `check-architecture-impact: could not diff ${base}..${head}. ` +
        "Ensure the workflow checks out enough history (fetch-depth: 0).\n" +
        String(error?.message ?? error)
    );
    process.exit(1);
  }
}

function main() {
  // --- Offline mode: fixtures drive both inputs. Used by the fixture harness.
  const pathsFrom = arg("paths-from");
  const bodyFrom = arg("body-from");
  if (pathsFrom || bodyFrom) {
    const paths = pathsFrom
      ? readFileSync(pathsFrom, "utf8").split(/\r?\n/).filter(Boolean)
      : [];
    const body = bodyFrom ? readFileSync(bodyFrom, "utf8") : "";
    return report(validate({ paths, body }));
  }

  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const event = process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : null;
  const pr = event?.pull_request ?? null;

  if (eventName !== "pull_request" || !pr) {
    console.log(
      "check-architecture-impact: not a pull_request context — skipping.\n" +
        "  The declaration lives in the PR body, so this control is only meaningful on a PR.\n" +
        "  Pushes to main carry the assessment already made on the PR that produced them."
    );
    return;
  }

  const base = arg("base") ?? pr.base?.sha;
  const head = arg("head") ?? pr.head?.sha;
  if (!base || !head) {
    console.error("check-architecture-impact: pull_request payload has no base/head sha.");
    process.exit(1);
  }

  report(validate({ paths: changedPaths(base, head), body: pr.body ?? "" }), {
    number: pr.number,
  });
}

function report(outcome, meta = {}) {
  const label = meta.number ? `PR #${meta.number}` : "change";

  if (!outcome.required) {
    console.log(
      `check-architecture-impact: ok — ${label} changes no implementation, schema, ` +
        `runtime, config or workflow path (${outcome.ignored.length} changed file(s) reviewed).`
    );
    return;
  }

  if (outcome.ok) {
    console.log(
      `check-architecture-impact: ok — declaration present, Result: ${outcome.result} ` +
        `(${outcome.triggering.length} implementation path(s) changed).`
    );
    return;
  }

  console.error(`check-architecture-impact: FAILED — ${label} changes implemented architecture surfaces:`);
  for (const p of outcome.triggering.slice(0, 12)) console.error(`  - ${p}`);
  if (outcome.triggering.length > 12) {
    console.error(`  … and ${outcome.triggering.length - 12} more`);
  }
  console.error("\nProblems with the declaration:");
  for (const e of outcome.errors) console.error(`  - ${e}`);
  console.error(
    `\nAdd this to the PR body (see .github/pull_request_template.md):\n\n` +
      `## ${SECTION_HEADING}\n\n` +
      "- **Result:** `updated` or `none`\n" +
      "- **Owning current-state docs reviewed:** the document path(s)\n" +
      "- **Reason:** which claim changed and where the correction landed, or what you\n" +
      "  inspected and why no current-architecture claim was invalidated\n\n" +
      "Identify the owning artifact through docs/README.md. `none` is a legitimate\n" +
      "answer — this control asks for an accurate assessment, not documentation churn.\n" +
      "It checks that the assessment was made; it does not judge the answer."
  );
  process.exit(1);
}

main();
