/**
 * SA-6.12: POST /api/legacy/authority against the ratified ADR-111 fixture.
 *
 * The Organization comes from the key. A bad signature, a stale timestamp,
 * a re-serialized body and a mismatched key binding are refused. The answer
 * is advisory: it writes no runtime_authority.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "@agents/db";
import type {
  LegacyConversationAuthority,
  LegacyReadResult,
  LegacyServiceAuthKey,
} from "@agents/types";
import { LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY } from "@agents/types";
import {
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  signLegacyServiceAuth,
} from "../legacy-service-auth";
import { handleLegacyAuthorityRequest, type LegacyServiceAuthAuditEntry } from "./handle";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = path.join(
  __dirname,
  "../../../../../docs/product/roadmap-increments/r1-relationship-operations-v1/td-13-legacy-service-auth-v1.test-vectors.json"
);

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const LEAD = "5215500000001521550000000252155000000003";
const CASE_ID = "cccccccccccccccc-cccc-cccc-cccc-cccccccccccc";
const TS = "1789670400";

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { secret: string };

const authorityKey: LegacyServiceAuthKey = {
  keyId: "tgu-authority-read-pilot-01",
  secret: fixture.secret,
  service: "traditional_gu",
  purpose: "authority-read",
  organizationId: ORG,
  legacySourceScope: {
    sourceSystem: "traditional_gu",
    ownerRefs: ["PrincipalUid00000000000000000001"],
  },
  notBefore: null,
  notAfter: null,
  revoked: false,
};

const eventsKey: LegacyServiceAuthKey = {
  ...authorityKey,
  keyId: "tgu-events-ingest-pilot-01",
  purpose: "events-ingest",
};

const otherOrgKey: LegacyServiceAuthKey = {
  ...authorityKey,
  keyId: "tgu-authority-read-other-org",
  organizationId: OTHER_ORG,
};

const KEYS = new Map<string, LegacyServiceAuthKey>([
  [authorityKey.keyId, authorityKey],
  [eventsKey.keyId, eventsKey],
  [otherOrgKey.keyId, otherOrgKey],
]);

type Row = Record<string, unknown>;

function fakeDb(): {
  db: DbClient;
  writes: Array<{ table: string; values: Row }>;
} {
  const writes: Array<{ table: string; values: Row }> = [];
  function builder(table: string) {
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      in: () => self,
      is: () => self,
      order: () => self,
      insert: (values: Row) => {
        writes.push({ table, values });
        return self;
      },
      update: (values: Row) => {
        writes.push({ table, values });
        return self;
      },
      single: async () => ({
        data: {
          id: "resolution-1",
          created_at: "2026-09-18T02:20:00.000Z",
          ...writes.at(-1)?.values,
        },
        error: null,
      }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: [], error: null }),
    };
    return self;
  }
  return {
    writes,
    db: { from: (table: string) => builder(table) } as unknown as DbClient,
  };
}

function current(
  takeover: boolean | null,
  observedOwnerRef: string | null = "PrincipalUid00000000000000000001"
): LegacyReadResult<LegacyConversationAuthority> & { observedOwnerRef: string | null } {
  return {
    value: {
      legacyLeadId: LEAD,
      leadTakeoverActive: takeover,
      lastOwnerInteractionAt: "2026-09-17T18:00:00.000Z",
      numberKillSwitchActive: false,
      guNumberRef: "5215500000003",
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
        readAt: "2026-09-18T02:20:00.000Z",
        sourceUpdatedAt: "2026-09-17T18:00:00.000Z",
        ageSeconds: 30000,
        sourceUpdatedAtField: "last_owner_interaction_wba",
      },
    },
    observedOwnerRef,
  };
}

async function signedRequest(params: {
  key?: LegacyServiceAuthKey;
  body: string;
  timestamp?: string;
  path?: string;
  extraHeaders?: Record<string, string>;
  signatureHex?: string;
}): Promise<Request> {
  const key = params.key ?? authorityKey;
  const timestamp = params.timestamp ?? TS;
  const pathName = params.path ?? "/api/legacy/authority";
  const rawBody = Buffer.from(params.body, "utf8");
  const signed = signLegacyServiceAuth({
    secret: key.secret,
    keyId: key.keyId,
    method: "POST",
    path: pathName,
    rawQuery: "",
    timestamp,
    rawBody,
  });
  assert.equal(signed.ok, true);
  const signatureHex = params.signatureHex ?? (signed.ok ? signed.signatureHex : "");
  return new Request(`http://legacy.test${pathName}`, {
    method: "POST",
    headers: {
      [HEADER_KEY_ID]: key.keyId,
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_SIGNATURE]: `v1=${signatureHex}`,
      "content-type": "application/json",
      ...params.extraHeaders,
    },
    body: rawBody,
  });
}

async function call(
  request: Request,
  extras: {
    writes?: Array<{ table: string; values: Row }>;
    takeover?: boolean | null;
    nowSeconds?: number;
    readCurrent?: Parameters<typeof handleLegacyAuthorityRequest>[0]["readCurrent"];
    persist?: Parameters<typeof handleLegacyAuthorityRequest>[0]["persist"];
    rateLimit?: Parameters<typeof handleLegacyAuthorityRequest>[0]["rateLimit"];
    audit?: Parameters<typeof handleLegacyAuthorityRequest>[0]["audit"];
    observedOwnerRef?: string | null;
  } = {}
): Promise<{ status: number; body: Record<string, unknown>; writes: Array<{ table: string; values: Row }> }> {
  const { db, writes } = fakeDb();
  const response = await handleLegacyAuthorityRequest({
    request,
    db,
    lookupKey: (id) => KEYS.get(id) ?? null,
    nowSeconds: extras.nowSeconds ?? Number(TS),
    readCurrent: extras.readCurrent
      ?? (async () =>
        current(
          extras.takeover === undefined ? false : extras.takeover,
          extras.observedOwnerRef === undefined
            ? "PrincipalUid00000000000000000001"
            : extras.observedOwnerRef
        )),
    persist: extras.persist,
    rateLimit: extras.rateLimit ?? (() => ({ ok: true as const })),
    audit: extras.audit ?? (() => undefined),
  });
  extras.writes?.push(...writes);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    writes,
  };
}

async function testValidSignatureAccepted(): Promise<void> {
  const compact = JSON.stringify({ legacy_lead_id: LEAD });
  const result = await call(await signedRequest({ body: compact }));
  assert.equal(result.status, 200);
  assert.equal(result.body.advisory, true);
  assert.equal(result.body.organization_id, ORG);
  assert.equal(result.body.conversation_authority, "gu");
  assert.equal(result.body.human_active, false);
  assert.equal(result.writes.some((write) => write.table === "operational_cases"), false);
  console.log("  ok  SA-6.12 a valid authority-read signature is accepted");
}

async function testOrgComesFromKeyNotPayload(): Promise<void> {
  const withClaim = JSON.stringify({
    legacy_lead_id: LEAD,
    organization_id: ORG,
  });
  const omitted = JSON.stringify({ legacy_lead_id: LEAD });
  const claimed = await call(await signedRequest({ body: withClaim }));
  const bare = await call(await signedRequest({ body: omitted }));
  assert.equal(claimed.body.organization_id, ORG);
  assert.equal(bare.body.organization_id, ORG);
  console.log("  ok  SA-6.12 Organization is resolved from the key, never a payload claim");
}

async function testBadSignatureRejected(): Promise<void> {
  const result = await call(
    await signedRequest({
      body: JSON.stringify({ legacy_lead_id: LEAD }),
      signatureHex: "aa".repeat(32),
    })
  );
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY);
  console.log("  ok  SA-6.12 a bad signature is 401");
}

async function testStaleTimestampRejected(): Promise<void> {
  const result = await call(
    await signedRequest({ body: JSON.stringify({ legacy_lead_id: LEAD }) }),
    { nowSeconds: Number(TS) + 301 }
  );
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY);
  console.log("  ok  SA-6.12 a stale timestamp is 401");
}

async function testReSerializedBodyRejected(): Promise<void> {
  const compact = JSON.stringify({ legacy_lead_id: LEAD, case_id: CASE_ID });
  const pretty = JSON.stringify({ legacy_lead_id: LEAD, case_id: CASE_ID }, null, 2);
  assert.notEqual(compact, pretty);
  const signed = signLegacyServiceAuth({
    secret: authorityKey.secret,
    keyId: authorityKey.keyId,
    method: "POST",
    path: "/api/legacy/authority",
    rawQuery: "",
    timestamp: TS,
    rawBody: Buffer.from(compact, "utf8"),
  });
  assert.equal(signed.ok, true);
  const request = new Request("http://legacy.test/api/legacy/authority", {
    method: "POST",
    headers: {
      [HEADER_KEY_ID]: authorityKey.keyId,
      [HEADER_TIMESTAMP]: TS,
      [HEADER_SIGNATURE]: signed.ok ? `v1=${signed.signatureHex}` : "",
      "content-type": "application/json",
    },
    body: pretty,
  });
  const result = await call(request);
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY);
  console.log("  ok  SA-6.12 a re-serialized body is 401");
}

async function testMismatchedKeyBindingRejected(): Promise<void> {
  const mismatchedOrg = await call(
    await signedRequest({
      body: JSON.stringify({ legacy_lead_id: LEAD, organization_id: OTHER_ORG }),
    })
  );
  const eventsPurpose = await call(
    await signedRequest({
      key: eventsKey,
      body: JSON.stringify({ legacy_lead_id: LEAD }),
    })
  );
  const otherOrg = await call(
    await signedRequest({
      key: otherOrgKey,
      body: JSON.stringify({ legacy_lead_id: LEAD }),
    })
  );
  assert.equal(mismatchedOrg.status, 403);
  assert.equal(mismatchedOrg.body.reason, "organization_mismatch");
  assert.equal(eventsPurpose.status, 403);
  assert.equal(eventsPurpose.body.reason, "purpose_mismatch");
  assert.equal(otherOrg.status, 200);
  assert.equal(otherOrg.body.organization_id, OTHER_ORG);
  console.log("  ok  SA-6.12 mismatched purpose or Organization binding is 403");
}

async function testFailSafePersistsAndDoesNotWriteRuntime(): Promise<void> {
  const result = await call(
    await signedRequest({
      body: JSON.stringify({
        legacy_lead_id: LEAD,
        case_id: CASE_ID,
        provider_message_id: "wamid-fail-safe-1",
      }),
    }),
    { takeover: null }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.conversation_authority, "unknown");
  assert.equal(result.body.advisory, true);
  assert.equal(
    result.writes.some((write) => write.table === "authority_resolutions"),
    true
  );
  assert.equal(
    result.writes.find((write) => write.table === "authority_resolutions")
      ?.values.provider_message_id,
    "wamid-fail-safe-1"
  );
  assert.equal(
    result.writes.some((write) => write.table === "operational_cases"),
    false
  );
  console.log("  ok  fail-safe persists; runtime_authority is not written");
}

async function testSourceScopeFailClosed(): Promise<void> {
  const emptyScopeKey: LegacyServiceAuthKey = {
    ...authorityKey,
    keyId: "tgu-authority-read-empty-scope",
    legacySourceScope: { sourceSystem: "traditional_gu", ownerRefs: [] },
  };
  KEYS.set(emptyScopeKey.keyId, emptyScopeKey);

  const omitted = await call(
    await signedRequest({ body: JSON.stringify({ legacy_lead_id: LEAD }) })
  );
  assert.equal(omitted.status, 200);

  const emptyScope = await call(
    await signedRequest({
      key: emptyScopeKey,
      body: JSON.stringify({ legacy_lead_id: LEAD }),
    })
  );
  assert.equal(emptyScope.status, 403);
  assert.equal(emptyScope.body.reason, "source_scope_mismatch");

  const allowedClaim = await call(
    await signedRequest({
      body: JSON.stringify({
        legacy_lead_id: LEAD,
        legacy_owner_ref: "PrincipalUid00000000000000000001",
      }),
    })
  );
  assert.equal(allowedClaim.status, 200);

  const disagreeingClaim = await call(
    await signedRequest({
      body: JSON.stringify({
        legacy_lead_id: LEAD,
        legacy_owner_ref: "PrincipalUid00000000000000000001",
      }),
    }),
    { observedOwnerRef: "someone-else-owner" }
  );
  assert.equal(disagreeingClaim.status, 403);
  assert.equal(disagreeingClaim.body.reason, "source_scope_mismatch");

  const observedOutside = await call(
    await signedRequest({ body: JSON.stringify({ legacy_lead_id: LEAD }) }),
    { observedOwnerRef: "out-of-scope-owner" }
  );
  assert.equal(observedOutside.status, 403);
  assert.equal(observedOutside.body.reason, "source_scope_mismatch");

  console.log("  ok  source scope is fail-closed on omitted, empty, disagreeing, and out-of-scope owners");
}

async function testNoncanonicalPathDoesNotAcceptAlternateSignature(): Promise<void> {
  const noncanonical = "/api/legacy/../legacy/authority";
  const result = await call(
    await signedRequest({
      body: JSON.stringify({ legacy_lead_id: LEAD }),
      path: noncanonical,
    })
  );
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY);
  console.log("  ok  a signature over a noncanonical path is not accepted");
}

async function testFailSafeRequiresProviderMessageId(): Promise<void> {
  const result = await call(
    await signedRequest({
      body: JSON.stringify({ legacy_lead_id: LEAD, case_id: CASE_ID }),
    }),
    { takeover: null }
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.reason, "provider_message_id_required");
  assert.equal(
    result.writes.some((write) => write.table === "authority_resolutions"),
    false
  );
  console.log("  ok  a fail-safe persist without provider_message_id is refused");
}

async function testC2MapsLeadToCaseWithoutSuppliedCaseId(): Promise<void> {
  const writes: Array<{ table: string; values: Row }> = [];
  function builder(table: string) {
    let rows: Row[] =
      table === "external_conversation_bindings"
        ? [
            {
              id: "bind-gu",
              organization_id: ORG,
              case_id: CASE_ID,
              thread_kind: "gu",
              status: "active",
              provider: "whatsapp_business",
              external_conversation_ref: LEAD,
            },
          ]
        : table === "operational_cases"
          ? [{ id: CASE_ID, organization_id: ORG, runtime_authority: "legacy" }]
          : [];
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return self;
      },
      in: () => self,
      order: () => self,
      insert: (values: Row) => {
        writes.push({ table, values });
        return self;
      },
      update: (values: Row) => {
        writes.push({ table, values });
        return self;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({
        data: {
          id: "resolution-mapped",
          created_at: "2026-09-18T02:20:00.000Z",
          ...(writes.at(-1)?.values ?? {}),
        },
        error: null,
      }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }
  const request = await signedRequest({
    body: JSON.stringify({
      legacy_lead_id: LEAD,
      provider_message_id: "wamid-mapped-case",
    }),
  });
  const response = await handleLegacyAuthorityRequest({
    request,
    db: { from: (table: string) => builder(table) } as unknown as DbClient,
    lookupKey: (id) => KEYS.get(id) ?? null,
    nowSeconds: Number(TS),
    readCurrent: async () => current(null),
    rateLimit: () => ({ ok: true as const }),
    audit: () => undefined,
  });
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(body.conversation_authority, "unknown");
  const persisted = writes.find((write) => write.table === "authority_resolutions");
  assert.equal(persisted?.values.case_id, CASE_ID);
  assert.equal(persisted?.values.provider_message_id, "wamid-mapped-case");
  console.log("  ok  C2 maps lead → Case server-side without a supplied case id");
}

async function testAuditAttributesKeyAndPurpose(): Promise<void> {
  const entries: LegacyServiceAuthAuditEntry[] = [];
  await call(await signedRequest({ body: JSON.stringify({ legacy_lead_id: LEAD }) }), {
    audit: (entry) => entries.push(entry),
  });
  assert.equal(entries[0]?.event, "legacy_service_auth");
  assert.equal(entries[0]?.key_id, authorityKey.keyId);
  assert.equal(entries[0]?.purpose, "authority-read");
  assert.equal(entries[0]?.outcome, "accepted");
  console.log("  ok  audit attributes key id and purpose per request");
}

async function testRateLimitAppliesToRejectedRequests(): Promise<void> {
  const entries: Array<{ status: number; reason: string }> = [];
  let calls = 0;
  const result = await call(
    await signedRequest({
      body: JSON.stringify({ legacy_lead_id: LEAD }),
      signatureHex: "aa".repeat(32),
    }),
    {
      rateLimit: () => {
        calls += 1;
        return { ok: false as const, retryAfterMs: 1000 };
      },
      audit: (entry) => entries.push({ status: entry.status, reason: entry.reason }),
    }
  );
  assert.equal(result.status, 429);
  assert.equal(calls, 1);
  assert.equal(entries[0]?.reason, "rate_limited");
  console.log("  ok  rate limiting applies before acceptance, including rejected signatures");
}

function testRouteUsesRawBody(): void {
  const route = readFileSync(
    path.join(__dirname, "../../app/api/legacy/authority/route.ts"),
    "utf8"
  );
  const handle = readFileSync(path.join(__dirname, "handle.ts"), "utf8");
  const middleware = readFileSync(
    path.join(__dirname, "../../middleware.ts"),
    "utf8"
  );
  assert.equal(/request\.json\(/.test(route), false);
  assert.equal(/handleLegacyAuthorityRequest/.test(route), true);
  assert.equal(/createServerClient/.test(route), true);
  assert.equal(/five[\s-]?minute/i.test(handle), false);
  assert.equal(middleware.includes("api/legacy"), true);
  console.log("  ok  the route hashes raw bytes; session middleware skips /api/legacy");
}

async function main(): Promise<void> {
  console.log("legacy authority route selftest");
  await testValidSignatureAccepted();
  await testOrgComesFromKeyNotPayload();
  await testBadSignatureRejected();
  await testStaleTimestampRejected();
  await testReSerializedBodyRejected();
  await testMismatchedKeyBindingRejected();
  await testFailSafePersistsAndDoesNotWriteRuntime();
  await testFailSafeRequiresProviderMessageId();
  await testC2MapsLeadToCaseWithoutSuppliedCaseId();
  await testAuditAttributesKeyAndPurpose();
  await testSourceScopeFailClosed();
  await testNoncanonicalPathDoesNotAcceptAlternateSignature();
  await testRateLimitAppliesToRejectedRequests();
  testRouteUsesRawBody();
  console.log("legacy authority route selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
