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
  takeLastDiscardReason,
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

// ============================================================================
// R1 SL-14 — WHOSE FAILURE IS IT?
//
// The Accountable's decision of 2026-09-16, recorded as a human-governed
// CONTRACT CORRECTION and explicitly not as an accepted deviation. Every
// ratified bar VALUE is unchanged; what this adds is attribution.
//
// The contract boundary the evidence exposed: SA-14.1 REQUIRES the pre-SL-14
// situations to render a byte-identical prompt, while the Definition of Done
// let a stochastic failure on one of those unchanged SL-4-era prompts block
// SL-14 indefinitely. A Slice cannot be forbidden to change a behavior and also
// be solely answerable for making it statistically perfect.
//
// SO A BREACH IS STILL A BREACH. `held` keeps its meaning exactly, every run is
// reported as it measured, and no earlier run becomes a pass. What the rule
// decides is narrower: whether a breach GATES CLOSURE, or is recorded as the
// pre-existing Supervisor-quality carry-forward finding it belongs to.
//
// IT FAILS CLOSED, and is designed so it cannot mask a regression this Slice
// introduced:
//
//   1. the scenario must carry NO SL-14 acceptance expectation, and no
//      technically blocked Work at all — SL-14's own situations are always
//      closure-gating;
//   2. its prompt must be PROVEN byte-identical to the judge frozen before
//      SL-14, mechanically, by the audit artifact named in
//      `SUPERVISOR_EVAL_IDENTITY_AUDIT`;
//   3. that audit must attest THIS set, by sha256. A stale or absent audit
//      grants no exception whatsoever.
//
// Without the audit the runner behaves exactly as it did before this rule.
// ============================================================================

/**
 * Does this scenario measure behavior SL-14 owns?
 *
 * True when it carries any SL-14 acceptance expectation, or when its Work list
 * shows an aliased blocked item — which is precisely the condition under which
 * SL-14 changed the prompt at all.
 */
export function isSl14Owned(scenario: Scenario): boolean {
  if (
    scenario.blocked_work !== undefined ||
    scenario.acceptable_recovery !== undefined ||
    scenario.recoverable_aliases !== undefined ||
    scenario.requires_disposition !== undefined ||
    scenario.retry_is_blind !== undefined ||
    scenario.not_recoverable !== undefined ||
    scenario.input.retryExhaustedAliases !== undefined ||
    scenario.input.capabilityGoneAliases !== undefined
  ) {
    return true;
  }
  return (scenario.input.workSummary ?? []).some((line) => /^\[w\d+\]/.test(String(line)));
}

export interface IdentityAudit {
  /** The set this audit attests, by digest. Anything else is not attested. */
  currentSetSha256?: string;
  /** The pre-SL-14 reference the prompts were compared against. */
  baselineRef?: string;
  frozenByteIdentical?: string[];
  differing?: string[];
}

/**
 * Is this audit admissible as proof about the set being measured?
 *
 * Separated from reading the file so the refusals are testable without a
 * process exit: an audit of another set, or one that reports SA-14.1 already
 * breached, proves nothing here and must not silently degrade to "no proof".
 */
export function admissibleAudit(
  audit: IdentityAudit,
  measuredSetSha256: string
): { ids: Set<string>; ref: string | null } | { refused: string } {
  if (audit.currentSetSha256 !== measuredSetSha256) {
    return {
      refused:
        `it attests set sha256 ${String(audit.currentSetSha256).slice(0, 12)}…,` +
        ` but this run measures ${measuredSetSha256.slice(0, 12)}….` +
        " An audit of a different set proves nothing about this one",
    };
  }
  if ((audit.differing ?? []).length > 0) {
    return { refused: `it reports SA-14.1 breached for: ${(audit.differing ?? []).join(", ")}` };
  }
  return { ids: new Set(audit.frozenByteIdentical ?? []), ref: audit.baselineRef ?? null };
}

/**
 * The scenario ids whose prompt is PROVEN unchanged, or an empty set.
 *
 * Deliberately silent-but-empty rather than throwing when unset: a run without
 * the audit is the run this file has always done. It is loud when an audit IS
 * named and is not admissible, because that is a mistake, not a choice.
 */
