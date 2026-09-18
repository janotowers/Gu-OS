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
import { handleLegacyAuthorityRequest } from "./handle";

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
  takeover: boolean | null
): LegacyReadResult<LegacyConversationAuthority> {
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
  } = {}
): Promise<{ status: number; body: Record<string, unknown>; writes: Array<{ table: string; values: Row }> }> {
  const { db, writes } = fakeDb();
  const response = await handleLegacyAuthorityRequest({
    request,
    db,
    lookupKey: (id) => KEYS.get(id) ?? null,
    nowSeconds: extras.nowSeconds ?? Number(TS),
    readCurrent: async () =>
      current(extras.takeover === undefined ? false : extras.takeover),
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
      body: JSON.stringify({ legacy_lead_id: LEAD, case_id: CASE_ID }),
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
    result.writes.some((write) => write.table === "operational_cases"),
    false
  );
  console.log("  ok  fail-safe persists; runtime_authority is not written");
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
  testRouteUsesRawBody();
  console.log("legacy authority route selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
