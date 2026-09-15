/**
 * The Work Portfolio's contextual ranking pass — R1 SL-12 (Portfolio v2;
 * Technical Plan TD-9 v2). Runs AFTER SL-7 has built the actor's Portfolio,
 * and only over it:
 *
 *   1. `portfolio_contextual_ranking` — off ⇒ no model call, SL-7's order;
 *   2. the frame — the authorized candidates as content and aliases;
 *      none ⇒ no call;
 *   3. ONE bounded call, raced against a timeout, under the Organization's
 *      AI-usage context (TD-10 (a));
 *   4. the deterministic merge — floor, grounding, discretionary kind.
 *
 * Every other outcome returns SL-7's views untouched, with its status stated,
 * so the page can say the order is the deterministic one (SA-12.7). Nothing is
 * written anywhere (SA-12.8).
 */
import { runWithAiUsageContext } from "@agents/agent";
import { isOrganizationFlagEnabled, type DbClient } from "@agents/db";
import { ORGANIZATION_FLAG_KEYS, type PortfolioRankingStatus } from "@agents/types";
import type { PortfolioActor, WorkPortfolio } from "../projection";
import type { PortfolioCaseSnapshot } from "../snapshot";
import {
  RANKING_TIMEOUT_MS,
  type PortfolioRankingJudge,
  type RankingJudgeResult,
} from "./contract";
import { buildRankingFrame } from "./frame";
import {
  applyRanking,
  emptyDiagnostics,
  mergeRanking,
  type RankedWorkPortfolio,
} from "./merge";

export type { RankedPortfolioEntry, RankedPortfolioView, RankedWorkPortfolio, RankingSummary } from "./merge";
export { createOpenRouterRankingJudge } from "./judge";

class RankingTimeout extends Error {
  constructor() {
    super("work-portfolio ranking timed out");
  }
}

export async function rankWorkPortfolio(params: {
  /** Service role: the flag read, and the ambient AI-usage recorder. */
  serviceDb: DbClient;
  organizationId: string;
  actor: PortfolioActor;
  portfolio: WorkPortfolio;
  snapshots: readonly PortfolioCaseSnapshot[];
  judge: PortfolioRankingJudge;
  now: Date;
  timeoutMs?: number;
}): Promise<RankedWorkPortfolio> {
  const { serviceDb, organizationId, actor, portfolio, judge } = params;
  const unranked = (status: PortfolioRankingStatus) =>
    applyRanking(portfolio, null, { status, modelId: judge.modelId, diagnostics: emptyDiagnostics() });

  // ── 1. The kill switch.
  const enabled = await isOrganizationFlagEnabled(
    serviceDb,
    organizationId,
    ORGANIZATION_FLAG_KEYS.portfolioContextualRanking
  );
  if (!enabled) return unranked("disabled");

  // ── 2. The authorized candidates, and nothing else.
  const frame = buildRankingFrame({
    portfolio,
    snapshots: params.snapshots,
    actorRole: actor.role,
    now: params.now,
  });
  if (frame.cases.length === 0) return unranked("no_candidates");

  // ── 3. One bounded call. Raced as well as aborted: a judge that ignores its
  // signal still cannot hold the page past the bound.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new RankingTimeout());
      reject(new RankingTimeout());
    }, params.timeoutMs ?? RANKING_TIMEOUT_MS);
  });
  let result: RankingJudgeResult;
  try {
    result = await runWithAiUsageContext(
      { userId: actor.userId, organizationId, channel: "web", operationalCaseId: null },
      serviceDb,
      () => Promise.race([judge.rank(frame.input, controller.signal), timeout])
    );
  } catch {
    return unranked(controller.signal.aborted ? "timeout" : "model_error");
  } finally {
    clearTimeout(timer);
  }
  if (!result.ok) return unranked(result.reason);

  // ── 4. The deterministic merge decides what of the answer is kept.
  const merged = mergeRanking(frame, result.output);
  return applyRanking(portfolio, merged, {
    status: "ranked",
    modelId: judge.modelId,
    diagnostics: merged.diagnostics,
  });
}
