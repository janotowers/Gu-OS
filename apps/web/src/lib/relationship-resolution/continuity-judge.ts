/**
 * The model-mediated half of resolution (R1 SL-3).
 *
 * The Slice contract draws one line and this module is the whole of one side of
 * it: **whether two Opportunity Cases represent the same underlying objective**
 * is semantic judgment — including where their facts conflict (S1 AC-15) and
 * where a substantial criteria change may still be one objective (EC-05). It is
 * made here, by a model, and evidenced by an eval set with a stated bar.
 *
 * What this module deliberately cannot do:
 *
 *  - **it never returns "resolve".** `ContinuityProposal` has no such field.
 *    The executor takes a governed determination and applies flags, tenancy and
 *    the two-operation contract to it, so no model output reaches a durable
 *    write without passing a deterministic gate;
 *  - **it never decides direction.** Which Opportunity survives is not a
 *    semantic question about sameness, and ADR-109 §7 explicitly leaves
 *    survivor/canonicalization algorithms downstream. Asking the model would be
 *    inventing product truth this Slice does not own;
 *  - **it is not a similarity score with a threshold.** No governing artifact
 *    approves one, and a number would look like a decision rule while hiding
 *    the judgment it replaced;
 *  - **it does not fall back to string matching.** When the model is
 *    unavailable the result is `null` — "no judgment was made". S1 §8.5.3 and
 *    EC-05 prefer continuity, and the risk table is explicit that **a false
 *    merge is worse than a missed one**, because it conflates two real
 *    objectives. No judgment therefore means no resolution, which is the
 *    conservative outcome.
 *
 * No governing artifact selects a model, so the id is configuration.
 */
import { z } from "zod";
import {
  RELATIONSHIP_CONTINUITY_MODEL_ID,
  recordOpenRouterCallUsage,
} from "@agents/agent";

export const ContinuityProposalSchema = z.object({
  same_objective: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  /**
   * S1 AC-15: the pair carries facts that disagree. An observation, not a
   * verdict — conflicting facts do not by themselves make two Opportunities
   * distinct, and preserving both sides' evidence is a deterministic guarantee
   * (SA-3.6) rather than something this flag switches on.
   */
  conflicting_facts: z.boolean(),
  rationale: z.string(),
});

export type ContinuityProposal = z.infer<typeof ContinuityProposalSchema>;

/** One Opportunity, as the judge sees it. Content only — never ids, never policy. */
export interface OpportunitySummary {
  /** The objective as recorded at admission, in the prospect's own terms. */
  objective: string | null;
  /** Coarse category, when one was determined. */
  objectiveCategory: string | null;
  /** What the prospect asked for: zone, budget, size, timing — free text. */
  requirements: readonly string[];
  /** Property or listing context surrounding the Opportunity. */
  propertyContext: string | null;
  /** Recent inbound messages, oldest first, for context only. */
  recentMessages: readonly string[];
}

export interface ContinuityJudgeInput {
  left: OpportunitySummary;
  right: OpportunitySummary;
}

