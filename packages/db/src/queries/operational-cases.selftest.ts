/**
 * Selftests for `createOperationalCase` scheduling semantics.
 *
 * Narrow on purpose: this file exists because R1 SL-2 exposed a defect in a
 * SHARED helper, and a shared-helper repair needs regression evidence at the
 * helper boundary rather than only at the boundary of the Slice that found it.
 *
 * The defect: `next_action_at: input.nextActionAt ?? new Date().toISOString()`.
 * `??` cannot distinguish "the caller said nothing" from "the caller said
 * null", so a call site passing an explicit null to mean *do not schedule this
 * Case* still received `now` — and the cron scanner, which selects on
 * `next_action_at` for `active` / `waiting_external` cases, picked it up anyway.
 *
 * Three call sites were already written expecting null to mean null:
 *
 *   * `ensure-conversational-case.ts` — `e2eControlled || incompleteDraft`;
 *   * `operational-case-tests/route.ts` — the controlled test playthrough;
 *   * R1 admission — a shadow Opportunity must schedule no work at all.
 *
 * The repaired contract, asserted below: **omitted keeps the existing default,
 * explicit null persists NULL.**
 */
import assert from "node:assert/strict";
import type { DbClient } from "../client";
import { createOperationalCase } from "./operational-cases";

type Row = Record<string, unknown>;

const USER = "11111111-1111-1111-1111-111111111111";
const CASE_TYPE_ID = "22222222-2222-2222-2222-222222222222";

/** Records what would be written, which is exactly what is under test. */
function fakeDb(): { db: DbClient; inserted: Row[] } {
  const inserted: Row[] = [];
  const definitions: Row[] = [
    {
      id: "33333333-3333-3333-3333-333333333333",
      owner_scope: "global",
      user_id: null,
      case_type: "property_optioning",
      status: "published",
      version: 1,
    },
  ];

  function builder(table: string) {
    let rows = table === "workflow_definitions" ? definitions.slice() : [];
    let pending: Row | null = null;
    const self: Record<string, unknown> = {
      select: () => self,
      insert: (values: Row) => {
        pending = values;
        return self;
      },
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return self;
      },
      is: (column: string) => {
        rows = rows.filter((row) => row[column] === null);
        return self;
      },
      order: () => self,
      limit: () => self,
      single: async () => {
        if (pending) {
          const row = { id: "case-1", ...pending };
          inserted.push(row);
          return { data: row, error: null };
        }
        return { data: rows[0] ?? null, error: null };
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }

  return {
    db: { from: (table: string) => builder(table) } as unknown as DbClient,
    inserted,
  };
}

async function created(input: Parameters<typeof createOperationalCase>[1]) {
  const { db, inserted } = fakeDb();
  await createOperationalCase(db, input);
  return inserted[0];
}

const base = {
  userId: USER,
  caseTypeId: CASE_TYPE_ID,
  caseType: "property_optioning",
} as const;

async function testOmittedKeepsTheDefault(): Promise<void> {
  const row = await created({ ...base });
  assert.ok(
    typeof row.next_action_at === "string",
    "omitting nextActionAt still schedules immediately, as every existing caller expects"
  );
  const scheduled = new Date(row.next_action_at as string).getTime();
  assert.ok(
    Math.abs(scheduled - Date.now()) < 60_000,
    "the default is now, not some other instant"
  );
}

async function testExplicitNullPersistsNull(): Promise<void> {
  const row = await created({ ...base, nextActionAt: null });
  assert.equal(
    row.next_action_at,
    null,
    "explicit null means do not schedule — the cron scanner must not see this Case"
  );
}

async function testExplicitValueIsHonoured(): Promise<void> {
  const at = "2026-12-01T09:00:00.000Z";
  const row = await created({ ...base, nextActionAt: at });
  assert.equal(row.next_action_at, at);
}

/**
 * The two pre-existing controlled paths, expressed exactly as their call sites
 * compute the argument. Both intend "do not schedule"; both used to be
 * scheduled anyway.
 */
async function testControlledCallersStayUnscheduled(): Promise<void> {
  // ensure-conversational-case.ts:
  //   nextActionAt: e2eControlled || incompleteDraft ? null : new Date().toISOString()
  for (const [e2eControlled, incompleteDraft] of [
    [true, false],
    [false, true],
    [true, true],
  ] as Array<[boolean, boolean]>) {
    const row = await created({
      ...base,
      nextActionAt:
        e2eControlled || incompleteDraft ? null : new Date().toISOString(),
    });
    assert.equal(
      row.next_action_at,
      null,
      `controlled conversational case (e2e=${e2eControlled}, draft=${incompleteDraft}) must not be scheduled`
    );
  }

  // operational-case-tests/route.ts — the controlled test playthrough.
  const playthrough = await created({
    ...base,
    status: "active",
    currentStep: "intake",
    nextActionAt: null,
  });
  assert.equal(playthrough.next_action_at, null);

  // And the ordinary conversational path is unchanged: still scheduled.
  const live = await created({
    ...base,
    nextActionAt: new Date().toISOString(),
  });
  assert.ok(typeof live.next_action_at === "string");
}

/** R1 SL-2: a shadow Opportunity carries responsibility, not scheduled work. */
async function testShadowOpportunityIsUnscheduled(): Promise<void> {
  const row = await created({
    ...base,
    caseType: "lead_opportunity",
    organizationId: "44444444-4444-4444-4444-444444444444",
    runtimeAuthority: "legacy",
    currentStep: null,
    nextActionAt: null,
  });
  assert.equal(row.next_action_at, null);
  assert.equal(row.organization_id, "44444444-4444-4444-4444-444444444444");
  assert.equal(row.runtime_authority, "legacy");
  assert.equal(row.current_step, null);
}

const tests: Array<[string, () => Promise<void>]> = [
  ["omitted nextActionAt keeps the existing default", testOmittedKeepsTheDefault],
  ["explicit null persists NULL", testExplicitNullPersistsNull],
  ["an explicit instant is honoured", testExplicitValueIsHonoured],
  ["pre-existing controlled callers stay unscheduled", testControlledCallersStayUnscheduled],
  ["a shadow Opportunity schedules nothing", testShadowOpportunityIsUnscheduled],
];

async function main(): Promise<void> {
  for (const [name, run] of tests) {
    await run();
    console.log(`  ok  ${name}`);
  }
  console.log(`operational-cases selftest: ${tests.length} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
