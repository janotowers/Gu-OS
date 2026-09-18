/**
 * Deterministic selftests for the SL-15 Contact / opaque `legacy_lead` seam.
 *
 * Covers the TypeScript wrapper, the SQL source contract, the historical
 * backfill helper, and SA-15.5 provenance. PostgreSQL atomicity,
 * unique-violation converge and RLS live in `test-rls/run.ts`.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "../client";
import {
  ConversationBindingConflictError,
} from "./external-conversation-bindings";
import {
  backfillAdmittedLegacyLeadIdentity,
  LegacyLeadContactError,
  requireCreateIdentityProvenance,
  requireOpaqueLegacyLeadId,
  RESERVED_LEGACY_LEAD_PROVENANCE_KEYS,
  resolveOrCreateContactForLegacyLead,
  RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC,
} from "./legacy-lead-contact";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const LEAD = "5215500000001521550000000252155000000003";
const OTHER_LEAD = "5215500000077521550000000252155000000099";
const CASE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_CASE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SOURCE_EVENT_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const OTHER_SOURCE_EVENT = "ffffffff-ffff-ffff-ffff-ffffffffffff";

type Row = Record<string, unknown>;

interface Fake {
  db: DbClient;
  tables: Record<string, Row[]>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function columnValue(row: Row, column: string): unknown {
  const arrow = column.indexOf("->>");
  if (arrow === -1) return row[column];
  const base = column.slice(0, arrow);
  const key = column.slice(arrow + 3);
  const container = row[base];
  if (!container || typeof container !== "object") return undefined;
  return (container as Record<string, unknown>)[key];
}

function fakeDb(
  tables: Record<string, Row[]>,
  rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {}
): Fake {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => columnValue(row, column) === value);
        return self;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () =>
        rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: new Error(`expected one row, got ${rows.length}`) },
      insert: (values: Row) => {
        const inserted = {
          id: `generated-${(tables[table] ?? []).length}`,
          status: "active",
          ended_at: null,
          created_at: "2026-09-18T00:00:00.000Z",
          updated_at: "2026-09-18T00:00:00.000Z",
          ...values,
        };
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
        return self;
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }

  const db = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const handler = rpcs[name];
      if (!handler) return { data: null, error: new Error(`no rpc ${name}`) };
      try {
        return { data: handler(args), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  } as unknown as DbClient;

  return { db, tables, rpcCalls };
}

function evidence(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    basis: "admission",
    source_event_id: SOURCE_EVENT_ID,
    case_id: CASE_ID,
    provisional_materialization: true,
    ...overrides,
  };
}

function memoryPrimitive(tables: Record<string, Row[]>) {
  return (args: Record<string, unknown>) => {
    const organizationId = String(args.p_organization_id ?? "");
    const legacyLeadId = String(args.p_legacy_lead_id ?? "").trim();
    const matches = (tables.external_identity_bindings ?? []).filter(
      (row) =>
        row.source_system === "traditional_gu" &&
        row.binding_kind === "legacy_lead" &&
        row.external_id === legacyLeadId
    );
    if (matches.length > 1) {
      throw new Error("resolve_or_create_contact_for_legacy_lead: ambiguous_binding");
    }
    if (matches.length === 1) {
      if (matches[0].organization_id !== organizationId) {
        throw new Error(
          "resolve_or_create_contact_for_legacy_lead: cross_organization_binding"
        );
      }
      if (!matches[0].ref_contact_id) {
        throw new Error(
          "resolve_or_create_contact_for_legacy_lead: incompatible_binding"
        );
      }
      return matches[0].ref_contact_id;
    }
    let provenance: Record<string, unknown>;
    try {
      provenance = requireCreateIdentityProvenance(args.p_provenance);
    } catch {
      throw new Error(
        "resolve_or_create_contact_for_legacy_lead: missing_provenance"
      );
    }
    const contactId = `contact-${(tables.contacts ?? []).length + 1}`;
    (tables.contacts ??= []).push({
      id: contactId,
      organization_id: organizationId,
    });
    (tables.external_identity_bindings ??= []).push({
      id: `bind-${contactId}`,
      organization_id: organizationId,
      source_system: "traditional_gu",
      binding_kind: "legacy_lead",
      external_id: legacyLeadId,
      ref_contact_id: contactId,
      provenance_jsonb: {
        ...provenance,
        source: "resolve_or_create_contact_for_legacy_lead",
        source_system: "traditional_gu",
        binding_kind: "legacy_lead",
        opaque_legacy_lead_ref: legacyLeadId,
        organization_id: organizationId,
      },
    });
    return contactId;
  };
}

function sourceEvent(overrides: Row = {}): Row {
  return {
    id: SOURCE_EVENT_ID,
    organization_id: ORG,
    source_system: "traditional_gu",
    event_kind: "inbound_prospect_message",
    external_lead_ref: LEAD,
    status: "completed",
    decision_jsonb: { disposition: "admitted" },
    admitted_case_id: CASE_ID,
    ...overrides,
  };
}

function admittedCase(overrides: Row = {}): Row {
  return {
    id: CASE_ID,
    organization_id: ORG,
    case_type: "lead_opportunity",
    context_jsonb: {
      legacy_lead_id: LEAD,
      source_event_id: SOURCE_EVENT_ID,
      source_system: "traditional_gu",
    },
    ...overrides,
  };
}

function governedTables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    contacts: [],
    external_identity_bindings: [],
    external_conversation_bindings: [],
    operational_cases: [admittedCase()],
    source_events: [sourceEvent()],
    ...extra,
  };
}

async function testWrapperTrimsAndDoesNotParse(): Promise<void> {
  const tables: Record<string, Row[]> = { contacts: [], external_identity_bindings: [] };
  const { db, rpcCalls } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  const id = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: `  ${ORG}  `,
    legacyLeadId: `  ${LEAD}  `,
    provenance: evidence(),
  });
  assert.equal(id, "contact-1");
  assert.equal(rpcCalls[0].name, RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC);
  assert.equal(rpcCalls[0].args.p_legacy_lead_id, LEAD);
  assert.equal(rpcCalls[0].args.p_organization_id, ORG);
  assert.equal(
    (rpcCalls[0].args.p_provenance as { basis?: string }).basis,
    "admission"
  );

  await assert.rejects(
    () =>
      resolveOrCreateContactForLegacyLead(db, {
        organizationId: ORG,
        legacyLeadId: "   ",
        provenance: evidence(),
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError &&
      error.code === "missing_legacy_lead_id"
  );
  assert.equal(requireOpaqueLegacyLeadId(` ${LEAD} `, "x"), LEAD);
}

async function testReuseAndTwoLeads(): Promise<void> {
  const tables: Record<string, Row[]> = { contacts: [], external_identity_bindings: [] };
  const primitive = memoryPrimitive(tables);
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: primitive,
  });

  const first = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: ORG,
    legacyLeadId: LEAD,
    provenance: evidence(),
  });
  const again = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: ORG,
    legacyLeadId: LEAD,
    provenance: evidence({
      basis: "historical_backfill",
      source_event_id: OTHER_SOURCE_EVENT,
    }),
  });
  assert.equal(again, first, "SA-15.2: reuse the existing Contact");
  assert.equal(tables.contacts.length, 1);
  assert.equal(
    (tables.external_identity_bindings[0].provenance_jsonb as { basis?: string })
      .basis,
    "admission",
    "SA-15.5: reuse does not rewrite provenance"
  );
  assert.equal(
    (tables.external_identity_bindings[0].provenance_jsonb as { source_event_id?: string })
      .source_event_id,
    SOURCE_EVENT_ID
  );

  const other = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: ORG,
    legacyLeadId: OTHER_LEAD,
    provenance: evidence({ case_id: OTHER_CASE }),
  });
  assert.notEqual(other, first, "SA-15.4: a different lead is a different Contact");
  assert.equal(tables.contacts.length, 2);
}

async function testProvenanceIsGuaranteedOnCreate(): Promise<void> {
  const tables: Record<string, Row[]> = { contacts: [], external_identity_bindings: [] };
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  await assert.rejects(
    () =>
      resolveOrCreateContactForLegacyLead(db, {
        organizationId: ORG,
        legacyLeadId: LEAD,
        provenance: {},
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError && error.code === "missing_provenance"
  );
  await assert.rejects(
    () =>
      resolveOrCreateContactForLegacyLead(db, {
        organizationId: ORG,
        legacyLeadId: LEAD,
        provenance: [] as unknown as Record<string, unknown>,
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError && error.code === "missing_provenance"
  );
  await assert.rejects(
    () =>
      resolveOrCreateContactForLegacyLead(db, {
        organizationId: ORG,
        legacyLeadId: LEAD,
        provenance: evidence({ provisional_materialization: false }),
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError && error.code === "missing_provenance"
  );
  assert.equal(tables.contacts.length, 0);

  const created = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: ORG,
    legacyLeadId: LEAD,
    provenance: evidence({
      source: "attacker",
      source_system: "forged",
      binding_kind: "forged",
      opaque_legacy_lead_ref: "forged-lead",
      organization_id: OTHER,
      extra: "kept",
    }),
  });
  assert.equal(created, "contact-1");
  const stored = tables.external_identity_bindings[0]
    .provenance_jsonb as Record<string, unknown>;
  assert.equal(stored.source, "resolve_or_create_contact_for_legacy_lead");
  assert.equal(stored.source_system, "traditional_gu");
  assert.equal(stored.binding_kind, "legacy_lead");
  assert.equal(stored.opaque_legacy_lead_ref, LEAD);
  assert.equal(stored.organization_id, ORG);
  assert.equal(stored.extra, "kept");
  assert.equal(stored.basis, "admission");
  assert.equal(stored.provisional_materialization, true);
}

async function testFailClosed(): Promise<void> {
  {
    const tables: Record<string, Row[]> = {
      contacts: [],
      external_identity_bindings: [
        {
          organization_id: OTHER,
          source_system: "traditional_gu",
          binding_kind: "legacy_lead",
          external_id: LEAD,
          ref_contact_id: "c-other",
        },
      ],
    };
    const { db } = fakeDb(tables, {
      [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
    });
    await assert.rejects(
      () =>
        resolveOrCreateContactForLegacyLead(db, {
          organizationId: ORG,
          legacyLeadId: LEAD,
          provenance: evidence(),
        }),
      (error: unknown) =>
        error instanceof LegacyLeadContactError &&
        error.code === "cross_organization_binding"
    );
    assert.equal(tables.contacts.length, 0);
  }

  {
    const tables: Record<string, Row[]> = {
      contacts: [],
      external_identity_bindings: [
        {
          organization_id: ORG,
          source_system: "traditional_gu",
          binding_kind: "legacy_lead",
          external_id: LEAD,
          ref_case_id: CASE_ID,
          ref_contact_id: null,
        },
      ],
    };
    const { db } = fakeDb(tables, {
      [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
    });
    await assert.rejects(
      () =>
        resolveOrCreateContactForLegacyLead(db, {
          organizationId: ORG,
          legacyLeadId: LEAD,
          provenance: evidence(),
        }),
      (error: unknown) =>
        error instanceof LegacyLeadContactError &&
        error.code === "incompatible_binding"
    );
    assert.equal(tables.contacts.length, 0);
  }
}

async function testBackfillRequiresGovernedAdmission(): Promise<void> {
  const tables = governedTables();
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  const result = await backfillAdmittedLegacyLeadIdentity(db, {
    organizationId: ORG,
    caseId: CASE_ID,
  });
  assert.equal(result.contactId, "contact-1");
  assert.equal(result.conversationBinding.contact_id, "contact-1");
  assert.equal(result.conversationBinding.provider, "whatsapp_business");
  assert.equal(result.conversationBinding.thread_kind, "gu");
  assert.equal(
    result.conversationBinding.external_conversation_ref,
    LEAD,
    "SL-6 C2 resolver looks up the opaque legacy lead id, not a WAMID"
  );
  assert.equal(tables.contacts.length, 1);
  const stored = tables.external_identity_bindings[0]
    .provenance_jsonb as Record<string, unknown>;
  assert.equal(stored.basis, "historical_backfill");
  assert.equal(stored.source_event_id, SOURCE_EVENT_ID);
  assert.equal(stored.case_id, CASE_ID);
  assert.equal(stored.provisional_materialization, true);

  const again = await backfillAdmittedLegacyLeadIdentity(db, {
    organizationId: ORG,
    caseId: CASE_ID,
  });
  assert.equal(again.conversationBinding.id, result.conversationBinding.id);
}

async function testManualCaseCannotMintIdentity(): Promise<void> {
  const tables: Record<string, Row[]> = {
    contacts: [],
    external_identity_bindings: [],
    external_conversation_bindings: [],
    operational_cases: [
      {
        id: CASE_ID,
        organization_id: ORG,
        case_type: "lead_opportunity",
        context_jsonb: { legacy_lead_id: LEAD },
      },
    ],
    source_events: [],
  };
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  await assert.rejects(
    () =>
      backfillAdmittedLegacyLeadIdentity(db, {
        organizationId: ORG,
        caseId: CASE_ID,
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError &&
      error.code === "not_governed_admission"
  );
  assert.equal(tables.contacts.length, 0, "no Contact from a constructed Case");
  assert.equal(
    tables.external_identity_bindings.length,
    0,
    "no legacy_lead binding from a constructed Case"
  );
  assert.equal(
    tables.external_conversation_bindings.length,
    0,
    "no conversation binding from a constructed Case"
  );
}

async function testInconsistentAdmissionEvidenceFailsClosed(): Promise<void> {
  const mismatches: Array<{ label: string; tables: Record<string, Row[]> }> = [
    {
      label: "source event lead ref differs",
      tables: governedTables({
        source_events: [sourceEvent({ external_lead_ref: OTHER_LEAD })],
      }),
    },
    {
      label: "decision is not admitted",
      tables: governedTables({
        source_events: [
          sourceEvent({ decision_jsonb: { disposition: "deferred_clarification" } }),
        ],
      }),
    },
    {
      label: "admitted_case_id names another Case",
      tables: governedTables({
        source_events: [sourceEvent({ admitted_case_id: OTHER_CASE })],
      }),
    },
    {
      label: "source event is not completed",
      tables: governedTables({
        source_events: [sourceEvent({ status: "processing" })],
      }),
    },
    {
      label: "source_system is not traditional_gu",
      tables: governedTables({
        source_events: [sourceEvent({ source_system: "other_system" })],
      }),
    },
  ];

  for (const mismatch of mismatches) {
    const { db } = fakeDb(mismatch.tables, {
      [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(
        mismatch.tables
      ),
    });
    await assert.rejects(
      () =>
        backfillAdmittedLegacyLeadIdentity(db, {
          organizationId: ORG,
          caseId: CASE_ID,
        }),
      (error: unknown) =>
        error instanceof LegacyLeadContactError &&
        error.code === "not_governed_admission",
      mismatch.label
    );
    assert.equal(mismatch.tables.contacts.length, 0, mismatch.label);
    assert.equal(mismatch.tables.external_identity_bindings.length, 0, mismatch.label);
    assert.equal(
      mismatch.tables.external_conversation_bindings.length,
      0,
      mismatch.label
    );
  }
}

async function testManualSiblingDoesNotMakeAdmittedCaseAmbiguous(): Promise<void> {
  const tables = governedTables();
  tables.operational_cases.push({
    id: OTHER_CASE,
    organization_id: ORG,
    case_type: "lead_opportunity",
    context_jsonb: { legacy_lead_id: LEAD },
  });
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  const result = await backfillAdmittedLegacyLeadIdentity(db, {
    organizationId: ORG,
    caseId: CASE_ID,
  });
  assert.equal(result.contactId, "contact-1");
  assert.equal(result.conversationBinding.external_conversation_ref, LEAD);

  await assert.rejects(
    () =>
      backfillAdmittedLegacyLeadIdentity(db, {
        organizationId: ORG,
        caseId: OTHER_CASE,
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError &&
      error.code === "not_governed_admission"
  );
}

async function testAmbiguousGovernedCasesFailClosed(): Promise<void> {
  const tables = governedTables({
    operational_cases: [
      admittedCase(),
      admittedCase({
        id: OTHER_CASE,
        context_jsonb: {
          legacy_lead_id: LEAD,
          source_event_id: OTHER_SOURCE_EVENT,
          source_system: "traditional_gu",
        },
      }),
    ],
    source_events: [
      sourceEvent(),
      sourceEvent({
        id: OTHER_SOURCE_EVENT,
        admitted_case_id: OTHER_CASE,
      }),
    ],
  });
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  await assert.rejects(
    () =>
      backfillAdmittedLegacyLeadIdentity(db, {
        organizationId: ORG,
        caseId: CASE_ID,
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError &&
      error.code === "ambiguous_case_mapping"
  );
  assert.equal(tables.contacts.length, 0);
  assert.equal(tables.external_conversation_bindings.length, 0);
}

async function testBackfillRefusesAdvisorWaWinner(): Promise<void> {
  const tables = governedTables({
    contacts: [{ id: "contact-1", organization_id: ORG }],
    external_identity_bindings: [
      {
        organization_id: ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_lead",
        external_id: LEAD,
        ref_contact_id: "contact-1",
        provenance_jsonb: evidence(),
      },
    ],
    external_conversation_bindings: [
      {
        id: "bind-wa",
        organization_id: ORG,
        case_id: CASE_ID,
        contact_id: "contact-1",
        provider: "whatsapp_business",
        external_conversation_ref: LEAD,
        thread_kind: "advisor_wa",
        status: "active",
        gu_channel_identity_binding_id: null,
      },
    ],
  });
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  await assert.rejects(
    () =>
      backfillAdmittedLegacyLeadIdentity(db, {
        organizationId: ORG,
        caseId: CASE_ID,
      }),
    (error: unknown) =>
      error instanceof ConversationBindingConflictError &&
      error.reason === "thread_kind_mismatch"
  );
}

async function testSqlContract(): Promise<void> {
  const migrationPath = path.resolve(
    __dirname,
    "..",
    "..",
    "forward",
    "supabase",
    "migrations",
    "20260918184500_resolve_or_create_contact_for_legacy_lead.sql"
  );
  const sql = await fs.readFile(migrationPath, "utf8");

  assert.ok(sql.includes("create or replace function public.resolve_or_create_contact_for_legacy_lead"));
  assert.ok(sql.includes("when unique_violation then"));
  assert.ok(sql.includes("insert into public.contacts"));
  assert.ok(sql.includes("insert into public.external_identity_bindings"));
  assert.ok(sql.includes("grant  execute on function public.resolve_or_create_contact_for_legacy_lead"));
  assert.ok(sql.includes("to service_role"));
  assert.ok(sql.includes("revoke execute on function public.resolve_or_create_contact_for_legacy_lead"));
  assert.ok(sql.includes("from authenticated"));
  assert.ok(sql.includes("security invoker") || sql.includes("language plpgsql"));
  assert.match(sql, /set search_path = ''/);
  assert.ok(
    sql.includes("v_legacy_lead_id := btrim(p_legacy_lead_id)"),
    "the lead id is trimmed, not parsed"
  );
  assert.ok(sql.includes("missing_provenance"));
  assert.ok(sql.includes("jsonb_typeof(p_provenance) is distinct from 'object'"));
  assert.ok(sql.includes("'admission', 'historical_backfill'"));
  assert.ok(sql.includes("provisional_materialization"));
  assert.ok(sql.includes("- 'opaque_legacy_lead_ref'"));
  assert.ok(sql.includes("- 'organization_id'"));

  const forbidden = [
    /split_part\s*\(\s*p_legacy_lead_id/,
    /substring\s*\(\s*p_legacy_lead_id/,
    /regexp_split_to_array\s*\(\s*p_legacy_lead_id/,
    /regexp_replace\s*\(\s*p_legacy_lead_id/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(sql), `SA-15.1: SQL must not parse the lead id (${pattern})`);
  }

  const ts = await fs.readFile(path.join(__dirname, "legacy-lead-contact.ts"), "utf8");
  assert.ok(!/legacyLeadId\s*\.\s*split\s*\(/.test(ts));
  assert.ok(!/parseLegacyLead/.test(ts));
  assert.ok(!/sendWhatsApp/i.test(ts));
  assert.ok(!/external_effect_operations/.test(ts));
  assert.ok(!/bypass_bot/.test(ts));
  assert.ok(
    !/externalConversationRef\s*:\s*string/.test(ts),
    "backfill must not take a caller conversation ref"
  );
  assert.ok(ts.includes('provider: "whatsapp_business"'));
  assert.ok(ts.includes('threadKind: "gu"'));
  assert.ok(ts.includes("externalConversationRef: proved.legacyLeadId"));
  assert.ok(RESERVED_LEGACY_LEAD_PROVENANCE_KEYS.includes("source"));
}

async function main(): Promise<void> {
  console.log("legacy-lead-contact selftest");
  await testWrapperTrimsAndDoesNotParse();
  console.log("  ok  wrapper trims the opaque id and never parses it");
  await testReuseAndTwoLeads();
  console.log("  ok  reuse one Contact; two leads stay two Contacts");
  await testProvenanceIsGuaranteedOnCreate();
  console.log("  ok  SA-15.5 provenance is required on create and reserved fields cannot be overridden");
  await testFailClosed();
  console.log("  ok  incompatible and cross-Organization bindings fail closed");
  await testBackfillRequiresGovernedAdmission();
  console.log("  ok  backfill requires governed admission and binds the opaque lead id");
  await testManualCaseCannotMintIdentity();
  console.log("  ok  a constructed lead_opportunity with only legacy_lead_id cannot mint identity");
  await testInconsistentAdmissionEvidenceFailsClosed();
  console.log("  ok  inconsistent admission evidence creates nothing");
  await testManualSiblingDoesNotMakeAdmittedCaseAmbiguous();
  console.log("  ok  a constructed sibling does not make a governed Case ambiguous");
  await testAmbiguousGovernedCasesFailClosed();
  console.log("  ok  two governed-admitted Cases for one lead fail closed");
  await testBackfillRefusesAdvisorWaWinner();
  console.log("  ok  advisor_wa cannot mint the SL-15 authority path");
  await testSqlContract();
  console.log("  ok  SQL is atomic, service_role-only, and does not parse the id");
  console.log("legacy-lead-contact selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
