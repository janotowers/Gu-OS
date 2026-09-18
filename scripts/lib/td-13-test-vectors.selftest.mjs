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

function checkTrue(label, actual) {
  checks += 1;
  if (actual !== true) failures.push(label);
}

// ADR-111 section 2, transcribed from the fenced block that is the normative grammar.
// They live in a fence there rather than a table because a table cell needs `|` escaped
// as `\|`, so an alternation renders as one thing and reads in source as another -- which
// is the defect this block and these checks exist to keep from recurring.
const HEADER_GRAMMAR = {
  keyId: /^[a-z0-9][a-z0-9_-]{2,63}$/,
  timestamp: /^(?:0|[1-9][0-9]{0,11})$/,
  signature: /^v1=[0-9a-f]{64}$/,
};

// One malformed value per rejection ADR-111 names, so the grammar is proven to exclude
// them rather than merely to admit the good case.
const MALFORMED = {
  keyId: ["", "ab", "Tgu-Events", "tgu events", "-leading-dash", "x".repeat(65), " tgu-events-ingest-pilot-01"],
  timestamp: [
    "",
    "0177",
    "1789670400.5",
    "+1789670400",
    "-1789670400",
    " 1789670400",
    "1789670400 ",
    "1789670400, 1789670400",
    "1789670400000000",
    "0x6A8B",
  ],
  signature: [
    "",
    "4877C10F04DDDD6DE8CDAA3BA14898D93FDFC7FFA67D4F740305FD8DD706D895",
    "v1=4877C10F04DDDD6DE8CDAA3BA14898D93FDFC7FFA67D4F740305FD8DD706D895",
    "4877c10f04dddd6de8cdaa3ba14898d93fdfc7ffa67d4f740305fd8dd706d895",
    "v2=4877c10f04dddd6de8cdaa3ba14898d93fdfc7ffa67d4f740305fd8dd706d895",
    "v1=4877c10f",
    "v1=4877c10f04dddd6de8cdaa3ba14898d93fdfc7ffa67d4f740305fd8dd706d895, v1=4877c10f04dddd6de8cdaa3ba14898d93fdfc7ffa67d4f740305fd8dd706d895",
  ],
};

// ADR-111 section 3: ascending unsigned byte value, byte by byte, a proper prefix sorting
// first. Written out so the fixture is checked against the rule rather than against
// whichever ordering the host language happens to implement.
function compareBytewise(a, b) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return Buffer.compare(left, right);
}

// The canonical query rule, restated here from ADR-111 rather than imported, so the
// fixture is checked against an independent transcription of the spec.
//
// ADR-111 permits a language's default string sort once the ASCII precondition holds,
// which is what this uses. `assertSortEquivalence` below proves that permission sound
// for these segments instead of taking it on trust.
function canonicalQuery(rawQuery) {
  if (!rawQuery) return "";
  return rawQuery
    .split("&")
    .filter((segment) => segment.length > 0)
    .sort()
    .join("&");
}

