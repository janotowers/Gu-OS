import { AsyncLocalStorage } from "node:async_hooks";
import {
  createToolCall,
  getApprovedToolCallForInvocation,
  getToolCallStatus,
  updateToolCallStatus,
  type DbClient,
} from "@agents/db";
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

// ============================================================================
// One logical tool invocation = one `tool_calls` row (R1 Cycle 3 order 5;
// Slice Plan §8 Q8, decided by the Accountable on 2026-09-15).
//
// When a person approves a call, the graph's confirmation row is that
// invocation's canonical record: it evolves to `executed` or `failed`, and the
// tool writes no second row. The graph opens a scope around every invocation
// and puts its own row in it — the model can never name one. A tool's first
// audit write inside the scope takes that row over, but only if it is this
// session's still-approved row for this very tool; anything else gets a new
// row, as before. Authorization is untouched: the graph asks the person before
// invoking, exactly as it did.
// ============================================================================

export interface ToolInvocationState {
  readonly toolName: string;
  /** The row the graph opened for this call — the person's approved confirmation, when there is one. */
  readonly confirmationRowId: string | null;
  /** The row this invocation writes to, once the tool claimed that row or created its own. */
  rowId: string | null;
}

const currentInvocation = new AsyncLocalStorage<ToolInvocationState>();

/** Opens the graph's scope for one invocation. Everything `run` awaits sees it. */
export function openToolInvocation(toolName: string, confirmationRowId: string | null) {
  const state: ToolInvocationState = { toolName, confirmationRowId, rowId: null };
  return {
    state,
    run<T>(fn: () => Promise<T>): Promise<T> {
      return currentInvocation.run(state, fn);
    },
  };
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
  // This invocation's first audit write for its own tool, if any.
  const invocation = currentInvocation.getStore();
  const own = invocation && invocation.toolName === toolName && invocation.rowId === null ? invocation : null;
  if (own?.confirmationRowId) {
    const approved = await getApprovedToolCallForInvocation(ctx.db, {
      toolCallId: own.confirmationRowId,
      sessionId: ctx.sessionId,
      toolName,
    });
    if (approved) {
      own.rowId = approved.id;
      return approved;
    }
  }
  const created = await createToolCall(
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
  if (own) own.rowId = created.id;
  return created;
}

/** How a finished tool answer closes its row: `failed` on an `error` string, `executed` otherwise. */
function outcomeOf(output: string): { status: "executed" | "failed"; payload: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const failed = typeof parsed === "object" && parsed !== null && typeof parsed.error === "string";
    return { status: failed ? "failed" : "executed", payload: parsed };
  } catch {
    return { status: "executed", payload: { raw: output } };
  }
}

/**
 * After a tool returned, closes the invocation's one row.
 * - A confirmation row the tool took over is its record: if the tool closed
 *   it, it stands; if not, it is closed here from the answer.
 * - A graph row the tool never took over is closed here, as it always was.
 * - A row the tool created for itself is the tool's to close: returns null.
 */
export async function closeToolInvocation(
  db: DbClient,
  args: { state: ToolInvocationState; graphRowId: string | null; output: string }
): Promise<{ rowId: string; status: "executed" | "failed" } | null> {
  const { state } = args;
  const claimed = state.rowId !== null && state.rowId === state.confirmationRowId;
  if (state.rowId !== null && !claimed) return null;
  const rowId = claimed ? state.rowId : args.graphRowId;
  if (!rowId) return null;
  if (claimed) {
    const status = await getToolCallStatus(db, rowId);
    if (status === "executed" || status === "failed") return { rowId, status };
  }
  const { status, payload } = outcomeOf(args.output);
  await updateToolCallStatus(db, rowId, status, payload);
  return { rowId, status };
}

/**
 * After a tool threw, closes the invocation's one row as failed — the row the
 * tool claimed or created, else the graph's — and creates one only when the
 * invocation has none (for example, input the schema refused before any
 * handler ran).
 */
export async function failToolInvocation(
  db: DbClient,
  args: {
    state: ToolInvocationState;
    graphRowId: string | null;
    payload: Record<string, unknown>;
    createRow: () => Promise<{ id: string }>;
  }
): Promise<string> {
  const rowId = args.state.rowId ?? args.graphRowId ?? (await args.createRow()).id;
  await updateToolCallStatus(db, rowId, "failed", args.payload);
  return rowId;
}

/** A tool answer; one whose `status` is `failed` is audited as a failure. */
export type AuditedToolResult = object;

/**
 * Runs a tool that owns its audit trail: the graph writes no `tool_calls` row
 * for it (tool-audit-ownership.ts), so this writes one before running — or,
 * when a person approved the call, takes over the graph's confirmation row —
 * and closes it exactly once: `failed` when the result says so, `executed`
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
    (result as { status?: unknown }).status === "failed" ? "failed" : "executed",
    result as unknown as Record<string, unknown>
  );
  return result;
}
