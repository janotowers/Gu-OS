/**
 * The model-mediated half of the Case Supervisor (R1 SL-4).
 *
 * S2's whole thesis is that fixed rules are what R1 replaces, so this module is
 * the whole of one side of the Methodology §13 line. Four judgments live here
 * and nowhere else:
 *
 *   - does useful, allowed work exist right now?
 *   - which next work is genuinely most useful?
 *   - is a deliberate no-op or wait the correct answer?
 *   - has a commitment been made that someone is now relying on?
 *
 * What this module deliberately cannot do:
 *
 *  - **it never acts, and it cannot ask to.** The proposal's posture vocabulary
 *    is restricted to what a shadow Slice can reach, so there is no output
 *    shape in which the model can request a prospect-facing effect. SA-4.8 is
 *    then asserted deterministically on top of that rather than trusted to it;
 *  - **it never sees or overrides a hard bound.** Delivery restrictions,
 *    tenancy and flags are resolved by the executor before and after this call.
 *    Passing an explicit "not before X" into the prompt would invite a
 *    confident model to argue around AC-03 instead of the executor enforcing
 *    it. What the model is told is only that outbound is currently unavailable
 *    — the same thing shadow makes true anyway;
 *  - **it is not a rule forest.** When the model is unavailable the result is
 *    `null` — "no judgment was made" — and the executor turns that into a
 *    preserved-uncertainty reconsideration under SA-4.11. Substituting a
 *    keyword table would quietly replace the judgment this Slice exists to
 *    measure, which is precisely the anti-pattern Methodology §13 names.
 *
 * No governing artifact selects a model, so the id is configuration.
 */
import { z } from "zod";
import {
  RELATIONSHIP_SUPERVISOR_MODEL_ID,
  recordOpenRouterCallUsage,
} from "@agents/agent";
import type { CommitmentActor, SupervisorPosture } from "@agents/types";

/**
 * The postures the model may propose.
 *
 * A strict subset of `SupervisorPosture`, and the subset is the point: `act`,
 * `act_and_inform`, `prepare_and_approval`, `human_as_executor` and
 * `human_takeover_support` are absent from the schema, so a model that wanted
 * to send a message has no field in which to say so. That is a structural
 * guarantee rather than an instruction it might ignore.
 */
export const PROPOSABLE_POSTURES = [
  "no_op",
  "wait",
  "gather_research_reconcile",
  "work",
  "targeted_human_input",
] as const satisfies readonly SupervisorPosture[];

export const NextWorkProposalSchema = z.object({
  posture: z.enum(PROPOSABLE_POSTURES),
  /**
   * The current progress constraint or advancement opportunity, named before a
   * posture is chosen (S2 §8.1 invariant 3: diagnose before acting). Null when
   * the evidence does not support a diagnosis — a finding, not a blank.
   */
  diagnosis: z.string().nullable(),
  /** One short explanation grounded in the evidence actually available now. */
  rationale: z.string(),
  /**
   * True when the model judges the available evidence too thin for a grounded
   * situational judgment. SA-4.11: the honest answer, never a reason to
   * manufacture work that looks decisive.
   */
  insufficient_evidence: z.boolean(),
  /**
   * A capability the situation needs and Gu does not have (S2 invariant 36,
   * EC-25). Exposed as a gap, never worked around.
   */
  capability_gap: z.string().nullable(),
  /**
   * Bounded internal work worth doing now. Empty for `no_op` and `wait`.
   * Free-text intent, not a tool call: what becomes durable Work and what stays
   * inline is the executor's decision under S2 §8.16.
   */
  proposed_work: z.array(
    z.object({
      /** Short stable label, e.g. `verify_property_availability`. */
      work_type: z.string(),
      /** Why this work advances the Opportunity now. */
      purpose: z.string(),
      /** True when it must survive the session — retry, wait, human, effect. */
      durable: z.boolean(),
    })
  ),
  /**
   * Commitments visible in the evidence that someone is reasonably relying on
   * (S2 §8.13). Detecting one is semantic; recording it durably is not.
   */
  commitments: z.array(
    z.object({
      /** The specific expected outcome, in plain language. */
      expected_outcome: z.string(),
      actor: z.enum(["gu", "advisor", "prospect", "external"]),
      /** ISO date or datetime when it is relied upon, when one is stated. */
      due_at: z.string().nullable(),
      /** True when the moment was stated outright rather than inferred. */
      due_stated: z.boolean(),
      /** Stable key so the same commitment is not re-created on every wake. */
      key: z.string(),
    })
  ),
  /**
   * How long until this Opportunity is worth thinking about again, in hours.
   * A *scheduled reconsideration*, never a scheduled action (S2 §8.13). Null
   * when the model believes only an external signal should wake the Case; the
   * executor still refuses to leave no wake path at all (EC-39).
   */
  reconsider_in_hours: z.number().nullable(),
});

