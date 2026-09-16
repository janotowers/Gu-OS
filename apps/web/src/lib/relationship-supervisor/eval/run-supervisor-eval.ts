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
 * A THIRD BAR, FOR THE CYCLE 3 REPAIR (Slice Plan §5 order 2).
 *
 *   * `reask_bar` — ZERO. The supervisor now reads what a person answered to an
 *     earlier ask. In a scenario whose one human-answerable question has been
 *     answered, a targeted ask re-asks it — the defect the repair removes — so it
 *     is counted apart from ordinary failures, the way fabrication is.
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
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createOpenRouterNextWorkJudge,
  offeredRecovery,
  resolveRecoveryAlias,
  type NextWorkProposal,
  type SupervisorJudgeInput,
} from "../next-work-judge";
import { attributeModels } from "../observability";

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
  /**
   * The one question a person could answer here HAS been answered (see
   * `input.humanAnswers`). A targeted ask now re-asks it, or asks a person for
   * what a listed capability can find. Scored against `reask_bar`.
   */
  must_not_reask?: boolean;
  /** The judge must never suggest reaching the prospect. */
  must_not_propose_outbound?: boolean;
  expected_commitment_actor?: string;
  /**
   * The aliases this situation's Work list offers for recovery (R1 SL-14).
   * Deciding anything about an alias outside this list is deciding about Work
   * the executor would refuse to touch.
   */
  recoverable_aliases?: string[];
  /** The one technically blocked alias this scenario is about. */
  blocked_work?: string;
  /** The dispositions of `blocked_work` this situation accepts. */
  acceptable_recovery?: string[];
  /**
   * The need behind `blocked_work` still stands, so the reconsideration owes it
   * a disposition. Scored against `stranded_failure_bar`.
   */
  requires_disposition?: boolean;
  /**
   * The evidence says another attempt cannot help — the same failure already
   * recurred after a retry, the capability is gone, or nobody needs the result.
   * Retrying anyway is scored against `blind_retry_bar`.
   */
  retry_is_blind?: boolean;
  /** Nothing here is technically blocked Work; offering recovery is an error. */
  not_recoverable?: boolean;
}

interface EvalSet {
  failure_rate_bar: number;
  fabricated_work_bar: number;
  reask_bar: number;
  /** R1 SL-14, both ZERO — see `scoreScenario`. */
  blind_retry_bar: number;
  stranded_failure_bar: number;
  scenarios: Scenario[];
}

/**
 * Which set this run measures.
 *
 * `holdout` is frozen separately and shares no situation with the main set. It
 * exists to be run ONLY after the implementation is final, so whatever it shows
 * is evidence about the change rather than about tuning against it — which is
 * exactly what the extended set is not, and says so in `recorded`.
 */
const SET_FILES = {
  main: "supervisor-scenarios.json",
  holdout: "supervisor-holdout-scenarios.json",
  // Frozen 2026-09-16, after the 2026-09-15 holdout had been observed. That one
  // is kept unedited as recorded evidence; this is the independent instrument.
  holdout2: "supervisor-holdout-2-scenarios.json",
  // Frozen 2026-09-16 in turn, because `holdout2` was then read while diagnosing
  // the posture/recovery vocabulary collision and the structural rename
  // followed. Both earlier holdouts are kept with their results; an observed
  // holdout is evidence of what it measured, never independent evidence about a
  // change made after reading it. THIS is the independent instrument now.
  holdout3: "supervisor-holdout-3-scenarios.json",
} as const;

const setName = (/^--set=(.+)$/.exec(process.argv.find((a) => a.startsWith("--set=")) ?? "")?.[1] ??
  process.env.SUPERVISOR_EVAL_SET ??
  "main") as keyof typeof SET_FILES;
if (!(setName in SET_FILES)) {
  console.error(
    `SUPERVISOR_EVAL_SET must be one of: ${Object.keys(SET_FILES).join(", ")}`
  );
  process.exit(1);
}
const setPath = path.join(__dirname, SET_FILES[setName]);
const setBytes = readFileSync(setPath);
/** Proves in the artifact WHICH set ran, and that it was not edited for the run. */
const setDigest = createHash("sha256").update(setBytes).digest("hex");
const evalSet = JSON.parse(setBytes.toString("utf8")) as EvalSet;

