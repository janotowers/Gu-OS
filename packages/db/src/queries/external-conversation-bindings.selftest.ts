/**
 * Selftests for external conversation bindings (R1 SL-6 / T1).
 *
 * Covers the DETERMINISTIC TypeScript contracts and the migration source:
 * opaque refs, advisor_wa refusal, idempotent attach, and that the CHECK /
 * unique / service-role policy named by SA-6.1 / SA-6.2 / SA-6.13 actually
 * appear in the forward migration. It also proves 00044 was not mutated.
 *
 * It deliberately does NOT claim to verify row-level security or CHECK
 * enforcement. Those live in `test-rls/run.ts` against a real database.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "../client";
import {
  attachExternalConversationBinding,
  endConversationBinding,
  findActiveConversationBinding,
  listActiveGuConversationBindingsByRef,
  listConversationBindingsForCase,
  updateConversationAuthority,
} from "./external-conversation-bindings";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): { db: DbClient } {
  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    let pendingUpdate: Row | null = null;
    const applyUpdate = () => {
      if (!pendingUpdate) return;
      const patch = pendingUpdate;
      pendingUpdate = null;
      rows = rows.map((r) => Object.assign(r, patch));
      for (const r of rows) {
        const live = (tables[table] ?? []).find((x) => x.id === r.id);
        if (live) Object.assign(live, patch);
      }
    };
    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
      maybeSingle: async () => {
        applyUpdate();
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        applyUpdate();
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: new Error(`expected one row, got ${rows.length}`) };
      },
      insert: (values: Row) => {
        const inserted = {
          id: `generated-${(tables[table] ?? []).length}`,
          status: "active",
          ended_at: null,
          created_at: "2026-09-17T00:00:00.000Z",
          updated_at: "2026-09-17T00:00:00.000Z",
          ...values,
        };
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
        return self;
      },
      update: (values: Row) => {
        pendingUpdate = values;
        return self;
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        applyUpdate();
        return resolve({ data: rows, error: null });
      },
    };
    return self;
  }
  return { db: { from: (table: string) => builder(table) } as unknown as DbClient };
}

const ORG = "11111111-1111-1111-1111-111111111111";
const CASE = "cccccccccccccccc-cccc-cccc-cccc-cccccccccccc";
const CONTACT = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function attachArgs(
  overrides: Partial<Parameters<typeof attachExternalConversationBinding>[1]> = {}
) {
  return {
    organizationId: ORG,
    caseId: CASE,
    contactId: CONTACT,
    provider: "whatsapp_business" as const,
    externalConversationRef: "lead-opaque-1",
    threadKind: "gu" as const,
    ...overrides,
  };
}

async function testOpaqueRefAndAdvisorWaRefusal(): Promise<void> {
  const { db } = fakeDb({ external_conversation_bindings: [] });

  await assert.rejects(
    () => attachExternalConversationBinding(db, attachArgs({ externalConversationRef: "   " })),
    /external conversation ref is required/
  );
  await assert.rejects(
    () =>
      attachExternalConversationBinding(
        db,
        attachArgs({
          threadKind: "advisor_wa",
          conversationAuthority: "human_active",
        })
      ),
    /advisor_wa rows cannot carry conversation authority/
  );
  await assert.rejects(
    () =>
      attachExternalConversationBinding(
        db,
        attachArgs({
          threadKind: "advisor_wa",
          lastHumanActivityAt: "2026-09-17T00:00:00.000Z",
        })
      ),
    /advisor_wa rows cannot carry conversation authority/
  );
  await assert.rejects(
    () =>
      attachExternalConversationBinding(
        db,
        attachArgs({ threadKind: "advisor_wa", authoritySource: "c1_event" })
      ),
    /advisor_wa rows cannot carry conversation authority/
  );

  const advisor = await attachExternalConversationBinding(
    db,
    attachArgs({
      threadKind: "advisor_wa",
      externalConversationRef: "advisor-thread-1",
    })
  );
  assert.equal(advisor.thread_kind, "advisor_wa");
  assert.equal(advisor.conversation_authority, null);

  await assert.rejects(
    () =>
      updateConversationAuthority(db, {
        organizationId: ORG,
        bindingId: advisor.id,
        conversationAuthority: "human_active",
      }),
    /advisor_wa rows cannot carry conversation authority/
  );

  console.log("  ok  opaque ref required; advisor_wa cannot mint authority");
}

async function testIdempotentAttachAndList(): Promise<void> {
  const { db } = fakeDb({ external_conversation_bindings: [] });
  const first = await attachExternalConversationBinding(db, attachArgs());
  const second = await attachExternalConversationBinding(db, attachArgs());
  assert.equal(first.id, second.id, "same active triple is a no-op");

  const found = await findActiveConversationBinding(db, {
    organizationId: ORG,
    provider: "whatsapp_business",
    externalConversationRef: "lead-opaque-1",
    caseId: CASE,
  });
  assert.equal(found?.id, first.id);

  const listed = await listConversationBindingsForCase(db, {
    organizationId: ORG,
    caseId: CASE,
  });
  assert.equal(listed.length, 1);

  const ended = await endConversationBinding(db, {
    organizationId: ORG,
    bindingId: first.id,
  });
  assert.equal(ended.status, "ended");
  assert.ok(ended.ended_at);

  const afterEnd = await findActiveConversationBinding(db, {
    organizationId: ORG,
    provider: "whatsapp_business",
    externalConversationRef: "lead-opaque-1",
    caseId: CASE,
  });
  assert.equal(afterEnd, null);

  console.log("  ok  attach is idempotent; end frees the active triple");
}

async function testReverseMapIgnoresAdvisorWa(): Promise<void> {
  const { db } = fakeDb({
    external_conversation_bindings: [
      {
        id: "bind-wa",
        organization_id: ORG,
        case_id: CASE,
        contact_id: CONTACT,
        provider: "whatsapp_business",
        external_conversation_ref: "lead-opaque-1",
        thread_kind: "advisor_wa",
        status: "active",
      },
      {
        id: "bind-gu",
        organization_id: ORG,
        case_id: CASE,
        contact_id: CONTACT,
        provider: "whatsapp_business",
        external_conversation_ref: "lead-opaque-1",
        thread_kind: "gu",
        status: "active",
      },
    ],
  });
  const listed = await listActiveGuConversationBindingsByRef(db, {
    organizationId: ORG,
    externalConversationRef: "lead-opaque-1",
    provider: "whatsapp_business",
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.thread_kind, "gu");
  assert.equal(listed[0]?.id, "bind-gu");
  console.log("  ok  reverse map returns active gu bindings only");
}

async function testUpdateAuthorityOnGuThread(): Promise<void> {
  const { db } = fakeDb({ external_conversation_bindings: [] });
  const row = await attachExternalConversationBinding(db, attachArgs());
  const updated = await updateConversationAuthority(db, {
    organizationId: ORG,
    bindingId: row.id,
    conversationAuthority: "human_active",
    lastHumanActivityAt: "2026-09-17T12:00:00.000Z",
    authoritySource: "legacy_conversation_authority_get",
  });
  assert.equal(updated.conversation_authority, "human_active");
  assert.equal(updated.authority_source, "legacy_conversation_authority_get");
  console.log("  ok  gu-thread conversation authority can be written");
}

async function testMigrationSourceMatchesContract(): Promise<void> {
  const forwardDir = path.resolve(
    __dirname,
    "..",
    "..",
    "forward",
    "supabase",
    "migrations"
  );
  const files = (await fs.readdir(forwardDir))
    .filter((n) => n.endsWith("_external_conversation_bindings.sql"))
    .sort();
  assert.equal(files.length, 1, "exactly one forward migration owns this table");
  const sql = await fs.readFile(path.join(forwardDir, files[0]), "utf8");

  assert.match(sql, /create table public\.external_conversation_bindings/);
  assert.match(sql, /uq_external_conversation_bindings_active/);
  assert.match(sql, /external_conversation_bindings_advisor_wa_null_authority/);
  assert.match(sql, /thread_kind <> 'advisor_wa'/);
  assert.match(sql, /Service role manages external conversation bindings/);
  assert.match(sql, /auth\.role\(\) = 'service_role'/);
  assert.match(sql, /external_conversation_bindings_case_same_org/);
  assert.match(sql, /external_conversation_bindings_contact_same_org/);
  assert.doesNotMatch(
    sql,
    /create policy "Org members/i,
    "no authenticated read path — TD-1 service-role only"
  );
  assert.match(
    sql,
    /it is a reference, never the Gu OS conversation identity/
  );

  const frozen = await fs.readFile(
    path.resolve(
      __dirname,
      "..",
      "..",
      "supabase",
      "migrations",
      "00044_operational_case_conversation_bindings.sql"
    ),
    "utf8"
  );
  assert.match(frozen, /create table if not exists public\.operational_case_conversation_bindings/);
  assert.doesNotMatch(frozen, /thread_kind/);
  assert.doesNotMatch(frozen, /conversation_authority/);
  assert.doesNotMatch(frozen, /external_conversation_ref/);
  assert.match(frozen, /chat_id bigint/);

  const frozenDir = path.resolve(__dirname, "..", "..", "supabase", "migrations");
  const leaked = (await fs.readdir(frozenDir)).filter((n) =>
    n.includes("external_conversation_bindings")
  );
  assert.deepEqual(leaked, [], "must not land in the frozen legacy chain");

  console.log("  ok  migration source matches SA-6.1 / SA-6.2 / SA-6.13; 00044 untouched");
}

async function testAttachHelperHasNoRuntimeProducer(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const roots = [
    path.join(repoRoot, "apps"),
    path.join(repoRoot, "packages"),
    path.join(repoRoot, "scripts"),
  ];
  const callers: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".next" ||
          entry.name === "dist" ||
          entry.name === ".turbo"
        ) {
          continue;
        }
        await walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
      if (entry.name.includes(".selftest.")) continue;
      const text = await fs.readFile(full, "utf8");
      if (!text.includes("attachExternalConversationBinding")) continue;
      const isCall = /attachExternalConversationBinding\s*\(/.test(text);
      const isDef = /export async function attachExternalConversationBinding/.test(
        text
      );
      if (isCall && !isDef) {
        callers.push(path.relative(repoRoot, full).replaceAll("\\", "/"));
      }
    }
  }

  for (const root of roots) await walk(root);
  // SL-15 historical/pilot backfill is the only governed non-test caller.
  // Future admission still does not attach a conversation binding. T7 is
  // still not a caller.
  assert.deepEqual(
    callers,
    ["packages/db/src/queries/legacy-lead-contact.ts"],
    `only SL-15 backfill may call attachExternalConversationBinding; found: ${callers.join(", ")}`
  );
  console.log(
    "  ok  attachExternalConversationBinding has exactly one non-test caller (SL-15 backfill)"
  );
}

async function main(): Promise<void> {
  console.log("external conversation bindings selftest");
  await testOpaqueRefAndAdvisorWaRefusal();
  await testIdempotentAttachAndList();
  await testReverseMapIgnoresAdvisorWa();
  await testUpdateAuthorityOnGuThread();
  await testMigrationSourceMatchesContract();
  await testAttachHelperHasNoRuntimeProducer();
  console.log("external conversation bindings selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
