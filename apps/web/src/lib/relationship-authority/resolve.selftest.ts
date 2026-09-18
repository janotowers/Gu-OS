/**
 * Deterministic selftests for `resolveInteractionAuthority` (R1 SL-6 T3).
 *
 *   SA-6.2  advisor_wa cannot mint authority
 *   SA-6.3  the answer comes from the current-state capability, not a projection
 *   SA-6.5  per-lead takeover and per-number kill switch stay distinct
 *   SA-6.6  read failure / ambiguity / conflict fail closed; no stale fallback
 *   SA-6.11 the answer writes no runtime_authority and pauses nothing
 *
 * Persistence of unknown/conflicting (SA-6.7 / SA-6.8) is T4.
 * The resume window (SA-6.14) is T6's oracle.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "@agents/db";
import type {
  InteractionAuthorityResolution,
  LegacyConversationAuthority,
  LegacyReadResult,
} from "@agents/types";
import { LegacyReadRefusal } from "../legacy-gateway/errors";
import { resolveInteractionAuthority } from "./resolve";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const CASE_ID = "cccccccccccccccc-cccc-cccc-cccc-cccccccccccc";
const LEAD = "5215500000001521550000000252155000000003";
const OTHER_LEAD = "5215500000009521550000000252155000000003";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): {
  db: DbClient;
  writes: Array<{ table: string; op: string; values: Row }>;
} {
  const writes: Array<{ table: string; op: string; values: Row }> = [];
  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      insert: (values: Row) => {
        writes.push({ table, op: "insert", values });
        return self;
      },
      update: (values: Row) => {
        writes.push({ table, op: "update", values });
        return self;
      },
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

function currentResult(
  overrides: Partial<LegacyConversationAuthority> = {}
): LegacyReadResult<LegacyConversationAuthority> {
  return {
    value: {
      legacyLeadId: LEAD,
      leadTakeoverActive: false,
      lastOwnerInteractionAt: "2026-09-17T18:00:00.000Z",
      numberKillSwitchActive: false,
      guNumberRef: "5215500000003",
      ...overrides,
    },
    provenance: {
      sourceSystem: "traditional_gu",
      store: "mongo",
      sourcePath: "gu2.users",
      externalId: LEAD,
      capability: "legacy_conversation_authority_get",
      adapter: "bootstrap_direct",
      organizationId: ORG,
      bindingState: "unbound",
      freshness: {
        readAt: "2026-09-18T00:00:00.000Z",
        sourceUpdatedAt: "2026-09-17T18:00:00.000Z",
        ageSeconds: 21600,
        sourceUpdatedAtField: "last_owner_interaction_wba",
      },
    },
  };
}

function ctx(db: DbClient, organizationId = ORG) {
  return { db, organizationId };
}

function guBinding(overrides: Row = {}): Row {
  return {
    id: "bind-gu",
    organization_id: ORG,
    case_id: CASE_ID,
    contact_id: "contact-1",
    provider: "whatsapp_business",
    external_conversation_ref: LEAD,
    thread_kind: "gu",
    conversation_authority: "human_active",
    last_human_activity_at: "2026-09-01T00:00:00.000Z",
    authority_source: "stale_projection",
    status: "active",
    ...overrides,
  };
}

async function testCurrentReadNotProjection(): Promise<void> {
  const { db, writes } = fakeDb({
    operational_cases: [
      {
        id: CASE_ID,
        organization_id: ORG,
        runtime_authority: "legacy",
      },
    ],
    external_conversation_bindings: [guBinding()],
  });

  let readLead: string | null = null;
  const result = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { caseId: CASE_ID, legacyLeadId: LEAD },
    readCurrent: async (legacyLeadId) => {
      readLead = legacyLeadId;
      return currentResult({ leadTakeoverActive: false });
    },
  });

  assert.equal(readLead, LEAD);
  assert.equal(result.conversationAuthority, "gu");
  assert.equal(result.humanActive, false);
  assert.equal(result.runtimeAuthority, "legacy");
  assert.equal(result.answeredFrom, "legacy_conversation_authority_get");
  assert.equal(result.provenance?.capability, "legacy_conversation_authority_get");
  assert.equal(writes.length, 0, "resolver must not write");

  console.log("  ok  SA-6.3 answer is the current read, not the binding projection");
}

async function testAdvisorWaCannotMint(): Promise<void> {
  let called = false;
  const { db } = fakeDb({
    operational_cases: [
      { id: CASE_ID, organization_id: ORG, runtime_authority: "legacy" },
    ],
    external_conversation_bindings: [
      {
        ...guBinding({
          id: "bind-wa",
          thread_kind: "advisor_wa",
          conversation_authority: null,
          last_human_activity_at: null,
          authority_source: null,
          external_conversation_ref: "asesor_5215500000001",
        }),
      },
    ],
  });

  const result = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { caseId: CASE_ID, threadKind: "advisor_wa" },
    readCurrent: async () => {
      called = true;
      return currentResult({ leadTakeoverActive: true });
    },
  });

  assert.equal(called, false, "advisor_wa must not trigger a current-state mint");
  assert.equal(result.conversationAuthority, "unknown");
  assert.equal(result.humanActive, null);
  assert.equal(result.advisorWaIgnored, true);
  assert.equal(result.answeredFrom, "none");
  assert.equal(result.failSafeReason, "advisor_wa_cannot_mint_authority");

  console.log("  ok  SA-6.2 advisor_wa cannot mint conversation authority");
}

async function testKillSwitchStaysDistinct(): Promise<void> {
  const { db } = fakeDb({});
  const result = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { legacyLeadId: LEAD },
    readCurrent: async () =>
      currentResult({
        leadTakeoverActive: false,
        numberKillSwitchActive: true,
      }),
  });
  assert.equal(result.conversationAuthority, "gu");
  assert.equal(result.humanActive, false);
  assert.equal(result.numberKillSwitchActive, true);
  assert.notEqual(
    result.humanActive,
    result.numberKillSwitchActive,
    "the number kill switch is not conversation authority"
  );
  console.log("  ok  SA-6.5 number kill switch is not folded into humanActive");
}

async function testFailClosed(): Promise<void> {
  const { db } = fakeDb({});

  const induced = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { legacyLeadId: LEAD },
    readCurrent: async () => {
      throw new Error("mongo unavailable");
    },
  });
  assert.equal(induced.conversationAuthority, "unknown");
  assert.equal(induced.humanActive, null);
  assert.equal(induced.failSafeReason, "read_failure");
  assert.equal(induced.answeredFrom, "none");

  const ambiguous = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { legacyLeadId: LEAD },
    readCurrent: async () => {
      throw new LegacyReadRefusal(
        "pairing_ambiguous",
        "legacy_conversation_authority_get",
        LEAD
      );
    },
  });
  assert.equal(ambiguous.conversationAuthority, "conflicting");
  assert.equal(ambiguous.humanActive, null);
  assert.equal(ambiguous.failSafeReason, "pairing_ambiguous");

  const missing = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { legacyLeadId: LEAD },
    readCurrent: async () => {
      throw new LegacyReadRefusal(
        "not_found",
        "legacy_conversation_authority_get",
        LEAD
      );
    },
  });
  assert.equal(missing.conversationAuthority, "unknown");
  assert.equal(missing.failSafeReason, "not_found");

  const mismatch = await resolveInteractionAuthority({
    ctx: ctx(
      fakeDb({
        operational_cases: [
          { id: CASE_ID, organization_id: ORG, runtime_authority: "legacy" },
        ],
        external_conversation_bindings: [guBinding()],
      }).db
    ),
    refs: { caseId: CASE_ID, legacyLeadId: OTHER_LEAD },
    readCurrent: async () => currentResult({ leadTakeoverActive: true }),
  });
  assert.equal(mismatch.conversationAuthority, "conflicting");
  assert.equal(mismatch.failSafeReason, "lead_ref_does_not_match_gu_binding");

  const noLead = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: {},
    readCurrent: async () => currentResult(),
  });
  assert.equal(noLead.conversationAuthority, "unknown");
  assert.equal(noLead.failSafeReason, "no_legacy_lead_id");

  console.log("  ok  SA-6.6 fail-safe unknown/conflicting; no confident guess");
}

async function testForeignCaseDoesNotLeakRuntime(): Promise<void> {
  const { db } = fakeDb({
    operational_cases: [
      {
        id: CASE_ID,
        organization_id: OTHER_ORG,
        runtime_authority: "gu_os",
      },
    ],
  });
  const result = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { caseId: CASE_ID, legacyLeadId: LEAD },
    readCurrent: async () => currentResult({ leadTakeoverActive: false }),
  });
  assert.equal(result.runtimeAuthority, null);
  assert.equal(result.conversationAuthority, "gu");
  console.log("  ok  a Case in another Organization does not leak runtime_authority");
}

async function testAnswerWritesNothing(): Promise<void> {
  const { db, writes } = fakeDb({
    operational_cases: [
      {
        id: CASE_ID,
        organization_id: ORG,
        runtime_authority: "legacy",
        status: "active",
      },
    ],
    external_conversation_bindings: [guBinding()],
  });

  const result = await resolveInteractionAuthority({
    ctx: ctx(db),
    refs: { caseId: CASE_ID, legacyLeadId: LEAD, threadKind: "advisor_wa" },
    readCurrent: async () => currentResult({ leadTakeoverActive: true }),
  });

  assert.equal(result.conversationAuthority, "human_active");
  assert.equal(result.advisorWaIgnored, true);
  assert.equal(result.runtimeAuthority, "legacy");
  assert.equal(writes.length, 0);
  assert.equal(
    writes.some((write) => write.table === "operational_cases"),
    false
  );
  console.log("  ok  SA-6.11 the answer writes nothing and does not move runtime_authority");
}

function testSourceHasNoWindowOrWriter(): void {
  const source = [
    "resolve.ts",
    "index.ts",
  ]
    .map((file) => readFileSync(path.join(__dirname, file), "utf8"))
    .join("\n");

  assert.equal(/5\s*\*\s*60/.test(source), false);
  assert.equal(/300000/.test(source), false);
  assert.equal(/five[\s-]?minute/i.test(source), false);
  assert.equal(/updateConversationAuthority/.test(source), false);
  assert.equal(/runtime_authority\s*:/.test(source), false);
  assert.equal(/status:\s*["']paused["']/.test(source), false);
  assert.equal(/conversation_authority\s*:/.test(source), false);

  console.log("  ok  resolver source has no resume window and no authority writer");
}

function assertResolutionShape(result: InteractionAuthorityResolution): void {
  assert.ok(result.organizationId);
  assert.ok(
    ["gu", "human_active", "unknown", "conflicting"].includes(
      result.conversationAuthority
    )
  );
}

async function main(): Promise<void> {
  console.log("interaction authority resolver selftest");
  await testCurrentReadNotProjection();
  await testAdvisorWaCannotMint();
  await testKillSwitchStaysDistinct();
  await testFailClosed();
  await testForeignCaseDoesNotLeakRuntime();
  await testAnswerWritesNothing();
  testSourceHasNoWindowOrWriter();
  assertResolutionShape(
    await resolveInteractionAuthority({
      ctx: ctx(fakeDb({}).db),
      refs: { legacyLeadId: LEAD },
      readCurrent: async () => currentResult(),
    })
  );
  console.log("interaction authority resolver selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