export interface ContinuityJudge {
  /** Returns a proposal, or null when no judgment could be made. */
  judge(input: ContinuityJudgeInput): Promise<ContinuityProposal | null>;
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export function normalizeContinuityProposal(
  value: unknown
): ContinuityProposal | null {
  const parsed = ContinuityProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function describeOpportunity(label: string, o: OpportunitySummary): string {
  return [
    `${label}:`,
    `  objective: ${JSON.stringify(o.objective ?? "")}`,
    o.objectiveCategory ? `  category: ${o.objectiveCategory}` : "",
    o.requirements.length > 0
      ? `  requirements: ${JSON.stringify(o.requirements)}`
      : "",
    o.propertyContext ? `  property context: ${o.propertyContext}` : "",
    o.recentMessages.length > 0
      ? `  recent messages: ${JSON.stringify(o.recentMessages.slice(-5))}`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildContinuityPrompt(input: ContinuityJudgeInput): string {
  return [
    "You judge whether two real-estate Opportunity records represent the SAME underlying commercial objective of the same prospect, or two materially distinct objectives.",
    "Return ONLY compact JSON matching this shape:",
    '{"same_objective":boolean,"conflicting_facts":boolean,"confidence":"high|medium|low","rationale":string}',
    "",
    "Rules:",
    "- The same objective can be described differently, with different levels of detail, or through different channels. Wording differences are not evidence of distinctness.",
    "- Requirements that CHANGED over time — a different budget, a different zone, a larger property — usually still describe ONE evolving objective, not two. Prefer continuity.",
    "- Two objectives are distinct when they are about materially different things the prospect wants to pursue INDEPENDENTLY — for example buying a home AND separately listing a different property they own, or a purchase and an unrelated commercial lease.",
    "- A buy objective and a rent objective for the same need are usually ONE objective under consideration, not two, unless the prospect is clearly pursuing both in parallel.",
    "- conflicting_facts is true when the two records assert things that cannot both be current — a different stated budget, zone or timeline. It is an observation only; conflicting facts do NOT by themselves make the objectives distinct.",
    "- ABSENCE of evidence is not evidence of sameness. Two records that are both empty, both generic, or both say nothing beyond a greeting or a request for information are two UNKNOWN objectives, not one shared objective. Judge them distinct — looking alike because neither says anything is not a similarity.",
    "- Sameness must rest on something POSITIVE the two records share: the same property, the same stated need, the same requirements, or an explicit continuation. If you cannot name that shared thing in your rationale, the answer is false.",
    "- Being WRONG that two objectives are the same is worse than missing that they are. When the evidence is genuinely thin, answer false and say why.",
    "- Do not decide which record should survive. That is not your call.",
    "- rationale is one short sentence naming the evidence you used.",
    "",
    describeOpportunity("Opportunity A", input.left),
    "",
    describeOpportunity("Opportunity B", input.right),
  ].join("\n");
}

/**
 * The production judge.
 *
 * Returns null on every failure path — no key, non-2xx, unparseable content —
 * because a fabricated proposal would be worse than none: no judgment means no
 * resolution, and an unresolved duplicate is recoverable while a false merge
 * conflates two real objectives.
 *
 * Usage is metered through the ambient AI-usage context, so the Organization
 * that incurred the call is the one the cost correlates to (TP §7 (a)).
 */
export function createOpenRouterContinuityJudge(): ContinuityJudge {
  return {
    async judge(input) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) return null;
      const model = RELATIONSHIP_CONTINUITY_MODEL_ID;
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
            max_tokens: 320,
            response_format: { type: "json_object" },
            usage: { include: true },
            messages: [
              {
                role: "system",
                content:
                  "You are a strict JSON classifier. Never call tools. Never answer conversationally.",
              },
              { role: "user", content: buildContinuityPrompt(input) },
            ],
          }),
        });
      } catch (error) {
        void recordOpenRouterCallUsage({
          modelId: model,
          modelRole: "relationship_continuity_judge",
          operation: "classification",
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorCode: "network_error",
        });
        console.warn("[relationship-resolution] continuity judge unreachable:", error);
        return null;
      }

      if (!response.ok) {
        void recordOpenRouterCallUsage({
          modelId: model,
          modelRole: "relationship_continuity_judge",
          operation: "classification",
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorCode: `http_${response.status}`,
        });
        console.warn(
          "[relationship-resolution] continuity judge failed:",
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
        modelRole: "relationship_continuity_judge",
        operation: "classification",
        latencyMs: Date.now() - startedAt,
        status: "ok",
        providerRequestId: typeof json.id === "string" ? json.id : null,
        usage: json.usage as never,
      });

      try {
        return normalizeContinuityProposal(
          parseJsonContent(json.choices?.[0]?.message?.content)
        );
      } catch {
        return null;
      }
    },
  };
}
