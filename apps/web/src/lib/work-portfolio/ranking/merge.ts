/**
 * The deterministic merge after the model — R1 SL-12 (SA-12.2 … SA-12.5,
 * SA-12.7). The model proposes; this module decides what of it is kept.
 *
 *  - **The governed floor is presence, not rank.** Every governed Case stays in
 *    Needs Attention whatever the model answered. One it ranked takes that rank;
 *    one it omitted follows the ranked ones, in SL-7's order.
 *  - **Discretionary is not governed.** Only a Case with no governed need can be
 *    admitted contextually; the admission carries no predicate and no
 *    obligation, and the person's snooze or hide still applies to it.
 *  - **Grounding per claim.** A claim is kept only if every alias it cites is one
 *    of that Case's own; an admission needs all three claims.
 *  - **No answer ⇒ SL-7.** With no merge (any model failure), the views pass
 *    through untouched, so the order is exactly SL-7's.
 */
import type {
  ContextualAttention,
  DurableRef,
  GroundedClaim,
  PortfolioRankingStatus,
} from "@agents/types";
import {
  compareEntries,
  PORTFOLIO_SECTIONS,
  type PortfolioActor,
  type PortfolioEntry,
  type PortfolioView,
  type WorkPortfolio,
} from "../projection";
import type {
  RankingClaim,
  RankingFrame,
  RankingFrameCase,
  RankingInput,
  RankingOutput,
} from "./contract";

export interface RankingDiagnostics {
  /** Items naming an alias that is not a case of this input. */
  unknown_cases: number;
  /** Second and later items for the same case; the best priority is kept. */
  duplicate_items: number;
  /** Claims citing an alias that is not the case's own. */
  ungrounded_claims: number;
  /** Contextual items not admitted: a claim missing or ungrounded. */
  dropped_admissions: number;
  /** Governed cases the model labelled contextual — kept governed. */
  relabelled_governed: number;
  /** Non-governed cases the model labelled governed — ignored. */
  false_governed: number;
  /** Governed cases the model did not rank — kept, after the ranked ones. */
  governed_unranked: number;
}

export function emptyDiagnostics(): RankingDiagnostics {
  return {
    unknown_cases: 0,
    duplicate_items: 0,
    ungrounded_claims: 0,
    dropped_admissions: 0,
    relabelled_governed: 0,
    false_governed: 0,
    governed_unranked: 0,
  };
}

export interface RankingMerge {
  /** By the frame's `case_id`: the model's priority, for what it may rank. */
  priorities: Map<string, number>;
  /** By `case_id`: the grounded contextual admissions. */
  contextual: Map<string, ContextualAttention>;
  diagnostics: RankingDiagnostics;
}

function ground(claim: RankingClaim, frameCase: RankingFrameCase): GroundedClaim | null {
  const refs: DurableRef[] = [];
  for (const alias of claim.refs) {
    const ref = frameCase.refs[alias];
    if (!ref) return null;
    refs.push(ref);
  }
  return { text: claim.text, refs };
}

export function mergeRanking(frame: RankingFrame, output: RankingOutput): RankingMerge {
  const byRef = new Map(frame.cases.map((c) => [c.ref, c]));
  const priorities = new Map<string, number>();
  const contextual = new Map<string, ContextualAttention>();
  const diagnostics = emptyDiagnostics();
  const seen = new Set<string>();

  // Best priority first, so a duplicate keeps the rank the model valued most.
  const items = [...output.items].sort((a, b) => a.priority - b.priority);
  for (const item of items) {
    const frameCase = byRef.get(item.case);
    if (!frameCase) {
      diagnostics.unknown_cases += 1;
      continue;
    }
    if (seen.has(frameCase.case_id)) {
      diagnostics.duplicate_items += 1;
      continue;
    }
    seen.add(frameCase.case_id);

    if (frameCase.governed) {
      // Governed stays governed, whatever the model called it.
      if (item.kind !== "governed") diagnostics.relabelled_governed += 1;
      priorities.set(frameCase.case_id, item.priority);
      continue;
    }
    if (item.kind !== "contextual") {
      diagnostics.false_governed += 1;
      continue;
    }
    const claims = [item.why, item.what_gu_needs, item.why_now];
    if (claims.some((claim) => !claim)) {
      diagnostics.dropped_admissions += 1;
      continue;
    }
    const grounded = claims.map((claim) => ground(claim!, frameCase));
    const ungrounded = grounded.filter((claim) => claim === null).length;
    if (ungrounded > 0) {
      diagnostics.ungrounded_claims += ungrounded;
      diagnostics.dropped_admissions += 1;
      continue;
    }
    contextual.set(frameCase.case_id, {
      v: 1,
      kind: "contextual",
      case_id: frameCase.case_id,
      must_surface: false,
      why: grounded[0]!,
      what_gu_needs: grounded[1]!,
      why_now: grounded[2]!,
    });
    priorities.set(frameCase.case_id, item.priority);
  }
  diagnostics.governed_unranked = frame.cases.filter(
    (c) => c.governed && !priorities.has(c.case_id)
  ).length;
  return { priorities, contextual, diagnostics };
}