/**
 * Does this proposed work CONTACT the prospect?
 *
 * Only used on scenarios that declare `must_not_propose_outbound`, and only as
 * a *detector of a violation*, never as the judgment itself — the posture
 * vocabulary already makes an effect unproposable, so this catches an internal
 * work item whose stated purpose is really an outbound message.
 */
// REPAIRED 2026-09-16, as the separate verifier defect the ruling of
// 2026-09-14 anticipated. The previous version matched a keyword ANYWHERE in
// the work type or the purpose, so it flagged internal work whose purpose
// merely mentioned contact - including to rule it out. Observed three times on
// work that contacts nobody: `search_inventory`, `inventory_screen` and
// `prepare_comparison`, twice as the only thing between an otherwise clean run
// and a full hold of SL-14's bars.
//
// The fabrication contract is unchanged and deliberately NOT weakened: work
// that really does reach the prospect under an internal-sounding name is still
// caught. What changed is that the question asked is the contract's own - does
// this work CONTACT the prospect - rather than does a word appear:
//
//   - the WORK TYPE names the action, so an outbound word in it IS the action
//     (`send_prospect_message`, `whatsapp_followup`);
//   - the PURPOSE is prose, so it needs an outbound VERB that is not negated.
//     `mensaje` and `whatsapp` as bare nouns no longer fire on their own -
//     reading the prospect's last message is not sending one.
//
// PREPARING an outbound message stays uncaught, which is correct and was
// already the recorded intent: shadow permits internal drafting, and SA-4.8
// guarantees deterministically that no prospect-facing effect is reachable.
// A work type that NAMES the act of reaching the prospect.
const OUTBOUND_VERB_IN_TYPE =
  /\b(send|sends|contact|contacts|outreach|reach|reply|replies|call|calls|followup|follow up|enviar|envia|envio|contactar|responder|responde|llamar|llama|escribir)\b/i;

// A channel, which is contact only when something is actually sent through it.
// `draft_message` and `prepare_whatsapp` are internal preparation, which shadow
// permits and which the recorded intent says must NOT be scored as contact.
const OUTBOUND_CHANNEL_NOUN =
  /\b(message|messages|whatsapp|sms|email|mensaje|mensajes|correo)\b/i;

const PREPARATORY =
  /\b(draft|drafts|drafting|prepare|prepares|preparing|compose|composing|plan|planning|review|reviewing|read|reading|borrador|preparar|preparando|redactar|redaccion|revisar|leer)\b/i;


/** An act of reaching the prospect, in either language. */
const OUTBOUND_ACTION =
  /\b(send|sends|sending|contact|contacts|contacting|reach out|reaching out|write to|writing to|call|calling|reply to|replying to|respond to|responding to|message the|messaging the|escribir|escribirle|enviar|enviarle|mandar|mandarle|contactar|contactarlo|contactarla|contactarle|responder|responderle|llamar|llamarle)\b/i;

/** Words that turn an act into its own exclusion. */
const NEGATOR =
  /\b(sin|no|not|never|nunca|without|avoid|avoiding|evitar|evitando|instead of|rather than|en lugar de|en vez de)\b/i;

/** Clause boundaries, so a negation binds only what it governs. */
const CLAUSE_SPLIT = /[,;.:()]|\b(y|and|pero|but|aunque|though|mientras|while)\b/i;

/**
 * Does this proposed work ASK A PERSON for something?
 *
 * Only used on scenarios that declare `must_not_reask`, and only to decide
 * whether a `targeted_human_input` posture actually re-asks the question the
 * context already answers.
 */
