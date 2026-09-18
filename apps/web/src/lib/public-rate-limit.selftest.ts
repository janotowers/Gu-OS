/**
 * Process-local limiter keyspace stays bounded for C2 pre-auth traffic
 * without making key existence observable.
 */
import assert from "node:assert/strict";
import {
  C2_WELL_FORMED_BUCKET_COUNT,
  classifyC2PresentedKeyId,
  rateLimit,
  rateLimitBucketCount,
  resetRateLimit,
} from "./public-rate-limit";

function testClassifyDoesNotDependOnExistence(): void {
  const missing = classifyC2PresentedKeyId({
    presented: null,
    wellFormed: false,
  });
  const malformed = classifyC2PresentedKeyId({
    presented: "!!attacker!!",
    wellFormed: false,
  });
  const unknown = classifyC2PresentedKeyId({
    presented: "unk-aaaa",
    wellFormed: true,
  });
  const known = classifyC2PresentedKeyId({
    presented: "tgu-authority-read-pilot-01",
    wellFormed: true,
  });
  assert.deepEqual(missing, {
    class: "missing",
    bucketKey: "missing",
    auditKeyId: null,
  });
  assert.deepEqual(malformed, {
    class: "malformed",
    bucketKey: "malformed",
    auditKeyId: null,
  });
  assert.equal(unknown.class, "well_formed");
  assert.equal(known.class, "well_formed");
  assert.match(unknown.bucketKey, /^well-formed:\d+$/);
  assert.match(known.bucketKey, /^well-formed:\d+$/);
  assert.equal(unknown.auditKeyId, null);
  assert.equal(known.auditKeyId, null);
  assert.notEqual(known.bucketKey, "tgu-authority-read-pilot-01");
  console.log("  ok  known and unknown well-formed ids share hashed pre-auth buckets");
}

function testUniqueInvalidIdsDoNotGrowMap(): void {
  resetRateLimit();
  const before = rateLimitBucketCount();
  for (let i = 0; i < 1000; i++) {
    const classified = classifyC2PresentedKeyId({
      presented: `unk-${i.toString().padStart(4, "0")}`,
      wellFormed: true,
    });
    rateLimit(classified.bucketKey, 10_000, 60_000);
    rateLimit("malformed", 10_000, 60_000);
  }
  assert.ok(rateLimitBucketCount() - before <= C2_WELL_FORMED_BUCKET_COUNT + 1);
  resetRateLimit();
  console.log("  ok  hashed well-formed buckets stay finite under a flood of ids");
}

function main(): void {
  console.log("public rate-limit selftest");
  testClassifyDoesNotDependOnExistence();
  testUniqueInvalidIdsDoNotGrowMap();
  console.log("public rate-limit selftest ok");
}

void main();