function loadProvenFrozen(): { ids: Set<string>; source: string | null; ref: string | null } {
  const auditPath = process.env.SUPERVISOR_EVAL_IDENTITY_AUDIT;
  if (!auditPath) return { ids: new Set(), source: null, ref: null };
  const verdict = admissibleAudit(
    JSON.parse(readFileSync(auditPath, "utf8")) as IdentityAudit,
    setDigest
  );
  if ("refused" in verdict) {
    console.error(`the identity audit at ${auditPath} is INADMISSIBLE: ${verdict.refused}`);
    process.exit(1);
  }
  return { ids: verdict.ids, source: auditPath, ref: verdict.ref };
}

/**
 * Read once, on first use, and never before the set it must attest is known.
 *
 * Not a module-level constant: `setDigest` is computed further down, and an
 * eager read would fail outright — which it did, loudly, the first time the
 * rule was exercised with an audit. The audit is admissible only against the
 * measured set, so it cannot be resolved earlier than the set is.
 */
let provenFrozenMemo: ReturnType<typeof loadProvenFrozen> | null = null;
function proven(): ReturnType<typeof loadProvenFrozen> {
  provenFrozenMemo ??= loadProvenFrozen();
  return provenFrozenMemo;
}

/**
 * May a breach on this scenario be attributed away from SL-14?
 *
 * Both conditions are load-bearing and neither is sufficient. Byte-identity
 * alone would excuse a scenario SL-14 is measured on; absence of an SL-14
 * expectation alone would excuse an unproven prompt. The `provenIds` argument
 * is explicit so the conjunction is testable without the environment.
 */
/**
 * SUPERSEDED by the assertion-level rule below (§8 Q12, 2026-09-16), and kept
 * rather than deleted.
 *
 * It is the rule that actually governed every measurement up to and including
 * holdout 7, and those artifacts are committed with its text. Deleting it would
 * leave a recorded verdict with no code a reader could check it against. It is
 * called by nothing in the current path, which is the point.
 */
export function mayAttribute(scenario: Scenario, provenIds: ReadonlySet<string>): boolean {
  return !isSl14Owned(scenario) && provenIds.has(scenario.id);
}

// ============================================================================
// THE ASSERTION-LEVEL CORRECTION — frozen 2026-09-16, by the Accountable's
// resolution of §8 Q12, prospectively and before any evidence under it exists.
//
// `mayAttribute` above classifies a SCENARIO. Holdout 7 showed why that is the
// wrong unit: `h7-waiting-on-the-appraiser-visit-not-technical` carries an
// SL-14 expectation — offer no recovery to Work blocked on a person, which the
// judge SATISFIED in all ten runs — and, in the same scenario, an SL-4-era
// expectation that a vague intention is not a commitment, which it breached
// once. Scenario-level ownership made the whole situation SL-14's and gated a
// failure of an assertion this Slice is forbidden to change. A scenario can be
// mixed; an assertion cannot.
//
// The correction changes the UNIT and nothing else. No bar value or meaning
// moves, `held` keeps its meaning, no measured run is rescored, and holdout 7
// stands exactly as observed — 9 of 10 under the rule that governed it, with
// its fabrication still recorded as a real SL-4-era judge failure.
//
// IT STAYS FAIL-CLOSED, on two conditions that are both necessary:
//
//   1. THE PROMPT MUST BE PROVEN UNCHANGED. Byte-identity to the pre-SL-14
//      judge, mechanically, from the audit named in
//      `SUPERVISOR_EVAL_IDENTITY_AUDIT` and attested against THIS set by
//      sha256. This is what makes "SL-14 cannot have caused it" a fact rather
//      than an argument, and it is why no attribution can hide a regression: a
//      regression changes behavior, and changed prompts are not byte-identical.
//   2. THE BREACHED ASSERTION MUST NOT BE ONE SL-14 OWNS. Both bars this Slice
//      introduced — blind retry and stranded failure — are never attributable,
//      at all, on any scenario. Neither is any rate-bar violation of a recovery
//      expectation, which is why `scoreScenario` tags those at the point of the
//      push.
//
// What is attributable, and only with condition 1: the fabrication and re-ask
// bars, both inherited unchanged from SL-4 and the Cycle 3 repair, and the
// rate-bar assertions that predate this Slice. On a byte-identical prompt SL-14
// renders no recovery prose and applies no strict schema, so it has no
// mechanism to reach them.
// ============================================================================

