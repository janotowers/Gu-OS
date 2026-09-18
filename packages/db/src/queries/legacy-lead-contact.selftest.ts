/**
 * Deterministic selftests for the SL-15 Contact / opaque `legacy_lead` seam.
 *
 * Covers the TypeScript wrapper, the SQL source contract, and the historical
 * backfill helper. PostgreSQL atomicity, unique-violation converge and RLS
 * live in `test-rls/run.ts`.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "../client";
import {
  backfillAdmittedLegacyLeadIdentity,
  LegacyLeadContactError,
  requireOpaqueLegacyLeadId,
  resolveOrCreateContactForLegacyLead,
  RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC,
} from "./legacy-lead-contact";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const LEAD = "5215500000001521550000000252155000000003";
const OTHER_LEAD = "5215500000077521550000000252155000000099";
const CASE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

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
        ...(args.p_provenance as Record<string, unknown>),
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

async function testWrapperTrimsAndDoesNotParse(): Promise<void> {
  const tables: Record<string, Row[]> = { contacts: [], external_identity_bindings: [] };
  const { db, rpcCalls } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  const id = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: `  ${ORG}  `,
    legacyLeadId: `  ${LEAD}  `,
    provenance: { basis: "admission" },
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
    provenance: { basis: "admission" },
  });
  const again = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: ORG,
    legacyLeadId: LEAD,
    provenance: { basis: "retry" },
  });
  assert.equal(again, first, "SA-15.2: reuse the existing Contact");
  assert.equal(tables.contacts.length, 1);
  assert.equal(
    (tables.external_identity_bindings[0].provenance_jsonb as { basis?: string })
      .basis,
    "admission",
    "SA-15.5: reuse does not rewrite provenance"
  );

  const other = await resolveOrCreateContactForLegacyLead(db, {
    organizationId: ORG,
    legacyLeadId: OTHER_LEAD,
  });
  assert.notEqual(other, first, "SA-15.4: a different lead is a different Contact");
  assert.equal(tables.contacts.length, 2);
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
        }),
      (error: unknown) =>
        error instanceof LegacyLeadContactError &&
        error.code === "incompatible_binding"
    );
    assert.equal(tables.contacts.length, 0);
  }
}

async function testBackfill(): Promise<void> {
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
  };
  const { db } = fakeDb(tables, {
    [RESOLVE_OR_CREATE_CONTACT_FOR_LEGACY_LEAD_RPC]: memoryPrimitive(tables),
  });

  const result = await backfillAdmittedLegacyLeadIdentity(db, {
    organizationId: ORG,
    caseId: CASE_ID,
    externalConversationRef: "wamid.HBg-hosted-pilot",
  });
  assert.equal(result.contactId, "contact-1");
  assert.equal(result.conversationBinding.contact_id, "contact-1");
  assert.equal(
    result.conversationBinding.external_conversation_ref,
    "wamid.HBg-hosted-pilot"
  );
  assert.equal(tables.contacts.length, 1);

  tables.operational_cases.push({
    id: "second-case",
    organization_id: ORG,
    case_type: "lead_opportunity",
    context_jsonb: { legacy_lead_id: LEAD },
  });
  await assert.rejects(
    () =>
      backfillAdmittedLegacyLeadIdentity(db, {
        organizationId: ORG,
        caseId: CASE_ID,
        externalConversationRef: "wamid.HBg-hosted-pilot",
      }),
    (error: unknown) =>
      error instanceof LegacyLeadContactError &&
      error.code === "ambiguous_case_mapping"
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
}

async function main(): Promise<void> {
  console.log("legacy-lead-contact selftest");
  await testWrapperTrimsAndDoesNotParse();
  console.log("  ok  wrapper trims the opaque id and never parses it");
  await testReuseAndTwoLeads();
  console.log("  ok  reuse one Contact; two leads stay two Contacts");
  await testFailClosed();
  console.log("  ok  incompatible and cross-Organization bindings fail closed");
  await testBackfill();
  console.log("  ok  backfill uses the same primitive and fails closed on two Cases");
  await testSqlContract();
  console.log("  ok  SQL is atomic, service_role-only, and does not parse the id");
  console.log("legacy-lead-contact selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
