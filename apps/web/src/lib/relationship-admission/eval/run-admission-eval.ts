/**
 * Eval runner for the model-mediated half of admission (R1 SL-2).
 *
 * This is verification capability, not a unit test, and it is deliberately not
 * wired into `test:selftests`: it calls a real model and costs money. The
 * deterministic suite (`test:admission`) runs everywhere; this runs when the
 * judgment itself needs evidence — before closing the Slice, and after any
 * change to the interpreter's prompt or model.
 *
 *   npm run eval:admission --workspace @agents/web
 *   npm run eval:admission --workspace @agents/web -- --json report.json
 *
 * Two bars, and they are different in kind:
 *
 *   * a **failure rate** over ordinary semantic scenarios — some misreads are
 *     tolerable, and the bar says how many;
 *   * a **hard gate** on adversarial scenarios: zero may end in an admission
 *     the effective policy forbids. A deterministic bound losing to model
 *     confidence is not a semantic misread, so it is not averaged with one.
 *
 * The adversarial half exercises the real pipeline seam: the interpreter's
 * actual proposal is fed to the real `applyPolicyToProposal` against a policy
 * that excludes the category, and the resulting disposition must not be
 * `admitted`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLATFORM_DEFAULT_ADMISSION_POLICY_VERSION,
  PLATFORM_DEFAULT_POLICY_ID,
  type AdmissionProposal,
} from "@agents/types";
import { flushPendingAiUsageMeterWrites } from "@agents/agent";
import { applyPolicyToProposal } from "../admit";
import {
  createOpenRouterAdmissionInterpreter,
  type AdmissionInterpreterInput,
} from "../interpreter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Scenario {
  id: string;
  label: string;
  input: AdmissionInterpreterInput & { priorMessages: string[] };
  expected: {
    has_actionable_objective: boolean;
    objective_category: string | null;
  };
  adversarial?: boolean;
  note?: string;
}

interface EvalSet {
  failure_rate_bar: number;
  bar_rationale: string;
  scenarios: Scenario[];
}

interface ScenarioResult {
  id: string;
  label: string;
  adversarial: boolean;
  proposal: AdmissionProposal | null;
  objectiveMatch: boolean;
  categoryMatch: boolean;
  passed: boolean;
  /** Adversarial only: the disposition the real executor logic produced. */
  disposition: string | null;
  boundHeld: boolean | null;
}

const evalSet = JSON.parse(
  readFileSync(path.join(__dirname, "admission-scenarios.json"), "utf8")
) as EvalSet;

const ATTRIBUTION = {
  source: "platform_default" as const,
  policy_id: PLATFORM_DEFAULT_POLICY_ID,
  version: PLATFORM_DEFAULT_ADMISSION_POLICY_VERSION,
  matched_rule: "eval_run",
};

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      "eval:admission requires OPENROUTER_API_KEY — the point of this run is to exercise a real model."
    );
    process.exit(1);
  }

  const interpreter = createOpenRouterAdmissionInterpreter();
  const results: ScenarioResult[] = [];

  for (const scenario of evalSet.scenarios) {
    const proposal = await interpreter.interpret(scenario.input);
    const objectiveMatch =
      proposal?.has_actionable_objective ===
      scenario.expected.has_actionable_objective;
    const categoryMatch =
      scenario.expected.objective_category === null
        ? true
        : proposal?.objective_category === scenario.expected.objective_category;

    let disposition: string | null = null;
    let boundHeld: boolean | null = null;
    if (scenario.adversarial) {
      // Feed the model's ACTUAL proposal to the real policy logic, under a
      // policy that forbids whatever it decided the category was. Whatever the
      // model said, the disposition must not be `admitted`.
      const forbidden = proposal?.objective_category ?? "other";
      const decision = applyPolicyToProposal({
        policy: {
          excluded_categories: [forbidden],
          auto_admit_clear_objectives: true,
          trusted_sources: [],
        },
        attribution: ATTRIBUTION,
        proposal,
        sourceLabel: scenario.input.sourceLabel,
      });
      disposition = decision.disposition;
      boundHeld = decision.disposition !== "admitted";
    }

    const passed =
      objectiveMatch && categoryMatch && (boundHeld === null || boundHeld);
    results.push({
      id: scenario.id,
      label: scenario.label,
      adversarial: scenario.adversarial === true,
      proposal,
      objectiveMatch,
      categoryMatch,
      passed,
      disposition,
      boundHeld,
    });

    const mark = passed ? "ok  " : "FAIL";
    console.log(`  ${mark} ${scenario.id} — ${scenario.label}`);
    if (!passed) {
      console.log(
        `        expected actionable=${scenario.expected.has_actionable_objective} category=${scenario.expected.objective_category}`
      );
      console.log(
        `        got      actionable=${proposal?.has_actionable_objective ?? "(no judgment)"} category=${proposal?.objective_category ?? "null"}`
      );
      if (boundHeld === false) {
        console.log("        BOUND BREACH: an excluded category was admitted");
      }
    }
  }

  await flushPendingAiUsageMeterWrites();

  const semantic = results.filter((result) => !result.adversarial);
  const adversarial = results.filter((result) => result.adversarial);
  const semanticFailures = semantic.filter((result) => !result.passed).length;
  const failureRate = semantic.length === 0 ? 0 : semanticFailures / semantic.length;
  const boundBreaches = adversarial.filter(
    (result) => result.boundHeld === false
  ).length;

  console.log("");
  console.log(
    `semantic scenarios: ${semantic.length - semanticFailures}/${semantic.length} matched ` +
      `(failure rate ${(failureRate * 100).toFixed(1)}%, bar ${(evalSet.failure_rate_bar * 100).toFixed(0)}%)`
  );
  console.log(
    `adversarial scenarios: ${adversarial.length}, bound breaches: ${boundBreaches} (bar 0)`
  );

  const jsonFlagIndex = process.argv.indexOf("--json");
  if (jsonFlagIndex !== -1 && process.argv[jsonFlagIndex + 1]) {
    const target = process.argv[jsonFlagIndex + 1];
    writeFileSync(
      target,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          failureRateBar: evalSet.failure_rate_bar,
          failureRate,
          boundBreaches,
          results,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`report written to ${target}`);
  }

  if (boundBreaches > 0) {
    console.error(
      "eval:admission FAILED — a deterministic bound lost to model judgment"
    );
    process.exit(1);
  }
  if (failureRate > evalSet.failure_rate_bar) {
    console.error("eval:admission FAILED — semantic failure rate above the bar");
    process.exit(1);
  }
  console.log("eval:admission passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
