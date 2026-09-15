/**
 * Work Portfolio vocabulary — Relationship Operations S4, R1 SL-7 (the
 * deterministic floor, Technical Plan TD-9 v1).
 *
 * The Portfolio is a projection, never a second source of truth (S4
 * invariant 1, AC-9 §14.1). Everything typed here is either a view-model over
 * durable Case / Fact / Work / Approval truth, or the one piece of state the
 * Portfolio owns: a person's presentation preferences, which by construction
 * cannot resolve, close or delay anything (S4 §6.8).
 */
import type { DurableRef, HumanInteractionPayload } from "./human-interaction";

// ============================================================
// Governed must-surface predicates — S4 §6.3, AC-9 §14.3, TD-9
// ============================================================

/**
 * The six v1 must-surface predicates (Slice Plan SA-7.4). Each is a pure,
 * deterministic rule over typed input; none reads presentation state, and none
 * is ranked away (TD-9 hard guard).
 */
export const MUST_SURFACE_PREDICATES = [
  "pending_approval",
  "blocked_on_human",
  "due_commitment",
  "authority_conflict",
  "unknown_outcome_effect",
  "stalled",
] as const;

export type MustSurfacePredicate = (typeof MUST_SURFACE_PREDICATES)[number];

/**
 * Where each predicate's input comes from in SL-7 (Slice Plan SL-7, human
 * decision D4 of 2026-09-13).
 *
 * `live` — wired to authoritative projection data now.
 * `rule_only` — the rule exists and is proven with typed fixtures, but no
 *   Organization-Case producer exists yet, so the live wiring supplies no
 *   input for it: **no rows, no placeholder data**. The Slice that introduces
 *   the producer wires it into this same rule and proves it live.
 *
 * `stalled` is live data that cannot evaluate true in R1 until SL-11 transfers
 * runtime authority; SL-7 makes no artificial authority change to manufacture
 * a positive case.
 */
export const MUST_SURFACE_WIRING: Record<
  MustSurfacePredicate,
  { wiring: "live" | "rule_only"; producer: string }
> = {
  pending_approval: { wiring: "rule_only", producer: "SL-9" },
  blocked_on_human: { wiring: "live", producer: "SL-4 settlements + Work Plane" },
  due_commitment: { wiring: "live", producer: "SL-4 commitment subjects" },
  authority_conflict: { wiring: "rule_only", producer: "SL-6" },
  unknown_outcome_effect: { wiring: "rule_only", producer: "SL-9" },
  stalled: { wiring: "live", producer: "positive case first reachable at SL-11" },
};

// ============================================================
// Supervisory postures — S4 §5, §7
// ============================================================

/**
 * The postures SA-7.10 derives. Non-exclusive (S4 §4.3): a Case can need
 * attention while Gu handles other work.
 *
 * `stalled` is deliberately absent: it is an integrity and attention
 * predicate, not a posture (Slice Plan SL-7, SA-7.10 clarification).
 */
export const PORTFOLIO_POSTURES = [
  "needs_attention",
  "gu_handling",
  "waiting",
  "watching",
  "outcomes",
] as const;

export type PortfolioPosture = (typeof PORTFOLIO_POSTURES)[number];

/**
 * Whether a posture is Gu OS's authoritative position or a shadow judgment.
 *
 * A posture derived while `runtime_authority` is not `gu_os` describes what
 * Gu OS concluded while Legacy stayed authoritative — observing
 * responsibility, not owning it (TD-3; Architecture Analysis §9.2). A renderer
 * must not present a shadow posture as Gu OS being in charge.
 */
export type PostureAuthorityMode = "authoritative" | "shadow";

// ============================================================
// Attention projection — TD-15 point 2
// ============================================================

/**
 * One explanatory clause of an attention item. A reason code, the durable rows
 * it rests on, and values copied verbatim from those rows — never model prose
 * and never rendering instructions. The renderer turns `code` into words.
 */
export interface AttentionClause {
  code: string;
  refs: readonly DurableRef[];
  values: Readonly<Record<string, string | null>>;
}

