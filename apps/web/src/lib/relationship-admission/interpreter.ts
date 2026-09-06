/**
 * The model-mediated half of admission (R1 SL-2).
 *
 * The Slice contract draws one line and this module is the whole of one side of
 * it: **whether an inbound message expresses a real, actionable buy/rent
 * objective** (S1 AC-01), **whether it is an ambiguous opener that warrants
 * engagement without a Case** (AC-02, EC-01), and **which coarse category a
 * stated objective falls into** (EC-03) are semantic judgments. They are made
 * here, by a model, and evidenced by an eval set.
 *
 * What this module deliberately cannot do:
 *
 *  - it never returns "admit". `AdmissionProposal` has no such field. The
 *    executor applies hard bounds, policy, idempotency and tenancy to a
 *    proposal, so no model output can relax a deterministic gate;
 *  - it never sees policy. Passing the Organization's excluded categories into
 *    the prompt would let a confident model argue its way around EC-03 instead
 *    of the executor enforcing it;
 *  - it is not a regex or keyword forest. When the model is unavailable the
 *    result is `null` — "no judgment was made" — and the executor treats that
 *    as ambiguity, which creates no Case. Substituting a dictionary here would
 *    quietly replace the judgment the Slice is meant to evidence.
 *
 * No governing artifact selects a model, so the id is configuration.
 */
import { z } from "zod";
import {
  RELATIONSHIP_ADMISSION_MODEL_ID,
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "@agents/agent";
import type { AdmissionProposal } from "@agents/types";

export const AdmissionProposalSchema = z.object({
  has_actionable_objective: z.boolean(),
  objective: z.string().nullable(),
  objective_category: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string(),
});

/** One inbound situation to interpret. Content only — never policy, never ids. */
export interface AdmissionInterpreterInput {
  /** Most recent inbound prospect message, when the event carried one. */
  message: string | null;
  /** Surrounding context that legitimately carries intent (S1 §8.4.3). */
  sourceLabel: string | null;
  originLabel: string | null;
  propertyContext: string | null;
  /** Earlier messages in the thread, oldest first, for context only. */
  priorMessages: readonly string[];
}

export interface AdmissionInterpreter {
  /** Returns a proposal, or null when no judgment could be made. */
  interpret(input: AdmissionInterpreterInput): Promise<AdmissionProposal | null>;
}

/**
 * Coarse objective categories the interpreter may return.
 *
 * A closed list, because `excluded_categories` in Organization policy is matched
 * against it: if the interpreter could invent category names, an Organization
 * could never write an exclusion that reliably matches (EC-03).
 */
export const ADMISSION_OBJECTIVE_CATEGORIES = [
  "buy_residential",
  "rent_residential",
  "buy_commercial",
  "rent_commercial",
  "land",
  "vacation_rental",
  "sell_or_list_property",
  "other",
] as const;

export type AdmissionObjectiveCategory =
  (typeof ADMISSION_OBJECTIVE_CATEGORIES)[number];

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export function normalizeProposal(value: unknown): AdmissionProposal | null {
  const parsed = AdmissionProposalSchema.safeParse(value);
  if (!parsed.success) return null;
  const category = parsed.data.objective_category;
  return {
    ...parsed.data,
    // An unrecognized category is normalized to `other` rather than passed
    // through: policy exclusions match against the closed list, and an
    // invented name would silently miss every exclusion an Organization wrote.
    objective_category: category
      ? ((ADMISSION_OBJECTIVE_CATEGORIES as readonly string[]).includes(category)
          ? category
          : "other")
      : null,
  };
}

export function buildInterpreterPrompt(
  input: AdmissionInterpreterInput
): string {
  return [
    "You judge whether an inbound real-estate prospect contact expresses a real, actionable commercial objective (buying, renting, or listing a property).",
    "Return ONLY compact JSON matching this shape:",
    '{"has_actionable_objective":boolean,"objective":string|null,"objective_category":string|null,"confidence":"high|medium|low","rationale":string}',
    "",
    `objective_category must be one of: ${ADMISSION_OBJECTIVE_CATEGORIES.join(", ")}.`,
    "",
    "Rules:",
    "- The surrounding context counts as evidence, not only the message text. A short message such as '¿sigue disponible?' or '¿precio?' can be actionable when the campaign, portal or property context makes the commercial intent reasonably clear.",
    "- An isolated greeting with no context ('Hola', 'Buenas tardes') is NOT actionable: it warrants clarification, not responsibility.",
    "- Full qualification is NOT required. Missing budget, zone, timing or financing does not make an objective unactionable.",
    "- objective is a one-line summary in the prospect's own terms, or null when there is no discernible objective.",
    "- Do not decide whether the organization should accept this lead. Judge only what the prospect is trying to achieve.",
    "- rationale is one short sentence naming the evidence you used.",
    "",
    input.sourceLabel ? `source: ${input.sourceLabel}` : "",
    input.originLabel ? `origin: ${input.originLabel}` : "",
    input.propertyContext ? `property context: ${input.propertyContext}` : "",
    input.priorMessages.length > 0
      ? `earlier messages: ${JSON.stringify(input.priorMessages.slice(-5))}`
      : "",
    `message: ${JSON.stringify(input.message ?? "")}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The production interpreter.
 *
 * Returns null on every failure path — no key, non-2xx, unparseable content —
 * because a fabricated proposal would be worse than none: the executor reads
 * null as ambiguity and creates no Case, which is the conservative outcome.
 *
 * Usage is metered through the ambient AI-usage context, so the Organization
 * that incurred the call is the one the cost correlates to (TP §7 (a)).
 */
export function createOpenRouterAdmissionInterpreter(): AdmissionInterpreter {
  return {
    async interpret(input) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) return null;
      const model = RELATIONSHIP_ADMISSION_MODEL_ID;
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
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
                { role: "user", content: buildInterpreterPrompt(input) },
              ],
            }),
          }
        );
      } catch (error) {
        void recordOpenRouterCallUsage({
          modelId: model,
          modelRole: "relationship_admission_interpreter",
          operation: "classification",
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorCode: "network_error",
        });
        console.warn("[relationship-admission] interpreter unreachable:", error);
        return null;
      }

      if (!response.ok) {
        void recordOpenRouterCallUsage({
          modelId: model,
          modelRole: "relationship_admission_interpreter",
          operation: "classification",
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorCode: `http_${response.status}`,
        });
        console.warn(
          "[relationship-admission] interpreter failed:",
          response.status
        );
        return null;
      }

      const json = (await response.json()) as {
        id?: string;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: OpenRouterUsagePayload;
      };
      void recordOpenRouterCallUsage({
        modelId: model,
        modelRole: "relationship_admission_interpreter",
        operation: "classification",
        usage: json.usage ?? null,
        providerRequestId: typeof json.id === "string" ? json.id : null,
        latencyMs: Date.now() - startedAt,
      });

      try {
        return normalizeProposal(
          parseJsonContent(json.choices?.[0]?.message?.content)
        );
      } catch {
        return null;
      }
    },
  };
}
