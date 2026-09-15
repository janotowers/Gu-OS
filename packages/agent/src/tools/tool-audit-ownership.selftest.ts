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
 * The one recorded exception is the two low-risk introspection tools the list
 * names: the graph's write for them sits on a path they never take. They are
 * recorded with order 4 for a decision, not repaired here.
 *
 * It reads source, not behavior: it guards the ownership map. That each
 * self-auditing handler writes and closes its row on every branch is for that
 * handler's own selftest to prove.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { toolOwnsAuditTrail } from "./tool-audit-ownership";

/** A call that writes a `tool_calls` row: the two audit helpers, or the runner built on them. */
const AUDIT_WRITE = /\b(createTrackedToolCall|createToolCall|runAuditedTool)\s*\(/;

/** Low-risk introspection tools the graph never reaches — recorded, not repaired. */
const RECORDED_EXCEPTIONS = ["get_user_preferences", "list_enabled_tools"];

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
    for (const id of ["legacy_lead_get_context", "work_portfolio_read", "bash", "calendar_create_event", "gmail_send_email", ...RECORDED_EXCEPTIONS]) {
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

  t("the recorded exceptions are exactly the tools still unaudited — repairing one means removing it here", () => {
    const stillUnaudited = scanned.filter((s) => !s.writesOwnRow && !toolRequiresConfirmation(s.name)).map((s) => s.name);
    assert.deepEqual(stillUnaudited.sort(), [...RECORDED_EXCEPTIONS].sort());
    for (const id of RECORDED_EXCEPTIONS) assert.equal(toolOwnsAuditTrail(id), false, `${id} stays listed`);
  });

  console.log(`\ntool audit ownership selftest: ${passed} checks passed`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