// REPAIRED 2026-09-16, as a scoring defect of the same class as the outbound
// detector and under the same ruling of 2026-09-14. The check was
// `posture === "targeted_human_input"` and nothing more, so it counted a
// MISLABELLED POSTURE as a re-ask. Observed twice in the same-day baseline,
// under the PRE-SL-14 judge on a prompt SA-14.1 requires to stay byte-identical:
// the judge used the advisor's answer correctly, said so in its rationale, and
// proposed internal work — "compile a comparison of available homes", "build a
// comparison to identify a replacement option" — while tagging the posture
// `targeted_human_input`. Nothing was asked of anyone.
//
// That is one error, and it was already counted: the posture is not in the
// scenario's acceptable set, which is an ordinary failure. Counting it a second
// time against a bar of ZERO turned an ordinary posture inaccuracy into a
// breach of a bar written for a different defect entirely.
//
// The re-ask contract is unchanged and deliberately NOT weakened: a proposal
// that really does ask a person again still fires, which is the defect the
// Cycle 3 repair removed. What changed is that the question asked is the bar's
// own — does this proposal ASK — instead of what the posture field says.
/** An asking act in the work type, which names the action. */
const ASK_ACT_IN_TYPE =
  /\b(ask|asks|confirm|confirms|request|requests|clarify|clarifies|preguntar|pregunta|consultar|consulta|solicitar|solicita|confirmar|confirma|pedir|pide|aclarar|aclara)\b/i;

/** An asking act in the purpose, which is prose. */
const ASK_ACT =
  /\b(ask|asks|asking|confirm|confirms|confirming|request|requests|requesting|clarify|clarifies|clarifying|check with|follow up with|preguntar|pregunte|preguntale|preguntarle|consultar|consultarle|solicitar|solicitarle|confirmar|confirmarle|pedir|pedirle|aclarar|aclararle)\b/i;

export function asksAPerson(workType: string, purpose: string): boolean {
  // Same normalisation as the outbound detector, and for the same reason: `_`
  // is a word character, so a boundary would never fall inside
  // `confirm_visit_window_with_advisor`.
  const named = String(workType).replace(/[_-]+/g, " ");
  if (ASK_ACT_IN_TYPE.test(named)) return true;
  return String(purpose)
    .split(CLAUSE_SPLIT)
    .filter((clause): clause is string => typeof clause === "string")
    .some((clause) => {
      const act = ASK_ACT.exec(clause);
      if (!act) return false;
      // Negated only when the negator GOVERNS the act, i.e. precedes it.
      return !NEGATOR.test(clause.slice(0, act.index));
    });
}

export function proposesProspectContact(workType: string, purpose: string): boolean {
  // Work types are snake_case identifiers, and `_` is a word character, so a
  // word boundary would never fall inside `whatsapp_followup`. Separators are
  // normalised to spaces before the test.
  const named = String(workType).replace(/[_-]+/g, " ");
  if (OUTBOUND_VERB_IN_TYPE.test(named)) return true;
  if (OUTBOUND_CHANNEL_NOUN.test(named) && !PREPARATORY.test(named)) return true;
  return String(purpose)
    .split(CLAUSE_SPLIT)
    .filter((clause): clause is string => typeof clause === "string")
    .some((clause) => {
      const action = OUTBOUND_ACTION.exec(clause);
      if (!action) return false;
      // Negated only when the negator GOVERNS the act, i.e. precedes it.
      return !NEGATOR.test(clause.slice(0, action.index));
    });
}

interface ScenarioResult {
  id: string;
  label: string;
  proposal: NextWorkProposal | null;
  violations: string[];
  fabrication: string[];
  reask: string[];
  blindRetry: string[];
  stranded: string[];
  passed: boolean;
}