// ADR-111 section 3 rejects any query byte outside 0x21-0x7E before canonicalization,
// because that precondition is the whole reason "byte order" and a UTF-16 code-unit sort
// are the same ordering. Above U+07FF they are not, and the disagreement would stay
// invisible until a non-ASCII query reached production.
function assertQueryAlphabetAndSortEquivalence(id, rawQuery) {
  const segments = (rawQuery ?? "").split("&").filter((segment) => segment.length > 0);

  checkTrue(
    `${id}: every query byte is within the printable-ASCII range ADR-111 requires`,
    segments.every((segment) => /^[\x21-\x7E]*$/.test(segment))
  );

  // The default sort and an explicit bytewise sort must agree on these segments. If they
  // ever disagree, the ASCII precondition has been violated somewhere upstream.
  checkTrue(
    `${id}: the default string sort agrees with explicit bytewise ordering`,
    JSON.stringify([...segments].sort()) ===
      JSON.stringify([...segments].sort(compareBytewise))
  );
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
    assertQueryAlphabetAndSortEquivalence(id, vector.raw_query);

    // Every header the fixture publishes must satisfy the normative grammar. A vector
    // the spec's own regexes would reject is worse than no vector: both sides would
    // implement against a request their verifier refuses.
    checkTrue(
      `${id}: key-id header satisfies the ADR-111 grammar`,
      HEADER_GRAMMAR.keyId.test(vector.header_x_guos_key_id)
    );
    checkTrue(
      `${id}: timestamp header satisfies the ADR-111 grammar`,
      HEADER_GRAMMAR.timestamp.test(vector.header_x_guos_timestamp)
    );
    checkTrue(
      `${id}: signature header satisfies the ADR-111 grammar`,
      HEADER_GRAMMAR.signature.test(vector.header_x_guos_signature)
    );

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

// The fixture publishes the grammar too, because the other team implements from the
// fixture and may never open the ADR. The two transcriptions must not drift.
check(
  "fixture key-id grammar matches ADR-111",
  fixture.header_grammar?.["x-guos-key-id"],
  HEADER_GRAMMAR.keyId.source
);
check(
  "fixture timestamp grammar matches ADR-111",
  fixture.header_grammar?.["x-guos-timestamp"],
  HEADER_GRAMMAR.timestamp.source
);
check(
  "fixture signature grammar matches ADR-111",
  fixture.header_grammar?.["x-guos-signature"],
  HEADER_GRAMMAR.signature.source
);
checkTrue(
  "fixture states the ASCII query-alphabet precondition that makes byte ordering unambiguous",
  typeof fixture.query_alphabet_rule === "string" && fixture.query_alphabet_rule.includes("0x21")
);

// The grammar must exclude, not merely admit. A pattern that accepts every good header
// and also every bad one would pass every check above.
for (const [header, values] of Object.entries(MALFORMED)) {
  for (const value of values) {
    checkTrue(
      `ADR-111 ${header} grammar must reject ${JSON.stringify(value)}`,
      HEADER_GRAMMAR[header].test(value) === false
    );
  }
}

// The specific defect this file is meant to keep from recurring. An earlier draft of
// ADR-111 carried the timestamp pattern inside a Markdown table cell, where `|` must be
// escaped, so the source read `^(0\|[1-9][0-9]{0,11})$` -- an alternation to a human
// reading the rendered table, and a literal backslash-pipe to anyone implementing from
// the raw file. That pattern matches no ordinary epoch at all, including the fixture's.
checkTrue(
  "the escaped-pipe form of the timestamp pattern really does reject an ordinary epoch, which is why the grammar is not in a table",
  /^(0\|[1-9][0-9]{0,11})$/.test("1789670400") === false
);
checkTrue(
  "the corrected timestamp pattern accepts an ordinary epoch",
  HEADER_GRAMMAR.timestamp.test("1789670400")
);

// Bytewise ordering must be a real constraint, not one the default sort satisfies by
// accident for every input. The two orderings agree across the whole BMP and diverge for
// supplementary characters, because UTF-16 encodes those as surrogates in D800-DFFF,
// which sort BELOW the BMP characters in E000-FFFF that UTF-8 encodes with a smaller
// lead byte. Asserting that divergence exists is what makes the ASCII precondition
// load-bearing rather than decorative.
{
  const divergent = ["\u{10000}", "\uFF01"];
  checkTrue(
    "a UTF-16 code-unit sort and a UTF-8 bytewise sort disagree on supplementary characters, so the ASCII precondition is load-bearing",
    JSON.stringify([...divergent].sort()) !==
      JSON.stringify([...divergent].sort(compareBytewise))
  );
  checkTrue(
    "the two orderings nonetheless agree across the BMP, which is why only the supplementary range exposes the bug",
    JSON.stringify(["\uFF01", "\u0800", "\u00E9"].sort()) ===
      JSON.stringify(["\uFF01", "\u0800", "\u00E9"].sort(compareBytewise))
  );
}

if (failures.length > 0) {
  console.error(`td-13 test-vector selftest: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`td-13 test-vector selftest: ${checks} checks passed`);
