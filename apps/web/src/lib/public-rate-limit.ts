type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

/** Test seam. Production never needs this. */
export function resetRateLimit(): void {
  buckets.clear();
}

/** Test seam. Production never needs this. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

export type C2PresentedKeyClass = "missing" | "malformed" | "unknown" | "known";

/**
 * Pre-auth C2 rate-limit classification. Attacker-controlled identifiers
 * never become Map keys or audit values. Known keys are provisioned and
 * therefore finite.
 */
export function classifyC2PresentedKeyId(params: {
  presented: string | null;
  wellFormed: boolean;
  known: boolean;
}): {
  class: C2PresentedKeyClass;
  bucketKey: string;
  auditKeyId: string | null;
} {
  if (!params.presented) {
    return { class: "missing", bucketKey: "missing", auditKeyId: null };
  }
  if (!params.wellFormed) {
    return { class: "malformed", bucketKey: "malformed", auditKeyId: null };
  }
  if (!params.known) {
    return { class: "unknown", bucketKey: "unknown", auditKeyId: null };
  }
  return {
    class: "known",
    bucketKey: params.presented,
    auditKeyId: params.presented,
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
