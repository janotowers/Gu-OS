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
  insertAuthorityResolution,
  listAuthorityResolutionsForCases,
} from "./authority-resolutions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORG = "11111111-1111-1111-1111-111111111111";
const CASE_ID = "cccccccccccccccc-cccc-cccc-cccc-cccccccccccc";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): DbClient {
  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
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
      insert: (values: Row) => {
        const inserted = {
          id: `res-${(tables[table] ?? []).length + 1}`,
          created_at: "2026-09-18T02:10:00.000Z",
          ...values,
        };
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
        return self;
      },
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
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
  console.log("  ok  migration source matches SA-6.7 / SA-6.13; no runtime_authority write");
}

async function main(): Promise<void> {
  console.log("authority resolutions selftest");
  await testInsertAndList();
  await testConfidentStateRefused();
  await testMigrationSource();
  console.log("authority resolutions selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
