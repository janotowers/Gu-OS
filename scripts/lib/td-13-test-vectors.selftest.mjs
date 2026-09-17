// Proves the TD-13 LegacyServiceAuth v1 interoperability fixture is internally
// consistent and that its signing string actually binds every field it claims to.
//
// This is deliberately NOT a request verifier. ADR-111 is proposed, not ratified,
// so no HTTP surface exists yet. What this guards is the artifact both repositories
// implement against: if the fixture ever drifts from the rule ADR-111 states, the
// other team builds against a signature we cannot produce, and they find out at
// integration time instead of here.

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "..",
  "..",
  "docs",
  "product",
  "roadmap-increments",
  "r1-relationship-operations-v1",
  "td-13-legacy-service-auth-v1.test-vectors.json"
);

let checks = 0;
const failures = [];

function check(label, actual, expected) {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${label}\n    expected: ${expected}\n    actual:   ${actual}`);
  }
}

function checkNot(label, actual, forbidden) {
  checks += 1;
  if (actual === forbidden) {
    failures.push(`${label}\n    must differ from: ${forbidden}`);
  }
}

// The canonical query rule, restated here from ADR-111 rather than imported, so the
// fixture is checked against an independent transcription of the spec.
function canonicalQuery(rawQuery) {
  if (!rawQuery) return "";
  return rawQuery
    .split("&")
    .filter((segment) => segment.length > 0)
    .sort()
    .join("&");
}

function buildSigningString(parts) {
  return [
    "LegacyServiceAuth-v1",
    parts.keyId,
    parts.method.toUpperCase(),
    parts.path,
    canonicalQuery(parts.rawQuery),
    parts.timestamp,
    parts.bodySha256,
  ].join("\n");
}

function sign(secret, signingString) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(signingString, "utf8"))
    .digest("hex");
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

check("spec is LegacyServiceAuth", fixture.spec, "LegacyServiceAuth");
check("spec version is v1", fixture.spec_version, "v1");
check(
  "fixture is not presented as ratified",
  fixture.status,
  "proposed_awaiting_ratification"
);
check(
  "empty-body SHA-256 constant",
  createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
  fixture.empty_body_sha256
);

if (!Array.isArray(fixture.vectors) || fixture.vectors.length < 2) {
  failures.push("fixture must carry at least two vectors (a body case and a query case)");
}

const seenIds = new Set();
let sawEmptyBody = false;
let sawQueryReordering = false;

for (const vector of fixture.vectors ?? []) {
  const id = vector.id;
  checks += 1;
  if (seenIds.has(id)) failures.push(`duplicate vector id ${id}`);
  seenIds.add(id);

  const body = Buffer.from(vector.body_base64 ?? "", "base64");
  const bodySha256 = createHash("sha256").update(body).digest("hex");

  check(`${id}: body byte length`, body.length, vector.body_bytes);
  check(`${id}: body SHA-256`, bodySha256, vector.body_sha256);
  check(`${id}: canonical query`, canonicalQuery(vector.raw_query), vector.canonical_query);

  const signingString = buildSigningString({
    keyId: vector.key_id,
    method: vector.method,
    path: vector.path,
    rawQuery: vector.raw_query,
    timestamp: vector.timestamp,
    bodySha256,
  });

  check(`${id}: signing string`, signingString, vector.signing_string_escaped);
  check(
    `${id}: signing string base64`,
    Buffer.from(signingString, "utf8").toString("base64"),
    vector.signing_string_base64
  );
  check(
    `${id}: signing string byte length`,
    Buffer.byteLength(signingString, "utf8"),
    vector.signing_string_bytes
  );

  const signature = sign(fixture.secret, signingString);
  check(`${id}: signature`, signature, vector.signature_hex);
  check(`${id}: wire header value`, `v1=${signature}`, vector.header_x_guos_signature);
  check(`${id}: timestamp header matches signed timestamp`, vector.header_x_guos_timestamp, vector.timestamp);
  check(`${id}: key-id header matches signed key id`, vector.header_x_guos_key_id, vector.key_id);
  check(
    `${id}: declared UTC rendering matches the epoch seconds`,
    new Date(Number(vector.timestamp) * 1000).toISOString().replace(".000Z", "Z"),
    vector.timestamp_utc
  );

  // Mutation coverage: the signing string must actually bind each field. A vector
  // that still verifies after one of these changes is documenting a weaker protocol
  // than ADR-111 describes.
  const mutations = [
    ["method", { method: "PUT" }],
    ["path", { path: `${vector.path}/x` }],
    ["timestamp", { timestamp: String(Number(vector.timestamp) + 1) }],
    ["key id", { keyId: `${vector.key_id}-other` }],
    ["body", { bodySha256: createHash("sha256").update(Buffer.concat([body, Buffer.from("x")])).digest("hex") }],
  ];
  if (vector.raw_query) {
    mutations.push(["query", { rawQuery: `${vector.raw_query}&extra=1` }]);
  }

  for (const [what, override] of mutations) {
    const mutated = buildSigningString({
      keyId: vector.key_id,
      method: vector.method,
      path: vector.path,
      rawQuery: vector.raw_query,
      timestamp: vector.timestamp,
      bodySha256,
      ...override,
    });
    checkNot(`${id}: signature must change when the ${what} changes`, sign(fixture.secret, mutated), signature);
  }

  // A different secret must not produce the same signature.
  checkNot(
    `${id}: signature must change under a different secret`,
    sign(`${fixture.secret}x`, signingString),
    signature
  );

  if (body.length === 0) sawEmptyBody = true;
  if (vector.raw_query && vector.raw_query !== vector.canonical_query) {
    sawQueryReordering = true;
  }
}

checks += 2;
if (!sawEmptyBody) {
  failures.push("no vector exercises the empty-body hash, so an empty-body bug would not be caught");
}
if (!sawQueryReordering) {
  failures.push(
    "no vector has a received query order differing from canonical order, so a signer that skips sorting would still pass"
  );
}

if (failures.length > 0) {
  console.error(`td-13 test-vector selftest: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`td-13 test-vector selftest: ${checks} checks passed`);