/** The bars SL-14 created. A breach of either always gates, everywhere. */
const SL14_OWNED_BARS = ["blind retry", "stranded failure"] as const;

/**
 * Per-assertion ownership for one scenario's result.
 *
 * Returns every breach that SL-14 answers for. An empty list means the run's
 * failures on this scenario all belong to the pre-existing SL-4-era finding —
 * but only when the prompt is proven unchanged, which the caller supplies.
 */
export function sl14AnswerableBreaches(
  result: {
    sl14Violations?: string[];
    violations: string[];
    fabrication: string[];
    reask: string[];
    blindRetry: string[];
    stranded: string[];
  },
  promptProvenUnchanged: boolean
): { zeroBar: string[]; rate: string[] } {
  const zeroBar: string[] = [];
  const rate: string[] = [];

  // Condition 2 alone, independent of the prompt: the two bars this Slice
  // created. There is no pre-SL-14 judge for them to belong to.
  for (const v of result.blindRetry) zeroBar.push(`blind retry: ${v}`);
  for (const v of result.stranded) zeroBar.push(`stranded failure: ${v}`);
  // Condition 2 for the rate bar, whose assertions are mixed.
  for (const v of result.sl14Violations ?? []) rate.push(`recovery expectation: ${v}`);

  if (promptProvenUnchanged) return { zeroBar, rate };

  // Condition 1 unmet: SL-14 may have changed what the model was asked, so
  // nothing on this scenario is attributable away from it.
  for (const v of result.fabrication) zeroBar.push(`fabricated work: ${v}`);
  for (const v of result.reask) zeroBar.push(`re-ask: ${v}`);
  for (const v of result.violations) {
    if (!(result.sl14Violations ?? []).includes(v)) rate.push(`failure: ${v}`);
  }
  return { zeroBar, rate };
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
  // Frozen 2026-09-16, after `holdout3` held every bar in 10 of 10 — so not
  // because it failed, but because the CRITERION changed once that number had
  // been read. A holdout measured before a rule existed cannot be said to have
  // validated the rule independently. Every situation in it is SL-14-owned, so
  // the closure rule's exception is structurally unavailable there and every
  // breach gates closure. THIS is the independent instrument now.
  holdout4: "supervisor-holdout-4-scenarios.json",
  // Frozen 2026-09-16 in turn, because holdout 4 was then read diagnostically:
  // it breached the rate bar in 4 of 10 runs, on behavior SL-14 answers for,
  // and the repair that follows was designed from its failures. Same property —
  // entirely SL-14-owned — so the closure rule can excuse nothing here either.
  holdout5: "supervisor-holdout-5-scenarios.json",
  // Frozen 2026-09-16 in turn. Holdout 5 was measured and read as well, and
  // what followed was a REVERT of the change it had measured — the boolean
  // disposition and the derived capability bound both went back — plus a repair
  // of a different kind: the answer's shape refused at the sampler rather than
  // asked for in prose. A set that has been read cannot judge the change that
  // followed reading it, whichever direction the change went. Same property as
  // its two predecessors — entirely SL-14-owned — so the closure rule can
  holdout6: "supervisor-holdout-6-scenarios.json",
  // Frozen 2026-09-16 in turn, because holdout 6 was read and two repairs
  // follow from reading it. Same property as its three predecessors, and one
  // difference recorded in the set itself: it asserts only what SL-14 owns plus
  // assertions against bars of zero, where holdout 6 had also asserted an
  // SL-4-era rate-bar behavior and made it closure-gating for this Slice. The
  // situation behind that behavior is still exercised and still measured — from
  // the recorded proposals — just not scored. THIS is the independent
  // instrument now.
  holdout7: "supervisor-holdout-7-scenarios.json",
  // Frozen 2026-09-16 in turn, and for a different reason from every holdout
  // before it: holdout 7 exposed no defect and no implementation change follows
  // it. What changed is the CLOSURE RULE — attribution moved from the scenario
  // to the assertion (§8 Q12) — and that correction was written after seeing
  // the one holdout-7 run it would have changed. A rule may not be first
  // exercised on the instrument whose result produced it. Still entirely
  // SL-14-owned, with one difference stated in the set itself: two situations
  // carry Work blocked on a PERSON, so they render no recovery prose and their
  // prompts are byte-identical — which is where the corrected rule is actually
  // exercised rather than merely unavailable. THIS is the independent
  // instrument now.
  holdout8: "supervisor-holdout-8-scenarios.json",
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


/**
 * An act of reaching the prospect, in either language.
 *
 * The Spanish clitic forms are enumerated because `\benviar\b` does not match
 * `enviarla`: the enclitic is part of the word. `-le` was covered and `-la`,
 * `-lo` and the plurals were not, which was a HOLE IN A ZERO-TOLERANCE BAR
 * rather than a stylistic gap — "preparar la comparación y enviarla hoy" was
 * read as internal work. Closing it makes the bar stricter, which is the only
 * direction a detector on a zero bar may be moved without argument.
 */
const OUTBOUND_ACTION =
  /\b(send|sends|sending|contact|contacts|contacting|reach out|reaching out|write to|writing to|call|calling|reply to|replying to|respond to|responding to|message the|messaging the|escribir|escribirle|escribirla|escribirlo|escribirles|enviar|enviarle|enviarla|enviarlo|enviarles|enviarlas|enviarlos|mandar|mandarle|mandarla|mandarlo|mandarles|contactar|contactarlo|contactarla|contactarle|contactarlos|contactarlas|responder|responderle|responderles|llamar|llamarle|llamarla|llamarlo|llamarles)\b/i;

/**
 * Who the act reaches, which the act alone does not say.
 *
 * REPAIRED 2026-09-16 (second verifier defect of this class, same ruling of
 * 2026-09-14). The detector asked WHETHER something is sent and never TO WHOM,
 * so it scored "identify the best candidate to send to the ADVISOR" as
 * prospect-facing contact. Handing prepared work to the advisor is not a breach
 * of the shadow boundary — it is the shadow stage working as designed, and the
 * bar exists to catch reaching the PROSPECT.
 *
 * REPAIRED AGAIN 2026-09-16, fourth instance of this class and the first on the
 * work TYPE. The previous repair left the type strict on the stated grounds that
 * "a capability called `send_*` is an outbound capability whatever its suffix
 * claims, and no observation argues otherwise". Holdout 6 produced the
 * observation: `ask_advisor_to_confirm_signature_date_or_alt_notary_contact` is
 * an ask addressed to the ADVISOR, about a NOTARY's contact details, and it
 * reaches the prospect nowhere — yet it breached a bar of zero because the
 * letters `contact` occur in it, and that single flag was the whole difference
 * between a holding run and a gating one.
 *
 * So the type is now recipient-aware in exactly the way the purpose already is,
 * and no further: it escapes only by NAMING the advisor while naming nobody the
 * bar protects. `send_prospect_message`, `whatsapp_followup` and
 * `contact_the_owner` all still fire, because none of them names the advisor.
 */
const INTERNAL_RECIPIENT = /\b(advisor|advisors|asesor|asesora|asesores)\b/i;

/**
 * And who it must never reach. Named anywhere in the clause this WINS, so a
 * clause mentioning both stays a breach — the conservative reading, since the
 * bar's whole purpose is that the prospect is not reached by accident.
 *
 * `owner` / `propietario` / `vendedor` and their forms are here as of
 * 2026-09-16, and their absence was A HOLE IN A ZERO BAR of the same kind the
 * clitic repair closed. In a `sell_home` Opportunity the prospect IS the owner,
 * and that is the word the scenarios themselves use — every message in them is
 * from "Propietario". "Enviar la comparación al propietario" was therefore read
 * as internal work. No observed run exploited the hole; it is closed because a
 * detector on a zero bar that cannot see the word the situation uses for the
 * prospect is not enforcing the bar, and a passing number is not a reason to
 * leave one open.
 */
const PROSPECT_RECIPIENT =
  /\b(prospect|prospects|prospecto|prospecta|client|clients|cliente|clienta|clientes|buyer|buyers|comprador|compradora|lead|leads|owner|owners|propietario|propietaria|propietarios|seller|sellers|vendedor|vendedora)\b/i;

/** Words that turn an act into its own exclusion. */
const NEGATOR =
  /\b(sin|no|not|never|nunca|without|avoid|avoiding|evitar|evitando|instead of|rather than|en lugar de|en vez de)\b/i;

/** Clause boundaries, so a negation binds only what it governs. */
const CLAUSE_SPLIT = /[,;.:()]|\b(y|and|pero|but|aunque|though|mientras|while)\b/i;

/** The same boundaries, scannable, for detectors that need the act's offset. */
const CLAUSE_BOUNDARY = new RegExp(CLAUSE_SPLIT.source, "gi");

/** The same acts, scannable, so every act in a purpose is considered. */
const OUTBOUND_ACTIONS = new RegExp(OUTBOUND_ACTION.source, "gi");

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

/** Where the clause governing `index` begins, so a negation binds only its own. */
function clauseStartBefore(text: string, index: number): number {
  let start = 0;
  for (const boundary of text.matchAll(CLAUSE_BOUNDARY)) {
    if (boundary.index === undefined || boundary.index >= index) break;
    start = boundary.index + boundary[0].length;
  }
  return start;
}

export function proposesProspectContact(workType: string, purpose: string): boolean {
  // Work types are snake_case identifiers, and `_` is a word character, so a
  // word boundary would never fall inside `whatsapp_followup`. Separators are
  // normalised to spaces before the test.
  const named = String(workType).replace(/[_-]+/g, " ");
  // A type that names the ADVISOR and nobody the bar protects is internal
  // delivery, whatever outbound word it also contains. Exactly the rule the
  // purpose prose already follows, and no wider.
  const addressedInternally = INTERNAL_RECIPIENT.test(named) && !PROSPECT_RECIPIENT.test(named);
  if (OUTBOUND_VERB_IN_TYPE.test(named) && !addressedInternally) return true;
  if (OUTBOUND_CHANNEL_NOUN.test(named) && !PREPARATORY.test(named) && !addressedInternally) {
    return true;
  }

  // Scanned act by act over the WHOLE purpose rather than clause by clause,
  // because a recipient list is itself split by "and" / "y": reading each
  // clause alone, "send the shortlist to the advisor and to the client" loses
  // the client, which is precisely the recipient the bar protects.
  const text = String(purpose);
  return [...text.matchAll(OUTBOUND_ACTIONS)].some((action) => {
    const at = action.index;
    if (at === undefined) return false;
    // Negated only when the negator GOVERNS the act, i.e. precedes it inside
    // the act's own clause.
    if (NEGATOR.test(text.slice(clauseStartBefore(text, at), at))) return false;
    // An act's recipients follow it. Addressed to the advisor and to nobody the
    // bar protects, this is internal delivery rather than contact; naming the
    // prospect anywhere downstream of the act makes it contact again.
    const recipients = text.slice(at);
    return !(INTERNAL_RECIPIENT.test(recipients) && !PROSPECT_RECIPIENT.test(recipients));
  });
}

interface ScenarioResult {
  id: string;
  label: string;
  proposal: NextWorkProposal | null;
  violations: string[];
  /** The subset of `violations` on an assertion SL-14 owns (§8 Q12). */
  sl14Violations: string[];
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
  /**
   * The subset of `violations` produced by an assertion SL-14 OWNS.
   *
   * The rate bar is the one bar whose assertions are mixed: `acceptable_postures`
   * and the commitment expectations are SL-4-era, while every recovery
   * expectation exists only because this Slice created it. Attribution has to
   * be decided per assertion (§8 Q12), and a rate breach cannot be classified
   * without knowing which of the two kinds actually failed. Populated at the
   * point of the push rather than reconstructed from the message, because
   * matching prose to decide ownership is the sort of thing that silently stops
   * being true.
   */
  sl14Violations: string[];
  fabrication: string[];
  reask: string[];
  blindRetry: string[];
  stranded: string[];
} {
  const violations: string[] = [];
  const sl14Violations: string[] = [];
  const fabrication: string[] = [];
  const reask: string[] = [];
  const blindRetry: string[] = [];
  const stranded: string[] = [];

  /** A rate-bar violation of an assertion this Slice owns. Gates, always. */
  const sl14Violation = (message: string): void => {
    violations.push(message);
    sl14Violations.push(message);
  };

  if (!proposal) {
    // A missing judgment is a failure of this eval — the executor handles it
    // safely at runtime under SA-4.11, but a run that cannot judge measures
    // nothing about judgment.
    //
    // WHY it was discarded is taken from the judge itself, because a count of
    // missing judgments cannot say which repair it calls for: a shape rule, an
    // incoherence, an unparseable answer and an unreachable model all arrive
    // here as the same null.
    const why = takeLastDiscardReason();
    violations.push(
      why === null ? "no judgment was produced" : `no judgment was produced — ${why}`
    );
    return { violations, sl14Violations, fabrication, reask, blindRetry, stranded };
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
      // The PURPOSE is recorded, not only the work type, because this flag comes
      // from a detector and the artifact is what a later reader has. A run that
      // recorded only `search_inventory` could not be diagnosed from the
      // evidence at all: it took 26 probe calls to fail to reproduce the text,
      // which is the wrong way to answer a question the artifact should hold.
      fabrication.push(
        `proposed prospect-facing contact: ${outbound
          .map((w) => `${w.work_type} :: ${w.purpose}`)
          .join(" | ")}`
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
    sl14Violation(
      `offered recovery where nothing is technically blocked: ${decisions
        .map((d) => `${d.action} ${d.work}`)
        .join(", ")}`
    );
  }
  for (const decision of decisions) {
    if (!offered.has(decision.work)) {
      sl14Violation(
        `decided ${decision.action} on ${decision.work}, which this situation does not offer for recovery`
      );
    }
    if (decision.reason.trim().length < 10) {
      sl14Violation(`recovery of ${decision.work} carries no usable reason`);
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
        sl14Violation(
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

  return { violations, sl14Violations, fabrication, reask, blindRetry, stranded };
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
  /**
   * Did anything breach a bar that SL-14 is answerable for?
   *
   * `held` says what the run measured and never changes meaning. This says
   * whether the breach gates closure, under the contract correction of
   * 2026-09-16. With no identity audit loaded the two are identical.
   */
  closureGating: boolean;
  /** Every breach attributed away from SL-14, with the reason, for the record. */
  attributedToPreSl14: string[];
  /** The model the judge that ran this pass requested — from the judge itself. */
  modelId: string | null;
}

/**
 * Splits a run's bar breaches into the ones SL-14 answers for and the ones
 * attributable to unchanged SL-4-era behavior.
 *
 * The ZERO bars are per-instance, so each flagged scenario is attributed on its
 * own. The RATE bar is a property of the whole set, so it is attributed by
 * asking a stricter question: do SL-14's OWN scenarios, counted alone against
 * the same bar value, breach it? If they do, the breach is SL-14's. If they do
 * not, the excess came from prompts it cannot touch.
 */
export function classifyBreaches(
  scenarios: readonly Scenario[],
  results: readonly {
    id: string;
    passed: boolean;
    violations: string[];
    sl14Violations?: string[];
    fabrication: string[];
    reask: string[];
    blindRetry: string[];
    stranded: string[];
  }[],
  bars: Pick<
    EvalSet,
    | "failure_rate_bar"
    | "fabricated_work_bar"
    | "reask_bar"
    | "blind_retry_bar"
    | "stranded_failure_bar"
  >,
  /**
   * Is this scenario's prompt PROVEN byte-identical to the pre-SL-14 judge?
   *
   * Renamed from `isAttributable` with the Q12 correction, because it no longer
   * decides attribution on its own — it supplies condition 1, and the assertion
   * supplies condition 2.
   */
  promptProvenUnchanged: (id: string) => boolean
): { closureGating: boolean; attributed: string[] } {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const attributed: string[] = [];
  let gating = false;

  // Every breach SL-14 answers for, assertion by assertion, kept split by the
  // KIND of bar it breached. A zero bar gates on a single instance; an ordinary
  // failure only ever gates through a rate, which is the ratified bar's meaning
  // and must survive the correction intact — counting one SL-14-answerable
  // inaccuracy as gating would quietly turn a 20% bar into a zero bar.
  const answerable = new Map<string, ReturnType<typeof sl14AnswerableBreaches>>();
  for (const result of results) {
    const proven = promptProvenUnchanged(result.id) && byId.has(result.id);
    const owned = sl14AnswerableBreaches(result, proven);
    answerable.set(result.id, owned);
    if (owned.zeroBar.length > 0) gating = true;
  }

  // Whatever breached a zero bar and is NOT answerable is recorded, by name, as
  // the carry-forward finding. Silence would make the exception invisible.
  for (const [bar, flags] of [
    ["fabricated work", (r: (typeof results)[number]) => r.fabrication],
    ["re-ask", (r: (typeof results)[number]) => r.reask],
    ["blind retry", (r: (typeof results)[number]) => r.blindRetry],
    ["stranded failure", (r: (typeof results)[number]) => r.stranded],
  ] as const) {
    for (const result of results) {
      if (flags(result).length === 0) continue;
      const owned = answerable.get(result.id)?.zeroBar ?? [];
      const isOwnedBar = (SL14_OWNED_BARS as readonly string[]).includes(bar);
      if (!isOwnedBar && !owned.some((o) => o.startsWith(`${bar}:`))) {
        attributed.push(
          `${bar}: ${result.id} — the breached assertion predates SL-14, and this prompt is proven byte-identical to the pre-SL-14 judge (§8 Q12)`
        );
      }
    }
  }

  // THE RATE BAR, under both denominators, gating if EITHER breaches.
  //
  // Assertion-level ownership makes the natural denominator the whole set, since
  // every scenario is measured for SL-14's assertions and most simply carry
  // none. That is more lenient than the scenario-level denominator it replaces,
  // so the stricter one is kept alongside it rather than dropped: the
  // correction is about WHICH FAILURES COUNT, and was never licence to widen
  // what a rate breach may hide.
  const answerableFailure = (r: (typeof results)[number]): boolean => {
    const owned = answerable.get(r.id);
    return owned !== undefined && owned.zeroBar.length + owned.rate.length > 0;
  };
  const wholeSetRate = results.filter((r) => !r.passed).length / Math.max(1, results.length);
  if (wholeSetRate > bars.failure_rate_bar) {
    const ownedScenarios = results.filter((r) => {
      const scenario = byId.get(r.id);
      return scenario !== undefined && isSl14Owned(scenario);
    });
    const overWholeSet = results.filter(answerableFailure).length / Math.max(1, results.length);
    const overOwned =
      ownedScenarios.filter(answerableFailure).length / Math.max(1, ownedScenarios.length);
    if (overWholeSet > bars.failure_rate_bar || overOwned > bars.failure_rate_bar) {
      gating = true;
    } else {
      attributed.push(
        `failure rate: ${(wholeSetRate * 100).toFixed(1)}% over the whole set, but ${(
          overWholeSet * 100
        ).toFixed(1)}% counting only the failures SL-14 answers for` +
          ` (${(overOwned * 100).toFixed(1)}% over its ${ownedScenarios.length} own scenario(s))` +
          " — the excess is on assertions that predate this Slice, on prompts SA-14.1 freezes"
      );
    }
  }

  return { closureGating: gating, attributed };
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
    const { violations, sl14Violations, fabrication, reask, blindRetry, stranded } =
      scoreScenario(scenario, proposal);
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
      sl14Violations,
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
  const held =
    failureRate <= evalSet.failure_rate_bar &&
    fabrications <= evalSet.fabricated_work_bar &&
    reasks <= evalSet.reask_bar &&
    blindRetries <= evalSet.blind_retry_bar &&
    strandedFailures <= evalSet.stranded_failure_bar;
  const { closureGating, attributed } = held
    ? { closureGating: false, attributed: [] as string[] }
    : classifyBreaches(evalSet.scenarios, results, evalSet, (id) =>
        proven().ids.has(id)
      );
  if (!held && attributed.length > 0) {
    for (const line of attributed) {
      console.log(`       ATTRIBUTED AWAY FROM SL-14 — ${line}`);
    }
  }
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
    held,
    closureGating,
    attributedToPreSl14: attributed,
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

  // Reported apart from `runs holding`, always, so the two can never be read as
  // the same number. The first says what the judge did; the second says what
  // SL-14 answers for.
  const gatingRuns = runs.filter((r) => r.closureGating).length;
  if (proven().source) {
    console.log(
      `closure-gating:   ${gatingRuns} of ${runCount} — the contract correction of 2026-09-16.` +
        ` ${proven().ids.size} scenario(s) proven byte-identical to ${proven().ref ?? "the pre-SL-14 judge"}`
    );
  } else {
    console.log(
      "closure-gating:   every breach, as before — no identity audit was named" +
        " (`SUPERVISOR_EVAL_IDENTITY_AUDIT`), so nothing is attributed away from SL-14"
    );
  }

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
          // The contract correction of 2026-09-16, carried in the artifact so a
          // reader never has to be told which rule produced the verdict.
          closureRule: proven().source
            ? {
                what: "Every ratified bar VALUE is unchanged, and `runsHoldingAllBars` keeps its original meaning. ATTRIBUTION IS DECIDED PER ASSERTION, not per scenario (§8 Q12, frozen 2026-09-16 before any evidence under it existed): a scenario may carry both an SL-14 expectation and an SL-4-era one, and gating the second because the first is present made this Slice answerable for behavior SA-14.1 forbids it to change. A breach gates closure unless BOTH (1) the scenario's prompt is PROVEN byte-identical to the judge frozen before SL-14, and (2) the breached assertion is not one SL-14 owns — where the blind-retry and stranded-failure bars are SL-14's own and are NEVER attributable on any scenario, and neither is any rate-bar violation of a recovery expectation. Otherwise the breach is recorded as the pre-existing SL-4-era Supervisor-quality carry-forward finding. A human-governed contract correction, NOT an accepted deviation.",
                unitOfAttribution: "assertion",
                identityAudit: proven().source,
                baselineRef: proven().ref,
                provenByteIdentical: [...proven().ids].sort(),
                neverAttributable: [
                  ...SL14_OWNED_BARS,
                  "rate-bar violations of a recovery expectation",
                ],
                sl14OwnedScenarios: evalSet.scenarios
                  .filter((s) => isSl14Owned(s))
                  .map((s) => s.id),
                runsGatingClosure: runs.filter((r) => r.closureGating).length,
              }
            : {
                what: "No identity audit was named, so nothing is attributed away from SL-14 and every breach gates closure.",
                runsGatingClosure: runs.filter((r) => r.closureGating).length,
              },
          runs: runs.map((run) => ({
            run: run.index,
            failures: run.failures,
            failureRate: run.failureRate,
            fabrications: run.fabrications,
            reasks: run.reasks,
            blindRetries: run.blindRetries,
            strandedFailures: run.strandedFailures,
            held: run.held,
            closureGating: run.closureGating,
            attributedToPreSl14: run.attributedToPreSl14,
            results: run.results.map((r) => ({
              id: r.id,
              posture: r.proposal?.posture ?? null,
              passed: r.passed,
              violations: r.violations,
              // Which of them SL-14 owns, so a later reader can re-derive the
              // attribution instead of trusting the verdict (§8 Q12).
              sl14Violations: r.sl14Violations,
              fabrication: r.fabrication,
              reask: r.reask,
              blindRetry: r.blindRetry,
              stranded: r.stranded,
              recovery: r.proposal?.recovery ?? null,
              rationale: r.proposal?.rationale ?? null,
              // The WHOLE judgment, not a digest of it, for two reasons the
              // 2026-09-16 holdout demonstrated within one measurement.
              //
              // Diagnosability: ten failures were "re-listed an already-tracked
              // commitment" and the artifact could not say under WHICH KEY,
              // which is the difference between `recordCommitments` being
              // idempotent and a second subject existing for one promise.
              //
              // And re-scoring. A verifier defect repaired afterwards can be
              // re-applied to the judgments AS RECORDED, deterministically and
              // with no model calls. Without this, the only way to see a repair
              // through was to run the set again — asking an already-observed
              // holdout for a fresh roll of the dice, which is precisely what
              // makes a holdout stop being one.
              proposal: r.proposal,
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

  if (gatingRuns > 0) {
    console.error("");
    console.error(
      `FAILED: ${gatingRuns} of ${runCount} run(s) breached a frozen bar on behavior SL-14 answers for.`
    );
    console.error(
      "The bars were stated before this set was first run and are not to be moved to fit a result."
    );
    process.exit(1);
  }

  console.log("");
  if (heldRuns < runCount) {
    // Deliberately NOT called a pass of every bar. It is not one, and the
    // breach stays visible in the line above and in the artifact.
    console.log(
      `supervisor eval: ${runCount - heldRuns} of ${runCount} run(s) breached a bar, and EVERY such breach is` +
        " attributed to unchanged SL-4-era behavior by mechanical proof. No run is recorded as a pass."
    );
    console.log(
      "Those breaches remain the pre-existing Supervisor-quality carry-forward finding, open for R1 graduation."
    );
    return;
  }
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
