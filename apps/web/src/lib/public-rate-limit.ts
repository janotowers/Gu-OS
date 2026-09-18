import { createHash } from "node:crypto";

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

/** Fixed cardinality of pre-auth well-formed key-id buckets. */
export const C2_WELL_FORMED_BUCKET_COUNT = 64;

/** Test seam. Production never needs this. */
export function resetRateLimit(): void {
  buckets.clear();
}

/** Test seam. Production never needs this. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

export type C2PresentedKeyClass = "missing" | "malformed" | "well_formed";

function wellFormedBucketKey(presented: string): string {
  const digest = createHash("sha256").update(presented, "utf8").digest();
  return `well-formed:${digest[0]! % C2_WELL_FORMED_BUCKET_COUNT}`;
}

/**
 * Pre-auth C2 classification. Bucket selection must not depend on whether
 * the presented id exists. Known and unknown well-formed ids share the
 * same hashed bucket space so existence cannot be enumerated.
 */
export function classifyC2PresentedKeyId(params: {
  presented: string | null;
  wellFormed: boolean;
}): {
  class: C2PresentedKeyClass;
  bucketKey: string;
  auditKeyId: null;
} {
  if (!params.presented) {
    return { class: "missing", bucketKey: "missing", auditKeyId: null };
  }
  if (!params.wellFormed) {
    return { class: "malformed", bucketKey: "malformed", auditKeyId: null };
  }
  return {
    class: "well_formed",
    bucketKey: wellFormedBucketKey(params.presented),
    auditKeyId: null,
  };
}

export function rateLimit(
  key: string,
  max: number,
  windowMs: number
): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { timestamps: [] };
  const cutoff = now - windowMs;
  b.timestamps = b.timestamps.filter((t) => t > cutoff);
  if (b.timestamps.length === 0) {
    buckets.delete(key);
  }
  if (b.timestamps.length >= max) {
    buckets.set(key, b);
    return { ok: false, retryAfterMs: windowMs - (now - (b.timestamps[0] ?? now)) };
  }
  b.timestamps.push(now);
  buckets.set(key, b);
  return { ok: true };
}