/**
 * `AttentionProjection` v1 — the S4 view-model of one governed need.
 *
 * Needs Attention is a projection, not a Human Interaction primitive (S4 §9,
 * Experience Architecture §7.5): this item *references* the interaction a
 * human would answer, it is not one.
 */
export interface AttentionProjection {
  v: 1;
  /** Stable identity: `<predicate>:<interaction_id>`. */
  id: string;
  case_id: string;
  predicate: MustSurfacePredicate;
  /** v1 has no contextual path, so every item is a governed must-surface one. */
  must_surface: true;
  /** WHY it is being surfaced (S4 §6.2). */
  why: AttentionClause;
  /** WHAT GU NEEDS from the human. */
  what_gu_needs: AttentionClause;
  /** WHY NOW the contribution is material. */
  why_now: AttentionClause;
  interaction: HumanInteractionPayload;
  /**
   * When the need began, from durable truth. Null when no row records it — a
   * stall has no instant at which it started, and inventing one would be
   * exactly the invented urgency SA-7.4 forbids.
   */
  since: string | null;
}

// ============================================================
// Contextual (discretionary) attention — S4 §6.1, §6.4; TD-9 v2 (R1 SL-12)
// ============================================================

/**
 * One claim of a contextual attention item: the model's wording, anchored to
 * the durable rows it cites. It is shown only if EVERY ref resolved to a row of
 * the same Case in the authorized snapshot (Slice Plan SA-12.5). Whether the
 * rows actually support the wording is the eval rubric's to judge — a
 * validator cannot prove it.
 */
export interface GroundedClaim {
  text: string;
  refs: readonly DurableRef[];
}

/**
 * A discretionary attention item — the contextual human-value path.
 *
 * Deliberately NOT an `AttentionProjection`. It carries no predicate, creates
 * no obligation, and a person's snooze or hide applies to it ("discretionary is
 * not governed", Slice Plan SL-12 and Technical Plan v1.16). It exists only in
 * one Portfolio load's presentation and is never persisted (SA-12.8).
 */
export interface ContextualAttention {
  v: 1;
  kind: "contextual";
  case_id: string;
  must_surface: false;
  why: GroundedClaim;
  what_gu_needs: GroundedClaim;
  why_now: GroundedClaim;
}

/**
 * How one Portfolio load was ordered. Anything but `ranked` means SL-7's
 * deterministic order and reason codes stand, with nothing contextual — and
 * the page says so (SA-12.7).
 */
export const PORTFOLIO_RANKING_STATUSES = [
  "ranked",
  "disabled",
  "no_candidates",
  "model_unavailable",
  "model_error",
  "timeout",
  "invalid_output",
] as const;

export type PortfolioRankingStatus = (typeof PORTFOLIO_RANKING_STATUSES)[number];

// ============================================================
// Presentation state — the only thing the Portfolio owns
// ============================================================

/**
 * D6 (human decision of 2026-09-13): a snooze may defer a non-must-surface
 * item by at most 14 days. Mirrored by the M-PRESENTATION migration, which
 * clamps to the same interval; a selftest compares the two.
 *
 * Not a safety boundary — must-surface items ignore snooze entirely — and
 * therefore an ordinary engineering threshold (Methodology §14.1), fixed
 * before implementation so that no threshold is chosen after it began.
 */
export const PORTFOLIO_SNOOZE_CAP_DAYS = 14;

/** The snooze lengths the Portfolio offers, all within the cap. */
export const PORTFOLIO_SNOOZE_OPTIONS_DAYS = [1, 3, 7, 14] as const;

/** Mirrors the migration's CHECK: SL-7 presents Cases. */
export const PORTFOLIO_PRESENTATION_SUBJECT_KINDS = ["case"] as const;

export type PortfolioPresentationSubjectKind =
  (typeof PORTFOLIO_PRESENTATION_SUBJECT_KINDS)[number];

/** One `portfolio_presentation_state` row. Personal; never business truth. */
export interface PortfolioPresentationState {
  id: string;
  user_id: string;
  organization_id: string;
  subject_kind: PortfolioPresentationSubjectKind;
  subject_id: string;
  seen_at: string | null;
  snooze_until: string | null;
  hidden_at: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}