export type NextWorkProposal = z.infer<typeof NextWorkProposalSchema>;

/** One Opportunity's current situation. Content only — never ids, never policy. */
export interface SupervisorJudgeInput {
  /** Why this reconsideration is running, in plain words. */
  wakeReason: string;
  /** The objective as recorded at admission, in the prospect's own terms. */
  objective: string | null;
  objectiveCategory: string | null;
  /** Current accepted facts, as `key: value` lines. */
  currentFacts: readonly string[];
  /** Recent inbound and outbound messages, oldest first. */
  recentMessages: readonly string[];
  /** Open commitments already tracked, so they are not re-created. */
  openCommitments: readonly string[];
  /** Open, blocked and recently settled Work, summarized. */
  workSummary: readonly string[];
  /** What earlier reconsiderations concluded, oldest first. */
  postureHistory: readonly string[];
  /** Days since the last inbound prospect message, when known. */
  daysSinceLastInbound: number | null;
  /**
   * Whether prospect-facing contact is currently available at all.
   *
   * In SL-4 this is always false, because the stage is shadow. It is passed
   * rather than hard-coded into the prompt so that the reason a model gives for
   * choosing internal work stays truthful, and so the seam does not have to be
   * re-cut when a later Slice makes it sometimes true. The model is never told
   * *why* it is unavailable — that is the executor's business.
   */
  outboundAvailable: boolean;
  /** Capabilities available for internal work, by name. */
  availableCapabilities: readonly string[];
}

