/**
 * SA-6.7 / SA-6.8: fail-safe resolutions persist, and the Portfolio
 * producer reads them. Logging is not persistence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorityResolution, InteractionAuthorityResolution } from "@agents/types";
import type { DbClient } from "@agents/db";
import { persistFailSafeAuthorityResolution } from "./persist";
import { buildCaseSnapshots } from "../work-portfolio/snapshot";
import { evaluateMustSurface } from "../work-portfolio/must-surface";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORG = "11111111-1111-1111-1111-111111111111";
const CASE_ID = "cccccccccccccccc-cccc-cccc-cccc-cccccccccccc";
const LEAD = "5215500000001521550000000252155000000003";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): {
  db: DbClient;
  writes: Array<{ table: string; values: Row }>;
} {
  const writes: Array<{ table: string; values: Row }> = [];
  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      in: () => self,
      order: () => self,
      insert: (values: Row) => {
        writes.push({ table, values });
        const inserted = {
          id: "resolution-1",
          created_at: "2026-09-18T02:10:00.000Z",
          ...values,
        };
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
        return self;
      },
      update: (values: Row) => {
        writes.push({ table, values });
        return self;
      },
      single: async () => ({ data: rows[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }
  return {
    writes,
    db: { from: (table: string) => builder(table) } as unknown as DbClient,
  };
}

function failSafe(
  state: "unknown" | "conflicting"
): InteractionAuthorityResolution {
  return {
    organizationId: ORG,
    runtimeAuthority: "legacy",
    conversationAuthority: state,
    humanActive: null,
    leadTakeoverActive: null,
    lastOwnerInteractionAt: null,
    numberKillSwitchActive: null,
    guNumberRef: null,
    advisorWaIgnored: false,
    answeredFrom: "none",
    provenance: null,
    failSafeReason: state === "conflicting" ? "pairing_ambiguous" : "read_failure",
  };
}

async function testPersistWritesRow(): Promise<void> {
  const { db, writes } = fakeDb({ authority_resolutions: [] });
  const row = await persistFailSafeAuthorityResolution({
    db,
    resolution: failSafe("unknown"),
    caseId: CASE_ID,
    legacyLeadId: LEAD,
    detectedAt: "2026-09-18T02:10:00.000Z",
  });
  assert.ok(row);
  assert.equal(row.state, "unknown");
  assert.equal(row.case_id, CASE_ID);
  assert.equal(
    writes.some((write) => write.table === "operational_cases"),
    false
  );
  assert.equal(writes[0]?.table, "authority_resolutions");
  console.log("  ok  SA-6.7 unknown persists as a row, not a log line");
}

async function testConfidentAnswerNotPersisted(): Promise<void> {
  const { db, writes } = fakeDb({ authority_resolutions: [] });
  const row = await persistFailSafeAuthorityResolution({
    db,
    resolution: { ...failSafe("unknown"), conversationAuthority: "gu", humanActive: false },
    caseId: CASE_ID,
  });
  assert.equal(row, null);
  assert.equal(writes.length, 0);
  console.log("  ok  a confident answer is not an authority_resolution incident");
}

async function testPortfolioProducer(): Promise<void> {
  const resolution: AuthorityResolution = {
    id: "resolution-live-1",
    organization_id: ORG,
    case_id: CASE_ID,
    external_conversation_ref: LEAD,
    state: "conflicting",
    detected_at: "2026-09-18T02:10:00.000Z",
    fail_safe_reason: "pairing_ambiguous",
    provenance_jsonb: {},
    runtime_authority_observed: "legacy",
    created_at: "2026-09-18T02:10:00.000Z",
  };
  const [snapshot] = buildCaseSnapshots({
    organizationId: ORG,
    cases: [
      {
        id: CASE_ID,
        user_id: "user-1",
        case_type_id: "type-1",
        case_type: "lead_opportunity",
        status: "active",
        current_step: null,
        assigned_to_user_id: null,
        external_contact_jsonb: {},
        next_action_at: null,
        due_at: null,
        context_jsonb: {},
        version: 1,
        workflow_definition_id: null,
        workflow_definition_version: null,
        organization_id: ORG,
        runtime_authority: "legacy",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    facts: [],
    subjects: [],
    events: [],
    approvals: [],
    work: [],
    authorityResolutions: [resolution],
  });
  assert.deepEqual(snapshot.authority_conflict, {
    resolution_id: "resolution-live-1",
    state: "conflicting",
    detected_at: "2026-09-18T02:10:00.000Z",
  });
  const items = evaluateMustSurface(snapshot, new Date("2026-09-18T03:00:00.000Z"));
  assert.equal(items.some((item) => item.predicate === "authority_conflict"), true);
  console.log("  ok  SA-6.8 the persisted row reaches must-surface");
}

function testPersistSourceWritesNoRuntimeAuthority(): void {
  const source = readFileSync(path.join(__dirname, "persist.ts"), "utf8");
  assert.equal(/operational_cases/.test(source), false);
  assert.equal(/five[\s-]?minute/i.test(source), false);
  console.log("  ok  persist writes authority_resolutions only");
}

async function main(): Promise<void> {
  console.log("authority resolution persist selftest");
  await testPersistWritesRow();
  await testConfidentAnswerNotPersisted();
  await testPortfolioProducer();
  testPersistSourceWritesNoRuntimeAuthority();
  console.log("authority resolution persist selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
