/**
 * ADR-111 / TD-13 verifier against the ratified interoperability fixture.
 *
 * The fixture selftest (`test:td-13-test-vectors`) proves the file is
 * internally consistent. This proves the runtime verifier accepts those
 * vectors and rejects the §11 cases that have no canonical signature.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LegacyServiceAuthKey,
  LegacyServiceAuthPurpose,
} from "@agents/types";
import { LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY } from "@agents/types";
import { signLegacyServiceAuth } from "./canonicalize";
import {
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
} from "./headers";
import { lookupFromMap } from "./keys";
import { parseRequestTarget } from "./raw-body";
import { assertObservedOwnerInScope, verifyLegacyServiceAuth } from "./verify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = path.join(
  __dirname,
  "../../../../../docs/product/roadmap-increments/r1-relationship-operations-v1/td-13-legacy-service-auth-v1.test-vectors.json"
);

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const OWNER = "PrincipalUid00000000000000000001";

interface FixtureVector {
  id: string;
  purpose: LegacyServiceAuthPurpose;
  key_id: string;
  method: string;
  path: string;
  raw_query: string;
  timestamp: string;
  body_base64: string;
  header_x_guos_key_id: string;
  header_x_guos_timestamp: string;
  header_x_guos_signature: string;
}

interface Fixture {
  secret: string;
  vectors: FixtureVector[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

function keyFor(
  vector: FixtureVector,
  overrides: Partial<LegacyServiceAuthKey> = {}
): LegacyServiceAuthKey {
  return {
    keyId: vector.key_id,
    secret: fixture.secret,
    service: "traditional_gu",
    purpose: vector.purpose,
    organizationId: ORG,
    legacySourceScope: { sourceSystem: "traditional_gu", ownerRefs: [OWNER] },
    notBefore: null,
    notAfter: null,
    revoked: false,
    ...overrides,
  };
}

function headersFor(vector: FixtureVector, extra?: Record<string, string>): Headers {
  return new Headers({
    [HEADER_KEY_ID]: vector.header_x_guos_key_id,
    [HEADER_TIMESTAMP]: vector.header_x_guos_timestamp,
    [HEADER_SIGNATURE]: vector.header_x_guos_signature,
    ...extra,
  });
}

function verifyVector(
  vector: FixtureVector,
  overrides: Partial<Parameters<typeof verifyLegacyServiceAuth>[0]> = {}
) {
  const key = keyFor(vector);
  return verifyLegacyServiceAuth({
    method: vector.method,
    path: vector.path,
    rawQuery: vector.raw_query,
    headers: headersFor(vector),
    rawBody: Buffer.from(vector.body_base64, "base64"),
    nowSeconds: Number(vector.timestamp),
    requiredPurpose: vector.purpose,
    maxBodyBytes: 64 * 1024,
    lookupKey: lookupFromMap(new Map([[key.keyId, key]])),
    ...overrides,
  });
}

function testFixtureVectorsAccepted(): void {
  for (const vector of fixture.vectors) {
    const result = verifyVector(vector);
    assert.equal(result.ok, true, `${vector.id} must be accepted`);
    if (result.ok) {
      assert.equal(result.key.organizationId, ORG);
      assert.equal(result.key.purpose, vector.purpose);
    }
  }
  console.log("  ok  ratified fixture vectors are accepted by the runtime verifier");
}

function testReorderedQueryStillPasses(): void {
  const vector = fixture.vectors.find((item) => item.raw_query.includes("&"));
  assert.ok(vector, "fixture must include a query vector");
  const result = verifyVector(vector);
  assert.equal(result.ok, true);
  console.log("  ok  a reordered query still passes (canonicalized, not echoed)");
}

function testReSerializedBodyFails(): void {
  const vector = fixture.vectors.find((item) => item.body_base64.length > 0);
  assert.ok(vector);
  const original = Buffer.from(vector.body_base64, "base64");
  const reSerialized = Buffer.from(
    JSON.stringify(JSON.parse(original.toString("utf8")), null, 2)
  );
  assert.notEqual(Buffer.compare(original, reSerialized), 0);
  const result = verifyVector(vector, { rawBody: reSerialized });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.equal(result.reason, "authentication_failed");
  }
  console.log("  ok  a parsed-and-re-serialized body is rejected");
}

function testStaleAndFutureTimestamps(): void {
  const vector = fixture.vectors[0];
  const ts = Number(vector.timestamp);
  const stale = verifyVector(vector, { nowSeconds: ts + 301 });
  const future = verifyVector(vector, { nowSeconds: ts - 301 });
  const edge = verifyVector(vector, { nowSeconds: ts + 300 });
  assert.equal(stale.ok, false);
  assert.equal(future.ok, false);
  assert.equal(edge.ok, true);
  console.log("  ok  freshness is ±300s in both directions, inclusive");
}

function testWrongSecretAndUnknownKey(): void {
  const vector = fixture.vectors[0];
  const wrong = verifyVector(vector, {
    lookupKey: lookupFromMap(
      new Map([[vector.key_id, keyFor(vector, { secret: `${fixture.secret}x` })]])
    ),
  });
  const unknown = verifyVector(vector, { lookupKey: () => null });
  assert.equal(wrong.ok, false);
  assert.equal(unknown.ok, false);
  if (!wrong.ok && !unknown.ok) {
    assert.deepEqual(
      { status: wrong.status, reason: wrong.reason },
      { status: unknown.status, reason: unknown.reason }
    );
    assert.equal(wrong.reason, LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY.reason);
  }
  console.log("  ok  unknown key is indistinguishable from a bad signature");
}

function testWrongPurposeAndOrgAndScope(): void {
  const vector = fixture.vectors[0];
  const purpose = verifyVector(vector, { requiredPurpose: "authority-read" });
  const org = verifyVector(vector, { organizationClaim: OTHER_ORG });
  const scope = verifyVector(vector, { legacyOwnerRef: "someone-else" });
  const sameOrg = verifyVector(vector, { organizationClaim: ORG });
  assert.equal(purpose.ok, false);
  if (!purpose.ok) {
    assert.equal(purpose.status, 403);
    assert.equal(purpose.reason, "purpose_mismatch");
  }
  assert.equal(org.ok, false);
  if (!org.ok) {
    assert.equal(org.status, 403);
    assert.equal(org.reason, "organization_mismatch");
  }
  assert.equal(scope.ok, false);
  if (!scope.ok) {
    assert.equal(scope.status, 403);
    assert.equal(scope.reason, "source_scope_mismatch");
  }
  assert.equal(sameOrg.ok, true);

  const omittedOwner = verifyVector(vector);
  assert.equal(omittedOwner.ok, true, "omitting an owner claim is not authorization");

  const emptyScope = verifyVector(vector, {
    lookupKey: lookupFromMap(
      new Map([
        [
          vector.key_id,
          keyFor(vector, {
            legacySourceScope: { sourceSystem: "traditional_gu", ownerRefs: [] },
          }),
        ],
      ])
    ),
  });
  assert.equal(emptyScope.ok, false);
  if (!emptyScope.ok) {
    assert.equal(emptyScope.status, 403);
    assert.equal(emptyScope.reason, "source_scope_mismatch");
  }

  const allowed = assertObservedOwnerInScope({
    key: keyFor(vector),
    observedOwnerRef: OWNER,
    claimedOwnerRef: null,
  });
  assert.equal(allowed.ok, true);

  const disagreeing = assertObservedOwnerInScope({
    key: keyFor(vector),
    observedOwnerRef: "other-owner",
    claimedOwnerRef: OWNER,
  });
  assert.equal(disagreeing.ok, false);

  const outside = assertObservedOwnerInScope({
    key: keyFor(vector),
    observedOwnerRef: "other-owner",
  });
  assert.equal(outside.ok, false);

  console.log("  ok  purpose / Organization / source-scope mismatches are 403");
}

function testRequestTargetDoesNotCollapseDotSegments(): void {
  const raw = parseRequestTarget("http://legacy.test/api/legacy/../legacy/authority?b=1&a=2");
  assert.equal(raw.path, "/api/legacy/../legacy/authority");
  assert.equal(raw.rawQuery, "b=1&a=2");
  assert.equal(
    new URL("http://legacy.test/api/legacy/../legacy/authority").pathname,
    "/api/legacy/authority"
  );
  console.log("  ok  parseRequestTarget preserves dot segments that URL() would collapse");
}

function testRotationAndRevocation(): void {
  const vector = fixture.vectors[0];
  const ts = Number(vector.timestamp);
  const rotating = verifyVector(vector, {
    lookupKey: lookupFromMap(
      new Map([
        [
          vector.key_id,
          keyFor(vector, { notBefore: ts - 10, notAfter: ts + 10 }),
        ],
      ])
    ),
  });
  const revoked = verifyVector(vector, {
    lookupKey: lookupFromMap(
      new Map([[vector.key_id, keyFor(vector, { revoked: true })]])
    ),
  });
  const expired = verifyVector(vector, {
    lookupKey: lookupFromMap(
      new Map([[vector.key_id, keyFor(vector, { notAfter: ts - 1 })]])
    ),
  });
  assert.equal(rotating.ok, true);
  assert.equal(revoked.ok, false);
  assert.equal(expired.ok, false);
  console.log("  ok  an old key inside its window passes; revoked or expired fails");
}

function testMalformedHeadersAndEncoding(): void {
  const vector = fixture.vectors[0];
  const uppercase = verifyVector(vector, {
    headers: headersFor(vector, {
      [HEADER_SIGNATURE]: vector.header_x_guos_signature.toUpperCase(),
    }),
  });
  const missingPrefix = verifyVector(vector, {
    headers: headersFor(vector, {
      [HEADER_SIGNATURE]: vector.header_x_guos_signature.slice(3),
    }),
  });
  const duplicate = new Headers();
  duplicate.append(HEADER_KEY_ID, vector.header_x_guos_key_id);
  duplicate.append(HEADER_KEY_ID, vector.header_x_guos_key_id);
  duplicate.set(HEADER_TIMESTAMP, vector.header_x_guos_timestamp);
  duplicate.set(HEADER_SIGNATURE, vector.header_x_guos_signature);
  const dup = verifyVector(vector, { headers: duplicate });
  const encoded = verifyVector(vector, { contentEncoding: "gzip" });
  const oversize = verifyVector(vector, { maxBodyBytes: 1 });
  assert.equal(uppercase.ok, false);
  assert.equal(missingPrefix.ok, false);
  assert.equal(dup.ok, false);
  assert.equal(encoded.ok, false);
  assert.equal(oversize.ok, false);
  if (!oversize.ok) assert.equal(oversize.status, 413);
  console.log("  ok  malformed headers, Content-Encoding and oversize are rejected");
}

function testServiceAndSourceSystemAreBindings(): void {
  const vector = fixture.vectors[0];
  const accepted = verifyVector(vector, {
    requiredService: "traditional_gu",
    requiredSourceSystem: "traditional_gu",
  });
  const wrongService = verifyVector(vector, {
    requiredService: "traditional_gu",
    lookupKey: lookupFromMap(
      new Map([[vector.key_id, keyFor(vector, { service: "other_service" })]])
    ),
  });
  const wrongSource = verifyVector(vector, {
    requiredSourceSystem: "traditional_gu",
    lookupKey: lookupFromMap(
      new Map([
        [
          vector.key_id,
          keyFor(vector, {
            legacySourceScope: { sourceSystem: "other_source", ownerRefs: [OWNER] },
          }),
        ],
      ])
    ),
  });
  assert.equal(accepted.ok, true);
  assert.equal(wrongService.ok, false);
  if (!wrongService.ok) {
    assert.equal(wrongService.status, 403);
    assert.equal(wrongService.reason, "service_mismatch");
  }
  assert.equal(wrongSource.ok, false);
  if (!wrongSource.ok) {
    assert.equal(wrongSource.status, 403);
    assert.equal(wrongSource.reason, "source_scope_mismatch");
  }
  console.log("  ok  service and sourceSystem are authorization bindings");
}

function testAlteredPathAndBody(): void {
  const vector = fixture.vectors[0];
  const pathChanged = verifyVector(vector, { path: `${vector.path}/x` });
  const body = Buffer.from(vector.body_base64, "base64");
  const tweaked = Buffer.concat([body, Buffer.from("x")]);
  const bodyChanged = verifyVector(vector, { rawBody: tweaked });
  assert.equal(pathChanged.ok, false);
  assert.equal(bodyChanged.ok, false);
  console.log("  ok  an altered path or one-byte body change is rejected");
}

function testSignerAgreesWithFixture(): void {
  const vector = fixture.vectors[0];
  const signed = signLegacyServiceAuth({
    secret: fixture.secret,
    keyId: vector.key_id,
    method: vector.method,
    path: vector.path,
    rawQuery: vector.raw_query,
    timestamp: vector.timestamp,
    rawBody: Buffer.from(vector.body_base64, "base64"),
  });
  assert.equal(signed.ok, true);
  if (signed.ok) {
    assert.equal(`v1=${signed.signatureHex}`, vector.header_x_guos_signature);
  }
  console.log("  ok  the runtime signer reproduces the fixture signature");
}

function main(): void {
  console.log("legacy service auth verifier selftest");
  testFixtureVectorsAccepted();
  testSignerAgreesWithFixture();
  testReorderedQueryStillPasses();
  testReSerializedBodyFails();
  testStaleAndFutureTimestamps();
  testWrongSecretAndUnknownKey();
  testWrongPurposeAndOrgAndScope();
  testServiceAndSourceSystemAreBindings();
  testRotationAndRevocation();
  testMalformedHeadersAndEncoding();
  testAlteredPathAndBody();
  testRequestTargetDoesNotCollapseDotSegments();
  console.log("legacy service auth verifier selftest ok");
}

void main();
