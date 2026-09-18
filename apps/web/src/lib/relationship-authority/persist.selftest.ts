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
import {
  persistFailSafeAuthorityResolution,
  recordAuthorityResolutionObservation,
} from "./persist";
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
  tables: Record<string, Row[]>;
} {
  const writes: Array<{ table: string; values: Row }> = [];
  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    const self: Record<string, unknown> = {
      select: () => self,
      in: () => self,
      order: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
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
          writes.push({ table, values });
          rows = [existing];
          self.single = async () => ({
            data: null,
            error: { code: "23505", message: "duplicate" },
          });
          return self;
        }
        writes.push({ table, values });
        const inserted = {
          id: `resolution-${(tables[table] ?? []).length + 1}`,
          created_at: "2026-09-18T02:10:00.000Z",
          resolved_at: null,
          resolved_as: null,
          provider_message_id: values.provider_message_id ?? null,
          ...values,
        };
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
        self.single = async () => ({ data: inserted, error: null });
        return self;
      },
      update: (values: Row) => {
        writes.push({ table, values });
        for (const row of tables[table] ?? []) {
          if (row.resolved_at == null) Object.assign(row, values);
        }
        rows = (tables[table] ?? []).filter((row) => row.resolved_at != null);
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
    tables,
    db: { from: (table: string) => builder(table) } as unknown as DbClient,
  };
}

function failSafe(
  state: "unknown" | "conflicting"
): InteractionAuthorityResolution {
  return {
    organizationId: ORG,
    caseId: CASE_ID,
    runtimeAuthority: "legacy",
    runtimeAuthorityReadFailed: false,
    bindingReadFailed: false,
    observedOwnerRef: "PrincipalUid00000000000000000001",
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
    provider_message_id: "wamid-1",
    resolved_at: null,
    resolved_as: null,
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

async function testRetryDoesNotDuplicateIncident(): Promise<void> {
  const { db, writes } = fakeDb({ authority_resolutions: [] });
  const first = await persistFailSafeAuthorityResolution({
    db,
    resolution: failSafe("unknown"),
    caseId: CASE_ID,
    legacyLeadId: LEAD,
    providerMessageId: "wamid-retry",
    detectedAt: "2026-09-18T02:10:00.000Z",
  });
  const second = await persistFailSafeAuthorityResolution({
    db,
    resolution: failSafe("unknown"),
    caseId: CASE_ID,
    legacyLeadId: LEAD,
    providerMessageId: "wamid-retry",
    detectedAt: "2026-09-18T02:11:00.000Z",
  });
  assert.ok(first);
  assert.equal(second?.id, first?.id);
  assert.equal(
    writes.filter((write) => write.table === "authority_resolutions").length >= 1,
    true
  );
  console.log("  ok  retrying one provider_message_id does not create a second incident");
}

async function testConfidentClosesUnresolvedIncident(): Promise<void> {
  const existing: AuthorityResolution = {
    id: "resolution-open",
    organization_id: ORG,
    case_id: CASE_ID,
    external_conversation_ref: LEAD,
    state: "unknown",
    detected_at: "2026-09-18T02:10:00.000Z",
    fail_safe_reason: "read_failure",
    provenance_jsonb: {},
    runtime_authority_observed: "legacy",
    provider_message_id: "wamid-1",
    resolved_at: null,
    resolved_as: null,
    created_at: "2026-09-18T02:10:00.000Z",
  };
  const { db, writes, tables } = fakeDb({ authority_resolutions: [{ ...existing }] });
  const row = await recordAuthorityResolutionObservation({
    db,
    resolution: {
      ...failSafe("unknown"),
      conversationAuthority: "gu",
      humanActive: false,
    },
    caseId: CASE_ID,
    legacyLeadId: LEAD,
    detectedAt: "2026-09-18T02:20:00.000Z",
  });
  assert.equal(row, null);
  assert.equal(tables.authority_resolutions?.[0]?.resolved_at, "2026-09-18T02:20:00.000Z");
  assert.equal(tables.authority_resolutions?.[0]?.resolved_as, "gu");
  assert.equal(tables.authority_resolutions?.[0]?.id, "resolution-open");
  assert.equal(
    writes.some((write) => write.table === "operational_cases"),
    false
  );
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
    authorityResolutions: tables.authority_resolutions as unknown as AuthorityResolution[],
  });
  assert.equal(snapshot.authority_conflict, null);
  const items = evaluateMustSurface(snapshot, new Date("2026-09-18T03:00:00.000Z"));
  assert.equal(items.some((item) => item.predicate === "authority_conflict"), false);
  console.log("  ok  unknown then confident gu no longer surfaces; history remains");
}

async function testConflictingThenHumanActiveCloses(): Promise<void> {
  const existing: AuthorityResolution = {
    id: "resolution-conflict",
    organization_id: ORG,
    case_id: CASE_ID,
    external_conversation_ref: LEAD,
    state: "conflicting",
    detected_at: "2026-09-18T02:10:00.000Z",
    fail_safe_reason: "pairing_ambiguous",
    provenance_jsonb: {},
    runtime_authority_observed: "legacy",
    provider_message_id: "wamid-conflict",
    resolved_at: null,
    resolved_as: null,
    created_at: "2026-09-18T02:10:00.000Z",
  };
  const { db, tables } = fakeDb({ authority_resolutions: [{ ...existing }] });
  await recordAuthorityResolutionObservation({
    db,
    resolution: {
      ...failSafe("conflicting"),
      conversationAuthority: "human_active",
      humanActive: true,
    },
    caseId: CASE_ID,
    legacyLeadId: LEAD,
    detectedAt: "2026-09-18T02:30:00.000Z",
  });
  assert.equal(tables.authority_resolutions?.[0]?.resolved_as, "human_active");
  assert.equal(tables.authority_resolutions?.[0]?.id, "resolution-conflict");
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
    authorityResolutions: tables.authority_resolutions as unknown as AuthorityResolution[],
  });
  assert.equal(snapshot.authority_conflict, null);
  console.log("  ok  conflicting then confident human_active no longer surfaces");
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
  await testRetryDoesNotDuplicateIncident();
  await testConfidentClosesUnresolvedIncident();
  await testConflictingThenHumanActiveCloses();
  testPersistSourceWritesNoRuntimeAuthority();
  console.log("authority resolution persist selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
