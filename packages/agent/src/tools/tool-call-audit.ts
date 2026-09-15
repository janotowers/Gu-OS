import { createToolCall, updateToolCallStatus } from "@agents/db";
import type { ToolCall, ToolCallMetadata } from "@agents/types";
import type { ToolContext } from "./tool-context";

export type ToolCallAuditContext = Pick<
  ToolContext,
  | "db"
  | "sessionId"
  | "turnId"
  | "caseId"
  | "operationalStepKey"
  | "activeSkillName"
  | "channel"
  | "toolCallSource"
>;

export function buildToolCallMetadata(
  ctx: Pick<
    ToolContext,
    | "caseId"
    | "operationalStepKey"
    | "activeSkillName"
    | "channel"
    | "toolCallSource"
  >,
  overrides?: Partial<ToolCallMetadata>
): ToolCallMetadata | undefined {
  const meta: ToolCallMetadata = {};
  if (ctx.caseId) meta.case_id = ctx.caseId;
  if (ctx.operationalStepKey) meta.operational_step_key = ctx.operationalStepKey;
  if (ctx.activeSkillName) meta.skill_slug = ctx.activeSkillName;
  if (ctx.toolCallSource) meta.source = ctx.toolCallSource;
  if (ctx.channel) meta.channel = ctx.channel;
  if (overrides) Object.assign(meta, overrides);
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export async function createTrackedToolCall(
  ctx: ToolCallAuditContext,
  toolName: string,
  args: Record<string, unknown>,
  requiresConfirmation: boolean,
  options?: {
    executorKind?: "agent" | "deterministic";
    metadataOverrides?: Partial<ToolCallMetadata>;
  }
): Promise<ToolCall> {
  return createToolCall(
    ctx.db,
    ctx.sessionId,
    toolName,
    args,
    requiresConfirmation,
    ctx.turnId,
    {
      executorKind: options?.executorKind,
      metadata: buildToolCallMetadata(ctx, options?.metadataOverrides),
    }
  );
}

/** A tool answer that says how it went; `failed` is the one outcome audited as a failure. */
export type AuditedToolResult = { status: string };

/**
 * Runs a tool that owns its audit trail: the graph writes no `tool_calls` row
 * for it (tool-audit-ownership.ts), so this writes one before running and
 * closes it exactly once — `failed` when the result says so, `executed`
 * otherwise, because a refusal is a result. A throw becomes a `failed` result
 * instead of propagating: thrown, the graph would audit the same call again.
 */
export async function runAuditedTool<R extends AuditedToolResult>(
  ctx: ToolCallAuditContext,
  toolName: string,
  args: Record<string, unknown>,
  run: () => Promise<R>
): Promise<R | { status: "failed"; error: string }> {
  const record = await createTrackedToolCall(ctx, toolName, args, false);
  let result: R | { status: "failed"; error: string };
  try {
    result = await run();
  } catch (error) {
    result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  await updateToolCallStatus(
    ctx.db,
    record.id,
    result.status === "failed" ? "failed" : "executed",
    result as unknown as Record<string, unknown>
  );
  return result;
}