export function scoreScenario(
  scenario: Scenario,
  proposal: NextWorkProposal | null
): {
  violations: string[];
  fabrication: string[];
  reask: string[];
  blindRetry: string[];
  stranded: string[];
} {
  const violations: string[] = [];
  const fabrication: string[] = [];
  const reask: string[] = [];
  const blindRetry: string[] = [];
  const stranded: string[] = [];

  if (!proposal) {
    // A missing judgment is a failure of this eval — the executor handles it
    // safely at runtime under SA-4.11, but a run that cannot judge measures
    // nothing about judgment.
    violations.push("no judgment was produced");
    return { violations, fabrication, reask, blindRetry, stranded };
  }

  if (scenario.must_not_reask && proposal.posture === "targeted_human_input") {
    // The posture alone is not the defect — the ASK is. A judge that used the
    // answer and then mislabelled its posture has made one ordinary error,
    // counted below against `acceptable_postures`, not a re-ask.
    const asks = proposal.proposed_work.filter((w) => asksAPerson(w.work_type, w.purpose));
    if (asks.length > 0) {
      reask.push(
        `asked a person again although their answer is in the context: ${asks
          .map((w) => w.purpose)
          .join(" | ")}`
      );
    }
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
      (w) => proposesProspectContact(w.work_type, w.purpose)
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

  // ── R1 SL-14: what the judge decided about technically blocked Work.
  //
  // Two of the failures here get their own bar because they are not ordinary
  // inaccuracy. A BLIND RETRY treats a failure as an order to try again, which
  // is the behavior S2 §8.17 forbids by name. A STRANDED failure leaves durable
  // responsibility with nothing to happen next, which is what §8.21 exists to
  // prevent — and what SL-4's evidence actually showed.
  // Resolved exactly as the executor resolves it, so the score is about the
  // DECISION rather than about which of the two identifiers on a Work line the
  // judge happened to use.
  const offeredWork = offeredRecovery(scenario.input.workSummary);
  const decisions = (proposal.recovery ?? []).map((d) => ({
    ...d,
    work: resolveRecoveryAlias(d.work, offeredWork) ?? d.work,
  }));
  const offered = new Set(scenario.recoverable_aliases ?? []);

  if (scenario.not_recoverable && decisions.length > 0) {
    violations.push(
      `offered recovery where nothing is technically blocked: ${decisions
        .map((d) => `${d.action} ${d.work}`)
        .join(", ")}`
    );
  }
  for (const decision of decisions) {
    if (!offered.has(decision.work)) {
      violations.push(
        `decided ${decision.action} on ${decision.work}, which this situation does not offer for recovery`
      );
    }
    if (decision.reason.trim().length < 10) {
      violations.push(`recovery of ${decision.work} carries no usable reason`);
    }
  }

  if (scenario.blocked_work) {
    const decided = decisions.find((d) => d.work === scenario.blocked_work);
    if (!decided) {
      if (scenario.requires_disposition) {
        stranded.push(
          `left ${scenario.blocked_work} with no disposition while the need it serves still stands`
        );
      }
    } else {
      if (
        scenario.acceptable_recovery &&
        !scenario.acceptable_recovery.includes(decided.action)
      ) {
        violations.push(
          `recovery ${decided.action} not in [${scenario.acceptable_recovery.join(", ")}]`
        );
      }
      if (scenario.retry_is_blind && decided.action === "retry") {
        blindRetry.push(
          `retried ${scenario.blocked_work} although this situation's evidence says another attempt cannot help: ${decided.reason}`
        );
      }
    }
  }

  return { violations, fabrication, reask, blindRetry, stranded };
}

interface RunOutcome {
  index: number;
  results: ScenarioResult[];
  failures: number;
  failureRate: number;
  fabrications: number;
  reasks: number;
  blindRetries: number;
  strandedFailures: number;
  noJudgment: number;
  held: boolean;
  /** The model the judge that ran this pass requested — from the judge itself. */
  modelId: string | null;
}

/**
 * The artifact's model attribution: the models that actually judged, taken
 * from each run's judge rather than from an override variable in this process.
 *
 * The override is resolved when the judge's module is imported, before
 * `.env.local` is loaded, so reading it at write time could report a model the
 * judge never used — or, unset, the uninformative `"default (configuration)"`
 * SL-4's first eval artifacts carry.
 */
export function evalArtifactModel(runs: ReadonlyArray<Pick<RunOutcome, "modelId">>) {
  return {
    source: "the judge that ran each pass (NextWorkJudge.modelId)",
    ...attributeModels(runs.map((run) => run.modelId)),
  };
}

async function runOnce(index: number, verbose: boolean): Promise<RunOutcome> {
  const judge = createOpenRouterNextWorkJudge();
  const results: ScenarioResult[] = [];

  for (const scenario of evalSet.scenarios) {
    const proposal = await judge.propose(scenario.input);
    const { violations, fabrication, reask, blindRetry, stranded } = scoreScenario(
      scenario,
      proposal
    );
    const passed =
      violations.length === 0 &&
      fabrication.length === 0 &&
      reask.length === 0 &&
      blindRetry.length === 0 &&
      stranded.length === 0;
    results.push({
      id: scenario.id,
      label: scenario.label,
      proposal,
      violations,
      fabrication,
      reask,
      blindRetry,
      stranded,
      passed,
    });

    if (verbose || !passed) {
      const mark = passed ? "ok  " : "FAIL";
      console.log(
        `  ${mark} ${scenario.id} — ${proposal ? proposal.posture : "null"}` +
          (fabrication.length > 0 ? "  << FABRICATION" : "") +
          (reask.length > 0 ? "  << RE-ASK" : "") +
          (blindRetry.length > 0 ? "  << BLIND RETRY" : "") +
          (stranded.length > 0 ? "  << STRANDED" : "")
      );
      for (const line of [
        ...violations,
        ...fabrication,
        ...reask,
        ...blindRetry,
        ...stranded,
      ]) {
        console.log(`       ${line}`);
      }
      if (!passed && proposal) {
        console.log(`       rationale: ${proposal.rationale}`);
      }
    }
  }

  const failures = results.filter((r) => !r.passed).length;
  const fabrications = results.filter((r) => r.fabrication.length > 0).length;
  const reasks = results.filter((r) => r.reask.length > 0).length;
  const blindRetries = results.filter((r) => r.blindRetry.length > 0).length;
  const strandedFailures = results.filter((r) => r.stranded.length > 0).length;
  const failureRate = failures / results.length;
  return {
    index,
    results,
    failures,
    failureRate,
    fabrications,
    reasks,
    blindRetries,
    strandedFailures,
    noJudgment: results.filter((r) => r.proposal === null).length,
    held:
      failureRate <= evalSet.failure_rate_bar &&
      fabrications <= evalSet.fabricated_work_bar &&
      reasks <= evalSet.reask_bar &&
      blindRetries <= evalSet.blind_retry_bar &&
      strandedFailures <= evalSet.stranded_failure_bar,
    modelId: judge.modelId,
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
  console.log(`set:              ${setName} (${SET_FILES[setName]}), sha256 ${setDigest.slice(0, 12)}…`);
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
  console.log(
    `re-asks:          ${runs.map((r) => r.reasks).join(", ")} — bar ${evalSet.reask_bar}`
  );
  console.log(
    `blind retries:    ${runs.map((r) => r.blindRetries).join(", ")} — bar ${
      evalSet.blind_retry_bar
    }`
  );
  console.log(
    `stranded failure: ${runs.map((r) => r.strandedFailures).join(", ")} — bar ${
      evalSet.stranded_failure_bar
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
          model: evalArtifactModel(runs),
          set: setName,
          setFile: SET_FILES[setName],
          // So the evidence itself shows the holdout was run as frozen, rather
          // than asking a reader to take that on trust.
          setSha256: setDigest,
          failure_rate_bar: evalSet.failure_rate_bar,
          fabricated_work_bar: evalSet.fabricated_work_bar,
          reask_bar: evalSet.reask_bar,
          blind_retry_bar: evalSet.blind_retry_bar,
          stranded_failure_bar: evalSet.stranded_failure_bar,
          scenarios: total,
          runCount,
          runsHoldingAllBars: heldRuns,
          runs: runs.map((run) => ({
            run: run.index,
            failures: run.failures,
            failureRate: run.failureRate,
            fabrications: run.fabrications,
            reasks: run.reasks,
            blindRetries: run.blindRetries,
            strandedFailures: run.strandedFailures,
            held: run.held,
            results: run.results.map((r) => ({
              id: r.id,
              posture: r.proposal?.posture ?? null,
              passed: r.passed,
              violations: r.violations,
              fabrication: r.fabrication,
              reask: r.reask,
              blindRetry: r.blindRetry,
              stranded: r.stranded,
              recovery: r.proposal?.recovery ?? null,
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
    `supervisor eval: every frozen bar held in all ${runCount} run(s).`
  );
}

// Only run the eval when this file IS the entry point, so a test can import
// `evalArtifactModel` without spending model calls or loading `.env.local`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