/**
 * The final Needs Attention order over the frame's cases: everything ranked
 * that may be — governed, or admitted — by the model's priority, then every
 * governed case it did not rank, in the frame's (SL-7's) order.
 */
export function needsAttentionOrder(frame: RankingFrame, merged: RankingMerge): string[] {
  const position = new Map(frame.cases.map((c, i) => [c.case_id, i]));
  const ranked = frame.cases
    .filter((c) => merged.priorities.has(c.case_id) && (c.governed || merged.contextual.has(c.case_id)))
    .sort(
      (a, b) =>
        merged.priorities.get(a.case_id)! - merged.priorities.get(b.case_id)! ||
        position.get(a.case_id)! - position.get(b.case_id)!
    );
  const unranked = frame.cases.filter((c) => c.governed && !merged.priorities.has(c.case_id));
  return [...ranked, ...unranked].map((c) => c.case_id);
}

/**
 * A frame straight from an input, with synthetic ids equal to the aliases —
 * for the eval and tests, where there are no rows behind the aliases.
 */
export function frameFromInput(input: RankingInput): RankingFrame {
  return {
    input,
    cases: input.cases.map((c) => {
      const refs: Record<string, DurableRef> = { [c.ref]: { kind: "case", id: c.ref } };
      for (const g of c.governed) refs[g.ref] = { kind: "case", id: c.ref };
      for (const f of c.facts) refs[f.ref] = { kind: "case_fact", id: f.ref, fact_key: f.key };
      for (const k of c.commitments) refs[k.ref] = { kind: "case_subject", id: k.ref, subject_kind: "commitment" };
      for (const w of c.work) refs[w.ref] = { kind: "work_item", id: w.ref };
      for (const r of c.reconsiderations) {
        refs[r.ref] = { kind: "case_event", id: r.ref, event_kind: "supervisor_reconsidered" };
      }
      return { ref: c.ref, case_id: c.ref, governed: c.governed.length > 0, refs };
    }),
  };
}

// ============================================================
// Applying the merge to the Portfolio's views
// ============================================================

export interface RankedPortfolioEntry extends PortfolioEntry {
  /** A discretionary admission, or null. Never set on a governed entry. */
  contextual: ContextualAttention | null;
  /** The model's priority for this entry, or null when unranked. */
  rank: number | null;
}

export interface RankedPortfolioView {
  entries: RankedPortfolioEntry[];
  suppressed: RankedPortfolioEntry[];
}

export interface RankingSummary {
  status: PortfolioRankingStatus;
  /** The model the judge requested, from the judge itself; null for a stub. */
  modelId: string | null;
  diagnostics: RankingDiagnostics;
}

export interface RankedWorkPortfolio {
  actor: PortfolioActor;
  generatedAt: string;
  myWork: RankedPortfolioView;
  organizationWork: RankedPortfolioView;
  ranking: RankingSummary;
}

function recencyThenId(a: PortfolioEntry, b: PortfolioEntry): number {
  const byRecency = Date.parse(b.case.updated_at) - Date.parse(a.case.updated_at);
  return byRecency !== 0 ? byRecency : a.case.id.localeCompare(b.case.id);
}

function compareRanked(a: RankedPortfolioEntry, b: RankedPortfolioEntry): number {
  if (a.section !== "needs_attention" || b.section !== "needs_attention") {
    const bySection = PORTFOLIO_SECTIONS.indexOf(a.section) - PORTFOLIO_SECTIONS.indexOf(b.section);
    return bySection !== 0 ? bySection : compareEntries(a, b);
  }
  // Pinning reorders within a section, as in SL-7; it never moves one out.
  if (a.presentation.pinned !== b.presentation.pinned) return a.presentation.pinned ? -1 : 1;
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  }
  // Same rank, or both unranked: SL-7's own order where both are governed.
  if (a.attention.length > 0 && b.attention.length > 0) return compareEntries(a, b);
  return recencyThenId(a, b);
}

function rankedView(view: PortfolioView, merged: RankingMerge | null): RankedPortfolioView {
  const annotate = (entry: PortfolioEntry): RankedPortfolioEntry => {
    const contextual = entry.attention.length === 0 ? (merged?.contextual.get(entry.case.id) ?? null) : null;
    return {
      ...entry,
      contextual,
      rank: merged?.priorities.get(entry.case.id) ?? null,
      section: contextual ? "needs_attention" : entry.section,
    };
  };
  if (!merged) {
    // No answer: SL-7's views exactly, annotated with nothing.
    return { entries: view.entries.map(annotate), suppressed: view.suppressed.map(annotate) };
  }
  return {
    entries: view.entries.map(annotate).sort(compareRanked),
    suppressed: view.suppressed.map(annotate).sort(compareRanked),
  };
}

export function applyRanking(
  portfolio: WorkPortfolio,
  merged: RankingMerge | null,
  summary: RankingSummary
): RankedWorkPortfolio {
  return {
    actor: portfolio.actor,
    generatedAt: portfolio.generatedAt,
    myWork: rankedView(portfolio.myWork, merged),
    organizationWork: rankedView(portfolio.organizationWork, merged),
    ranking: summary,
  };
}
