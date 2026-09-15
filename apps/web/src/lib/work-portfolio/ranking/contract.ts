/**
 * The contextual ranking pass's contract — R1 SL-12 (Portfolio v2), Technical
 * Plan TD-9 v2 and its v1.16 clarifications, Slice Plan SL-12.
 *
 * WHAT THE MODEL SEES. One bounded input built from SL-7's authorized
 * snapshot, after authorization and after the deterministic predicates
 * (AC-9 §14.2). It is content and short aliases only — `c3`, `c3.f2`,
 * `c3.w1` — never a row id, never an Organization, never a person. The aliases
 * are what a claim cites; the frame maps them back to durable rows, so
 * grounding is checked against the snapshot, not against the model's word.
 *
 * WHAT THE MODEL MAY SAY. An order over the cases that need a human, and — for
 * a case with no governed need — a discretionary admission explained by three
 * claims that each cite the case's own aliases. It cannot remove a governed
 * item, create an obligation, or write anything: the deterministic merge
 * (`merge.ts`) decides what of its answer is kept.
 */
import { z } from "zod";
import type { DurableRef, MustSurfacePredicate } from "@agents/types";

// ============================================================
// Bounds — engineering values, not product thresholds (Methodology §14.1)
// ============================================================

/** Cases in one ranking input. SL-7 reads at most 200; the pass sees fewer. */
export const RANKING_MAX_CASES = 40;
export const RANKING_MAX_FACTS_PER_CASE = 12;
export const RANKING_MAX_COMMITMENTS_PER_CASE = 5;
export const RANKING_MAX_WORK_PER_CASE = 6;
export const RANKING_MAX_RECONSIDERATIONS_PER_CASE = 3;
/** Any one string copied into the input. Longer text is cut, and says so. */
export const RANKING_MAX_TEXT_CHARS = 300;
/** One call per Portfolio load; past this the deterministic order stands. */
export const RANKING_TIMEOUT_MS = 20_000;

// ============================================================
// Input
// ============================================================

export interface RankingGovernedNeed {
  ref: string;
  predicate: MustSurfacePredicate;
  why: string;
  what_gu_needs: string;
  why_now: string;
}

export interface RankingCaseInput {
  /** `c1`, `c2`, … — this load's alias for the Case. */
  ref: string;
  objective: string | null;
  runtime_authority: "legacy" | "gu_os" | "unset";
  /** Where SL-7's deterministic projection placed the Case. */
  section: "needs_attention" | "gu_handling" | "waiting" | "not_reconsidered";
  /** Governed must-surface needs, as SL-7 states them. Non-empty = in the floor. */
  governed: RankingGovernedNeed[];
  facts: Array<{ ref: string; key: string; value: string; recorded_at: string }>;
  commitments: Array<{
    ref: string;
    expected: string | null;
    actor: string | null;
    status: string | null;
    due: string | null;
  }>;
  work: Array<{
    ref: string;
    work_type: string;
    status: string;
    purpose: string | null;
    blocked_reason: string | null;
  }>;
  /** The latest reconsiderations, oldest first. */
  reconsiderations: Array<{
    ref: string;
    at: string;
    posture: string;
    diagnosis: string | null;
    rationale: string;
    outcome: string | null;
  }>;
  days_since_update: number;
}

export interface RankingInput {
  /** Evaluation time, so "due" and "since" are judged against a stated clock. */
  now: string;
  /** The viewer's Organization role: attention is actor-relative (S4 §6.7). */
  actor_role: string;
  cases: RankingCaseInput[];
}

// ============================================================
// Output
// ============================================================

const ClaimSchema = z.object({
  text: z.string().trim().min(1).max(400),
  refs: z.array(z.string()).min(1).max(8),
});

export const RankingOutputSchema = z.object({
  items: z
    .array(
      z.object({
        case: z.string(),
        /** `governed` for a case already in the floor, `contextual` to admit one. */
        kind: z.enum(["governed", "contextual"]),
        /** 1 is the most important. */
        priority: z.number().int().min(1),
        why: ClaimSchema.nullish(),
        what_gu_needs: ClaimSchema.nullish(),
        why_now: ClaimSchema.nullish(),
      })
    )
    .max(RANKING_MAX_CASES),
});

export type RankingOutput = z.infer<typeof RankingOutputSchema>;
export type RankingClaim = z.infer<typeof ClaimSchema>;

// ============================================================
// Frame — the input plus what the merge needs to check it
// ============================================================

export interface RankingFrameCase {
  ref: string;
  case_id: string;
  governed: boolean;
  /** Every alias this case's input exposes, mapped to the row it stands for. */
  refs: Readonly<Record<string, DurableRef>>;
}

export interface RankingFrame {
  input: RankingInput;
  cases: RankingFrameCase[];
}

// ============================================================
// Judge
// ============================================================

export type RankingJudgeResult =
  | { ok: true; output: RankingOutput }
  | { ok: false; reason: "model_unavailable" | "model_error" | "invalid_output" };

export interface PortfolioRankingJudge {
  /** The model this judge requests, or null when none is involved (a stub). */
  readonly modelId: string | null;
  rank(input: RankingInput, signal: AbortSignal): Promise<RankingJudgeResult>;
}
