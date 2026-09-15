/**
 * Conversational access to the Work Portfolio — R1 SL-12 (Technical Plan TD-9
 * v2: "conversational portfolio access (read tools in web chat)"; Slice Plan
 * SA-12.10, SA-12.11).
 *
 * One READ-ONLY tool. The Portfolio itself — authorization, the must-surface
 * floor, the ranking pass — lives in `apps/web` and is injected; this module
 * is only the seam, and it holds three lines the chat must not cross:
 *
 *   * **The user's own session, or nothing.** Case-level truth is read with the
 *     acting user's JWT so PostgreSQL's membership policies decide what exists
 *     for them — exactly as `/portfolio` reads it. `ctx.db` is the service role,
 *     so without `ctx.actorDb` the tool REFUSES; it never falls back to reading
 *     under a broader authority.
 *   * **The Organization is resolved, never supplied by the model.** From the
 *     actor's active memberships; zero or several fail closed.
 *   * **A refusal is a result.** The model needs to know it may not read, and
 *     not retry.
 *   * **Every call is audited.** The tool writes its own `tool_calls` row, as
 *     the graph expects of every tool not exempted in tool-audit-ownership.ts.
 */
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { DbClient } from "@agents/db";
import { runAuditedTool } from "./tool-call-audit";
import type { ToolContext } from "./tool-context";

export type WorkPortfolioView = "mine" | "organization";

/** Injected from `apps/web`. Structural, so this package never imports the app. */
export interface WorkPortfolioToolDeps {
  /** Active Organization memberships for the actor. */
  listActorOrganizations(params: { db: DbClient; actorUserId: string }): Promise<string[]>;
  /**
   * The actor's Portfolio, as `/portfolio` would render it for them: SL-7's
   * authorized projection, then SL-12's ranking pass, summarized for a reader.
   */
  readWorkPortfolio(params: {
    serviceDb: DbClient;
    actorDb: DbClient;
    actorUserId: string;
    organizationId: string;
    view: WorkPortfolioView;
  }): Promise<unknown>;
}

export type WorkPortfolioToolResult =
  | { status: "ok"; result: unknown }
  | { status: "not_configured"; hint: string }
  | { status: "no_user_session"; hint: string }
  | { status: "organization_not_resolved"; reason: string; hint: string }
  | { status: "failed"; error: string };

export const WORK_PORTFOLIO_TOOL_IDS = ["work_portfolio_read"] as const;

export async function readWorkPortfolioForTool(
  ctx: Pick<ToolContext, "db" | "actorDb" | "userId">,
  deps: WorkPortfolioToolDeps | null,
  view: WorkPortfolioView
): Promise<WorkPortfolioToolResult> {
  if (!deps) {
    return { status: "not_configured", hint: "The Work Portfolio is not wired in this environment. Do not retry." };
  }
  if (!ctx.actorDb) {
    return {
      status: "no_user_session",
      hint: "The Work Portfolio is read with the person's own signed-in web session, and this channel has none. Do not retry; suggest opening /portfolio.",
    };
  }
  const organizations = await deps.listActorOrganizations({ db: ctx.db, actorUserId: ctx.userId });
  if (organizations.length !== 1) {
    return {
      status: "organization_not_resolved",
      reason:
        organizations.length === 0
          ? "the acting user has no active Organization membership"
          : "the acting user belongs to more than one Organization",
      hint:
        organizations.length === 0
          ? "The Work Portfolio is Organization-scoped. Do not retry."
          : "The Organization cannot be inferred and must not be guessed. Do not retry; suggest opening /portfolio, which lets the person choose.",
    };
  }
  try {
    return {
      status: "ok",
      result: await deps.readWorkPortfolio({
        serviceDb: ctx.db,
        actorDb: ctx.actorDb,
        actorUserId: ctx.userId,
        organizationId: organizations[0],
        view,
      }),
    };
  } catch (error) {
    return { status: "failed", error: (error as Error).message };
  }
}

export function buildWorkPortfolioTools(
  ctx: ToolContext,
  deps: WorkPortfolioToolDeps | null,
  isAvailable: (toolId: string) => boolean
) {
  if (!isAvailable("work_portfolio_read")) return [];
  return [
    tool(
      async (input) => {
        const view = input.view ?? "mine";
        // This tool owns its audit trail: the graph writes no tool_calls row for
        // it (tool-audit-ownership.ts), so it writes and closes its own — what
        // the model read, for whom, and with what outcome. A refusal is a
        // result and closes as executed; a failure, thrown or returned, closes
        // as failed and stays a result.
        return JSON.stringify(
          await runAuditedTool(ctx, "work_portfolio_read", { view }, () => readWorkPortfolioForTool(ctx, deps, view))
        );
      },
      {
        name: "work_portfolio_read",
        description:
          "Reads the person's Work Portfolio — what needs them now and why, what Gu is handling, what is waiting — exactly as /portfolio shows it, with governed obligations and Gu's contextual suggestions told apart. Read-only; changes nothing. view='mine' (default) for their assigned work, 'organization' for everything they may see. Report governed items as obligations and contextual ones as Gu's suggestions; never present a suggestion as an obligation, and never invent items the result does not contain.",
        schema: z.object({ view: z.enum(["mine", "organization"]).nullish() }),
      }
    ),
  ];
}