export interface NextWorkJudge {
  /** Returns a proposal, or null when no judgment could be made. */
  propose(input: SupervisorJudgeInput): Promise<NextWorkProposal | null>;
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export function normalizeNextWorkProposal(value: unknown): NextWorkProposal | null {
  const parsed = NextWorkProposalSchema.safeParse(value);
  if (!parsed.success) return null;
  const proposal = parsed.data;

  // Structural coherence the schema cannot express. A posture that means "do
  // nothing now" carrying proposed work is not a judgment this executor can
  // act on coherently, and silently dropping one half would misreport what the
  // model actually said. Treat it as no judgment.
  const quiet = proposal.posture === "no_op" || proposal.posture === "wait";
  if (quiet && proposal.proposed_work.length > 0) return null;
  if (!quiet && proposal.proposed_work.length === 0) return null;
  return proposal;
}

function section(label: string, lines: readonly string[]): string {
  if (lines.length === 0) return `${label}: (none)`;
  return `${label}:\n${lines.map((l) => `  - ${l}`).join("\n")}`;
}

export function buildNextWorkPrompt(input: SupervisorJudgeInput): string {
  return [
    "You are the situational supervisor of ONE real-estate lead Opportunity. A wake-up has occurred. Decide what work, if any, is genuinely useful RIGHT NOW.",
    "Return ONLY compact JSON matching this shape:",
    '{"posture":"no_op|wait|gather_research_reconcile|work|targeted_human_input","diagnosis":string|null,"rationale":string,"insufficient_evidence":boolean,"capability_gap":string|null,"proposed_work":[{"work_type":string,"purpose":string,"durable":boolean}],"commitments":[{"expected_outcome":string,"actor":"gu|advisor|prospect|external","due_at":string|null,"due_stated":boolean,"key":string}],"reconsider_in_hours":number|null}',
    "",
    "Rules:",
    "- A wake-up is RECONSIDERATION, not action. A timer firing, a Case existing, or silence lasting N days is never by itself a reason to do anything.",
    "- Diagnose before choosing: name what currently constrains progress, or what real opportunity exists to advance it.",
    "- `no_op` is a correct, expected answer when no useful work exists. Do NOT manufacture activity to look busy. Choosing nothing deliberately is a better answer than inventing a task.",
    "- `wait` is for when something specific is expected from someone else and waiting is the strategy. `no_op` is for when nothing useful exists at all.",
    "- The best next work often improves the NEXT decision rather than producing the next interaction: verifying a fact, reconciling conflicting evidence, or gathering what is missing.",
    "- Prefer stopping to looping. If earlier reconsiderations already tried the same thing without new information, change strategy, wait, or stop — do not repeat it.",
    "- Only propose work that is bounded and clearly worth its cost. Do not propose research because research is possible.",
    "- `durable` is true only when the work must survive this session: it can fail and need retry, it waits on someone, or it produces a material effect. Ordinary reading and reasoning is not durable work.",
    "- A commitment is a SPECIFIC expected outcome someone is reasonably relying on, with an actor, that would matter if forgotten. A vague intention is not a commitment. Do not re-list commitments that are already tracked.",
    "- `key` for a commitment must be short, lowercase, and stable across wake-ups for the SAME promise, so it is not recorded twice.",
    "- If the evidence is too thin to judge, say so with insufficient_evidence and choose no_op. Never fabricate certainty or unsupported work.",
    "- If the situation needs a capability that is not listed as available, name it in capability_gap rather than inventing a workaround.",
    "- rationale is one short sentence naming the evidence you used.",
    "",
    input.outboundAvailable
      ? "Prospect-facing contact is currently available."
      : "Prospect-facing contact is NOT available right now. Choose only internal work, waiting, or nothing. Do not propose messaging the prospect.",
    "",
    `Wake reason: ${input.wakeReason}`,
    `Objective: ${JSON.stringify(input.objective ?? "")}`,
    input.objectiveCategory ? `Objective category: ${input.objectiveCategory}` : "",
    input.daysSinceLastInbound === null
      ? "Days since last inbound message: unknown"
      : `Days since last inbound message: ${input.daysSinceLastInbound}`,
    "",
    section("Current facts", input.currentFacts),
    section("Recent messages (oldest first)", input.recentMessages),
    section("Commitments already tracked", input.openCommitments),
    section("Work", input.workSummary),
    section("Earlier reconsiderations (oldest first)", input.postureHistory),
    section("Capabilities available for internal work", input.availableCapabilities),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The production judge.
 *
 * Returns null on every failure path — no key, non-2xx, unparseable or
 * incoherent content — because a fabricated proposal is worse than none. SA-4.11
 * makes "no judgment" a first-class, recorded outcome that preserves the
 * uncertainty and leaves a re-entry path, so the executor has somewhere
 * coherent to put this.
 *
 * Usage is metered through the ambient AI-usage context, so the Organization
 * that incurred the call is the one the cost correlates to (TP §7 (a)).
 */
export function createOpenRouterNextWorkJudge(): NextWorkJudge {
  return {
    async propose(input) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) return null;
      const model = RELATIONSHIP_SUPERVISOR_MODEL_ID;
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": "https://agents.local",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 700,
            response_format: { type: "json_object" },
            usage: { include: true },
            messages: [
              {
                role: "system",
                content:
                  "You are a strict JSON decision function. Never call tools. Never answer conversationally.",
              },
              { role: "user", content: buildNextWorkPrompt(input) },
            ],
          }),
        });
      } catch (error) {
        void recordOpenRouterCallUsage({
          modelId: model,
          modelRole: "relationship_supervisor_next_work",
          operation: "classification",
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorCode: "network_error",
        });
        console.warn("[relationship-supervisor] next-work judge unreachable:", error);
        return null;
      }

      if (!response.ok) {
        void recordOpenRouterCallUsage({
          modelId: model,
          modelRole: "relationship_supervisor_next_work",
          operation: "classification",
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorCode: `http_${response.status}`,
        });
        console.warn(
          "[relationship-supervisor] next-work judge failed:",
          response.status
        );
        return null;
      }

      const json = (await response.json()) as {
        id?: string;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: Record<string, unknown>;
      };

      void recordOpenRouterCallUsage({
        modelId: model,
        modelRole: "relationship_supervisor_next_work",
        operation: "classification",
        latencyMs: Date.now() - startedAt,
        status: "ok",
        providerRequestId: typeof json.id === "string" ? json.id : null,
        usage: json.usage as never,
      });

      try {
        return normalizeNextWorkProposal(
          parseJsonContent(json.choices?.[0]?.message?.content)
        );
      } catch {
        return null;
      }
    },
  };
}

export type { CommitmentActor };
