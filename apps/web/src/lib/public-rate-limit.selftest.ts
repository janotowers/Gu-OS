/**
 * Process-local limiter keyspace stays bounded for C2 pre-auth traffic.
 */
import assert from "node:assert/strict";
import {
  classifyC2PresentedKeyId,
  rateLimit,
  rateLimitBucketCount,
  resetRateLimit,
} from "./public-rate-limit";

function testClassifyDoesNotEchoAttackerIds(): void {
  const missing = classifyC2PresentedKeyId({
    presented: null,
    wellFormed: false,
    known: false,
  });
  const malformed = classifyC2PresentedKeyId({
    presented: "!!attacker!!",
    wellFormed: false,
    known: false,
  });
  const unknown = classifyC2PresentedKeyId({
    presented: "unk-aaaa",
    wellFormed: true,
    known: false,
  });
  const known = classifyC2PresentedKeyId({
    presented: "tgu-authority-read-pilot-01",
    wellFormed: true,
    known: true,
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
  assert.deepEqual(unknown, {
    class: "unknown",
    bucketKey: "unknown",
    auditKeyId: null,
  });
  assert.equal(known.bucketKey, "tgu-authority-read-pilot-01");
  assert.equal(known.auditKeyId, "tgu-authority-read-pilot-01");
  console.log("  ok  C2 classification never buckets or audits raw attacker ids");
}

function testUniqueInvalidIdsDoNotGrowMap(): void {
  resetRateLimit();
  const before = rateLimitBucketCount();
  for (let i = 0; i < 1000; i++) {
    rateLimit("malformed", 10_000, 60_000);
    rateLimit("unknown", 10_000, 60_000);
  }
  assert.equal(rateLimitBucketCount() - before, 2);
  resetRateLimit();
  console.log("  ok  class buckets stay finite under a flood of invalid ids");
}

function main(): void {
  console.log("public rate-limit selftest");
  testClassifyDoesNotEchoAttackerIds();
  testUniqueInvalidIdsDoNotGrowMap();
  console.log("public rate-limit selftest ok");
}

void main();
