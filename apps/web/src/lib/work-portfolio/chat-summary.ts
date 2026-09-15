/**
 * The Work Portfolio for a conversation — R1 SL-12 (TD-9 v2 "conversational
 * portfolio access"; Slice Plan SA-12.10).
 *
 * The SAME projection `/portfolio` renders — SL-7's authorized Portfolio read
 * under the person's own JWT, then SL-12's ranking pass — summarized for a
 * reader. Nothing new is decided here and nothing is written: the summary is
 * built from the ranked views, in their order, with governed obligations and
 * Gu's contextual suggestions kept apart, so a chat answer can never present
 * a suggestion as an obligation or list a Case the page would not.
 */
import type { DbClient } from "@agents/db";
import { renderClause, PREDICATE_COPY, RANKING_STATUS_COPY, SECTION_COPY } from "./copy";
import { loadWorkPortfolio } from "./load";
import {
  createOpenRouterRankingJudge,
  rankWorkPortfolio,
  type RankedPortfolioEntry,
  type RankedWorkPortfolio,
} from "./ranking";
import type { PortfolioRankingJudge } from "./ranking/contract";

export type PortfolioChatView = "mine" | "organization";

export interface PortfolioChatNeed {
  case_id: string;
  title: string;
  /** Gu's priority when the ranking ran; null in the deterministic order. */
  rank: number | null;
  kind: "governed" | "contextual";
  /** Governed obligations, as SL-7 states them. Empty for a contextual item. */
  governed: Array<{ need: string; why: string; what_gu_needs: string; why_now: string }>;
  /** Gu's contextual suggestion, each claim already grounded. Null when governed. */
  contextual: { why: string; what_gu_needs: string; why_now: string } | null;
}

export interface PortfolioChatSummary {
  status: "ok";
  view: PortfolioChatView;
  /** How the order was produced — Gu's ranking, or the deterministic order and why. */
  order: string;
  needs_attention: PortfolioChatNeed[];
  /** The other sections, by Case, in the page's order. */
  others: Array<{ case_id: string; title: string; section: string }>;
  /** Cases this person snoozed or hid. None contains a governed obligation. */
  hidden_by_you: number;
}

const OTHERS_LIMIT = 30;

function titleOf(entry: RankedPortfolioEntry): string {
  return entry.objective || `Oportunidad · ${entry.case.id.slice(0, 8)}`;
}

/** Instants for a reader who may be anywhere: explicit and zoned. */
function formatUtc(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "—";
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function summarizePortfolioForChat(
  ranked: RankedWorkPortfolio,
  view: PortfolioChatView
): PortfolioChatSummary {
  const current = view === "organization" ? ranked.organizationWork : ranked.myWork;
  const needs = current.entries.filter((e) => e.section === "needs_attention");
  return {
    status: "ok",
    view,
    order: RANKING_STATUS_COPY[ranked.ranking.status],
    needs_attention: needs.map((entry) => ({
      case_id: entry.case.id,
      title: titleOf(entry),
      rank: entry.rank,
      kind: entry.attention.length > 0 ? "governed" : "contextual",
      governed: entry.attention.map((item) => ({
        need: PREDICATE_COPY[item.predicate],
        why: renderClause(item.why, formatUtc),
        what_gu_needs: renderClause(item.what_gu_needs, formatUtc),
        why_now: renderClause(item.why_now, formatUtc),
      })),
      contextual:
        entry.attention.length === 0 && entry.contextual
          ? {
              why: entry.contextual.why.text,
              what_gu_needs: entry.contextual.what_gu_needs.text,
              why_now: entry.contextual.why_now.text,
            }
          : null,
    })),
    others: current.entries
      .filter((e) => e.section !== "needs_attention")
      .slice(0, OTHERS_LIMIT)
      .map((entry) => ({ case_id: entry.case.id, title: titleOf(entry), section: SECTION_COPY[entry.section].title })),
    hidden_by_you: current.suppressed.length,
  };
}

/**
 * What the chat tool reads: the Portfolio exactly as `/portfolio` builds it
 * for this person — then summarized. `actorDb` is their own session; the
 * loader reads case-level truth with it, as the page does.
 */
export async function readWorkPortfolioForChat(params: {
  serviceDb: DbClient;
  actorDb: DbClient;
  actorUserId: string;
  organizationId: string;
  view: PortfolioChatView;
  judge?: PortfolioRankingJudge;
  now?: Date;
}): Promise<PortfolioChatSummary | { status: "inert" | "no_membership"; hint: string }> {
  const now = params.now ?? new Date();
  const loaded = await loadWorkPortfolio({
    serviceDb: params.serviceDb,
    userDb: params.actorDb,
    actorUserId: params.actorUserId,
    organizationId: params.organizationId,
    now,
  });
  if (loaded.status === "no_membership") {
    return { status: "no_membership", hint: "The person has no active membership in this Organization. Do not retry." };
  }
  if (loaded.status === "inert") {
    return { status: "inert", hint: "Relationship Operations is off for this Organization; the Portfolio reads nothing. Do not retry." };
  }
  const ranked = await rankWorkPortfolio({
    serviceDb: params.serviceDb,
    organizationId: params.organizationId,
    actor: loaded.portfolio.actor,
    portfolio: loaded.portfolio,
    snapshots: loaded.snapshots,
    judge: params.judge ?? createOpenRouterRankingJudge(),
    now,
  });
  return summarizePortfolioForChat(ranked, params.view);
}
