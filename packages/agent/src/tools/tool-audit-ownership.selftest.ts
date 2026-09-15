/**
 * Every tool execution must leave a `tool_calls` row, written by exactly one
 * owner (R1 Cycle 3 order 4; Slice Plan v1.31 §6).
 *
 * Who writes it depends on the path the graph takes (graph.ts):
 *   - a tool that requires confirmation (medium / high risk) goes through the
 *     confirmation path. Asked for approval, the graph writes and closes its
 *     row. Auto-executed — a cron auto-approve, or a policy — the graph writes
 *     one only when `toolOwnsAuditTrail(id)` is false;
 *   - a low-risk tool auto-executes, and the graph writes no row at all.
 *
 * So a tool whose handler writes no row is audited only if it requires
 * confirmation AND tool-audit-ownership.ts lists it; and a tool whose handler
 * writes one must not be listed, or an auto-executed call gets a second row.
 * This suite reads every tool handler in this directory and holds each tool to
 * both rules.
 *
 * Order 4 recorded one exception, the two low-risk introspection tools. The
 * Accountable resolved it on 2026-09-15 (§8 Q7): they audit themselves like
 * every low-risk tool, so no tool is exempt from these rules any more. The same
 * decision on Q8 made a person's approved confirmation row the invocation's one
 * row, which the graph hands to the tool through its invocation scope. The last
 * check here holds the graph to that wiring (Cycle 3 order 5).
 *
 * It reads source, not behavior: it guards the ownership map and the wiring.
 * That each self-auditing handler writes and closes its row on every branch is
 * for that handler's own selftest to prove.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { toolOwnsAuditTrail } from "./tool-audit-ownership";

/** A call that writes a `tool_calls` row: the two audit helpers, or the runner built on them. */
const AUDIT_WRITE = /\b(createTrackedToolCall|createToolCall|runAuditedTool)\s*\(/;

/** Tools still allowed to execute with no row. None since §8 Q7 was resolved (2026-09-15). */
const RECORDED_EXCEPTIONS: string[] = [];

interface ScannedTool {
  file: string;
  name: string;
  writesOwnRow: boolean;
}

function calls(body: string, names: Iterable<string>): boolean {
  for (const name of names) if (new RegExp(`\\b${name}\\s*\\(`).test(body)) return true;
  return false;
}

/** Every `tool(handler, { name })` in the directory, and whether its handler writes a row. */
function scanTools(dir: string): ScannedTool[] {
  const out: ScannedTool[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".selftest."));
  for (const file of files) {
    const src = readFileSync(path.join(dir, file), "utf8");
    if (!/\btool\(/.test(src)) continue;

    // Top-level helpers of this file that write a row, directly or through one another.
    const declaration = /^(?:export\s+)?(?:async\s+function\s+|function\s+|const\s+)(\w+)/gm;
    const helpers: Array<{ name: string; at: number }> = [];
    for (let m = declaration.exec(src); m; m = declaration.exec(src)) helpers.push({ name: m[1], at: m.index });
    const bodyOf = (i: number) => src.slice(helpers[i].at, i + 1 < helpers.length ? helpers[i + 1].at : src.length);
    const writers = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      helpers.forEach((helper, i) => {
        if (writers.has(helper.name) || /^build\w*Tools$/.test(helper.name)) return;
        const body = bodyOf(i);
        if (AUDIT_WRITE.test(body) || calls(body, writers)) {
          writers.add(helper.name);
          changed = true;
        }
      });
    }

    const starts: number[] = [];
    const toolCall = /\btool\(/g;
    for (let m = toolCall.exec(src); m; m = toolCall.exec(src)) starts.push(m.index);
    starts.forEach((at, i) => {
      const chunk = src.slice(at, i + 1 < starts.length ? starts[i + 1] : src.length);
      const name = chunk.match(/name:\s*"([\w-]+)"/);
      if (!name) return;
      const handler = chunk.slice(0, chunk.indexOf(name[0]));
      out.push({ file, name: name[1], writesOwnRow: AUDIT_WRITE.test(handler) || calls(handler, writers) });
    });
  }
  return out;
}

let passed = 0;
function t(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function main() {
  console.log("tool audit ownership (R1 Cycle 3 order 4)");
  const scanned = scanTools(__dirname);
  const describe = (tools: ScannedTool[]) => tools.map((s) => `${s.name} (${s.file})`);

  t("the scan finds every tool it judges — an empty or partial scan would prove nothing", () => {
    assert.ok(scanned.length >= 55, `the scan found only ${scanned.length} tools`);
    const catalog = new Set(TOOL_CATALOG.map((d) => d.id));
    assert.deepEqual(describe(scanned.filter((s) => !catalog.has(s.name))), [], "every scanned tool is catalogued");
    for (const id of ["legacy_lead_get_context", "work_portfolio_read", "bash", "calendar_create_event", "gmail_send_email", "get_user_preferences", "list_enabled_tools"]) {
      assert.ok(scanned.some((s) => s.name === id), `the scan missed ${id}`);
    }
    const names = scanned.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, "each tool is built once");
  });

  t("a tool whose handler writes no row requires confirmation and is listed, so the graph writes it on every path", () => {
    const unaudited = scanned.filter(
      (s) => !s.writesOwnRow && !RECORDED_EXCEPTIONS.includes(s.name) && (toolOwnsAuditTrail(s.name) || !toolRequiresConfirmation(s.name))
    );
    assert.deepEqual(describe(unaudited), [], "these tools can execute with no tool_calls row");
  });

  t("a tool whose handler writes its own row is not listed, so an auto-executed call gets one row, not two", () => {
    const doubled = scanned.filter((s) => s.writesOwnRow && !toolOwnsAuditTrail(s.name));
    assert.deepEqual(describe(doubled), [], "these tools would be audited twice when auto-executed");
  });

  t("no low-risk tool executes without a row — the recorded exceptions are exactly the tools still unaudited", () => {
    const stillUnaudited = scanned.filter((s) => !s.writesOwnRow && !toolRequiresConfirmation(s.name)).map((s) => s.name);
    assert.deepEqual(stillUnaudited.sort(), [...RECORDED_EXCEPTIONS].sort());
    for (const id of RECORDED_EXCEPTIONS) assert.equal(toolOwnsAuditTrail(id), false, `${id} stays listed`);
  });

  t("the graph runs every tool invocation in its scope and closes its row through the shared helpers (§8 Q8)", () => {
    const graph = readFileSync(path.join(__dirname, "..", "graph.ts"), "utf8");
    const invokes = graph.match(/\.invoke\(tc\.args\)/g) ?? [];
    assert.ok(invokes.length >= 1, "the scan found no tool invocation in graph.ts");
    const scoped = graph.match(/\.run\(\(\)\s*=>\s*\(matchingTool as any\)\.invoke\(tc\.args\)\)/g) ?? [];
    assert.equal(scoped.length, invokes.length, "every invocation runs inside openToolInvocation(...).run");
    assert.ok(/openToolInvocation\(tc\.name,\s*trackedToolCallId\)/.test(graph), "the scope carries the graph's row, never a model value");
    assert.ok(/closeToolInvocation\(/.test(graph), "a finished invocation closes its row through closeToolInvocation");
    assert.ok(/failToolInvocation\(/.test(graph), "a thrown invocation closes its row through failToolInvocation");
  });

  console.log(`\ntool audit ownership selftest: ${passed} checks passed`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
