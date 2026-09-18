/**
 * Deterministic insert/list contracts for authority_resolutions (SL-6 T4).
 * RLS and CHECK live in test-rls.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "../client";
import {
  AuthorityResolutionIdentityConflict,
  closeUnresolvedAuthorityResolutions,
  findAuthorityResolutionByProviderMessageId,
  insertAuthorityResolution,
  listAuthorityResolutionsForCases,
} from "./authority-resolutions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORG = "11111111-1111-1111-1111-111111111111";
const CASE_ID = "cccccccccccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER_CASE = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LEAD_A = "lead-opaque-a";
const LEAD_B = "lead-opaque-b";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): DbClient {
  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    let pendingUpdate: Row | null = null;
    const applyUpdate = () => {
      if (!pendingUpdate) return;
      const patch = pendingUpdate;
      pendingUpdate = null;
      for (const row of rows) {
        Object.assign(row, patch);
        const live = (tables[table] ?? []).find((x) => x.id === row.id);
        if (live) Object.assign(live, patch);
      }
    };
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((r) => values.includes(r[column]));
        return self;
      },
      order: () => self,
      is: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] == value);
        return self;
      },
      insert: (values: Row) => {
        const existing = (tables[table] ?? []).find(
          (row) =>
            values.provider_message_id &&
            row.provider_message_id === values.provider_message_id
        );
        if (existing) {
          rows = [existing];
          self.single = async () => ({
            data: null,
            error: { code: "23505", message: "duplicate" },
          });
          return self;
        }
        const inserted = {
          id: `res-${(tables[table] ?? []).length + 1}`,
          created_at: "2026-09-18T02:10:00.000Z",
          resolved_at: null,
          resolved_as: null,
          ...values,
        };
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
        self.single = async () => ({ data: inserted, error: null });
        return self;
      },
      update: (values: Row) => {
        pendingUpdate = values;
        return self;
      },
      single: async () => {
        applyUpdate();
        return { data: rows[0] ?? null, error: null };
      },
      maybeSingle: async () => {
        applyUpdate();
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        applyUpdate();
        return resolve({ data: rows, error: null });
      },
    };
    return self;
  }
  return { from: (table: string) => builder(table) } as unknown as DbClient;
}

async function testInsertAndList(): Promise<void> {
  const db = fakeDb({ authority_resolutions: [] });
  const row = await insertAuthorityResolution(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: "lead-opaque-1",
    state: "unknown",
    detectedAt: "2026-09-18T02:10:00.000Z",
    failSafeReason: "read_failure",
  });
  assert.equal(row.state, "unknown");
  assert.equal(row.organization_id, ORG);
  const listed = await listAuthorityResolutionsForCases(db, {
    organizationId: ORG,
    caseIds: [CASE_ID],
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.external_conversation_ref, "lead-opaque-1");
  console.log("  ok  insert then list by case");
}

async function testProviderMessageIdIsIdempotent(): Promise<void> {
  const db = fakeDb({ authority_resolutions: [] });
  const first = await insertAuthorityResolution(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    state: "unknown",
    detectedAt: "2026-09-18T02:10:00.000Z",
    providerMessageId: "wamid-1",
  });
  const second = await insertAuthorityResolution(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    state: "unknown",
    detectedAt: "2026-09-18T02:11:00.000Z",
    providerMessageId: "wamid-1",
  });
  assert.equal(second.id, first.id);
  const found = await findAuthorityResolutionByProviderMessageId(db, {
    organizationId: ORG,
    providerMessageId: "wamid-1",
  });
  assert.equal(found?.id, first.id);
  console.log("  ok  provider_message_id retries collapse to one row");
}

async function testCloseUnresolved(): Promise<void> {
  const db = fakeDb({
    authority_resolutions: [
      {
        id: "open-1",
        organization_id: ORG,
        case_id: CASE_ID,
        state: "unknown",
        resolved_at: null,
        resolved_as: null,
      },
    ],
  });
  const closed = await closeUnresolvedAuthorityResolutions(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    resolvedAt: "2026-09-18T02:20:00.000Z",
    resolvedAs: "gu",
  });
  assert.equal(closed, 1);
  console.log("  ok  closeUnresolved marks the open incident");
}

async function testConfidentStateRefused(): Promise<void> {
  const db = fakeDb({ authority_resolutions: [] });
  await assert.rejects(
    () =>
      insertAuthorityResolution(db, {
        organizationId: ORG,
        state: "gu" as never,
        detectedAt: "2026-09-18T02:10:00.000Z",
      }),
    /only unknown and conflicting/
  );
  console.log("  ok  confident states cannot be inserted");
}

async function testCloseScopedByCaseAndConversation(): Promise<void> {
  const db = fakeDb({
    authority_resolutions: [
      {
        id: "open-a",
        organization_id: ORG,
        case_id: CASE_ID,
        external_conversation_ref: LEAD_A,
        state: "unknown",
        resolved_at: null,
        resolved_as: null,
      },
      {
        id: "open-b",
        organization_id: ORG,
        case_id: CASE_ID,
        external_conversation_ref: LEAD_B,
        state: "unknown",
        resolved_at: null,
        resolved_as: null,
      },
    ],
  });
  const closed = await closeUnresolvedAuthorityResolutions(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: LEAD_B,
    resolvedAt: "2026-09-18T02:20:00.000Z",
    resolvedAs: "gu",
  });
  assert.equal(closed, 1);
  const listed = await listAuthorityResolutionsForCases(db, {
    organizationId: ORG,
    caseIds: [CASE_ID],
  });
  const rowA = listed.find((row) => row.id === "open-a");
  const rowB = listed.find((row) => row.id === "open-b");
  assert.equal(rowA?.resolved_at, null);
  assert.equal(rowB?.resolved_as, "gu");
  console.log("  ok  closeUnresolved scopes by Case AND conversation ref");
}

async function testReopenAndIdentityConflicts(): Promise<void> {
  const db = fakeDb({ authority_resolutions: [] });
  const first = await insertAuthorityResolution(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: LEAD_A,
    state: "unknown",
    detectedAt: "2026-09-18T02:10:00.000Z",
    providerMessageId: "wamid-transitions",
    provenance: { step: "open" },
  });
  await closeUnresolvedAuthorityResolutions(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: LEAD_A,
    resolvedAt: "2026-09-18T02:20:00.000Z",
    resolvedAs: "gu",
  });
  const reopened = await insertAuthorityResolution(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: LEAD_A,
    state: "unknown",
    detectedAt: "2026-09-18T02:30:00.000Z",
    providerMessageId: "wamid-transitions",
    provenance: { step: "reopen" },
  });
  assert.equal(reopened.id, first.id);
  assert.equal(reopened.resolved_at, null);
  assert.equal(Array.isArray(reopened.provenance_jsonb.history), true);

  const conflicting = await insertAuthorityResolution(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: LEAD_A,
    state: "conflicting",
    detectedAt: "2026-09-18T02:31:00.000Z",
    providerMessageId: "wamid-transitions",
  });
  assert.equal(conflicting.id, first.id);
  assert.equal(conflicting.state, "conflicting");

  await assert.rejects(
    () =>
      insertAuthorityResolution(db, {
        organizationId: ORG,
        caseId: CASE_ID,
        externalConversationRef: LEAD_B,
        state: "unknown",
        detectedAt: "2026-09-18T02:32:00.000Z",
        providerMessageId: "wamid-transitions",
      }),
    (error: unknown) => error instanceof AuthorityResolutionIdentityConflict
  );

  const other = fakeDb({ authority_resolutions: [] });
  await insertAuthorityResolution(other, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: LEAD_A,
    state: "unknown",
    detectedAt: "2026-09-18T02:10:00.000Z",
    providerMessageId: "wamid-case-conflict",
  });
  await assert.rejects(
    () =>
      insertAuthorityResolution(other, {
        organizationId: ORG,
        caseId: OTHER_CASE,
        externalConversationRef: LEAD_A,
        state: "unknown",
        detectedAt: "2026-09-18T02:11:00.000Z",
        providerMessageId: "wamid-case-conflict",
      }),
    (error: unknown) => error instanceof AuthorityResolutionIdentityConflict
  );
  console.log("  ok  reopen, unknown→conflicting, and identity conflicts");
}

async function testMigrationSource(): Promise<void> {
  const sql = await fs.readFile(
    path.resolve(
      __dirname,
      "../../forward/supabase/migrations/20260918021047_authority_resolutions.sql"
    ),
    "utf8"
  );
  assert.match(sql, /create table public\.authority_resolutions/);
  assert.match(sql, /check \(state in \('unknown', 'conflicting'\)\)/);
  assert.match(sql, /is_active_org_member\(organization_id\)/);
  assert.match(sql, /auth\.role\(\) = 'service_role'/);
  assert.match(sql, /00084/);
  assert.doesNotMatch(sql, /runtime_authority\s*=/);

  const lifecycle = await fs.readFile(
    path.resolve(
      __dirname,
      "../../forward/supabase/migrations/20260918141500_authority_resolution_lifecycle.sql"
    ),
    "utf8"
  );
  assert.match(lifecycle, /provider_message_id/);
  assert.match(lifecycle, /resolved_at/);
  assert.match(lifecycle, /authority_resolutions_org_provider_message_id_uidx/);
  assert.match(lifecycle, /authority_resolutions_resolved_pair/);
  assert.doesNotMatch(lifecycle, /runtime_authority\s*=/);
  console.log("  ok  migration source matches SA-6.7 / SA-6.13; no runtime_authority write");
}

async function main(): Promise<void> {
  console.log("authority resolutions selftest");
  await testInsertAndList();
  await testProviderMessageIdIsIdempotent();
  await testCloseUnresolved();
  await testCloseScopedByCaseAndConversation();
  await testReopenAndIdentityConflicts();
  await testConfidentStateRefused();
  await testMigrationSource();
  console.log("authority resolutions selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
