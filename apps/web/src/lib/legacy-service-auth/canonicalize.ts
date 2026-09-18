/**
 * LegacyServiceAuth v1 canonicalization (ADR-111 §3–§5).
 *
 * Independent of the fixture selftest. That script re-derives the same rules
 * so the artifact cannot drift; this module is the runtime transcription.
 */
import { createHash, createHmac } from "node:crypto";

export const PROTOCOL_TAG = "LegacyServiceAuth-v1";

const PRINTABLE_ASCII = /^[\x21-\x7E]*$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hmacSha256Hex(secret: string, signingString: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(signingString, "utf8"))
    .digest("hex");
}

export function canonicalQuery(
  rawQuery: string
): { ok: true; value: string } | { ok: false } {
  if (!rawQuery) return { ok: true, value: "" };
  const segments = rawQuery.split("&").filter((segment) => segment.length > 0);
  if (segments.some((segment) => !PRINTABLE_ASCII.test(segment))) {
    return { ok: false };
  }
  return { ok: true, value: segments.slice().sort().join("&") };
}

export function requestPath(pathname: string): string {
  return pathname.length > 0 ? pathname : "/";
}

export function buildSigningString(parts: {
  keyId: string;
  method: string;
  path: string;
  rawQuery: string;
  timestamp: string;
  bodySha256: string;
}): { ok: true; value: string } | { ok: false } {
  const query = canonicalQuery(parts.rawQuery);
  if (!query.ok) return { ok: false };
  return {
    ok: true,
    value: [
      PROTOCOL_TAG,
      parts.keyId,
      parts.method.toUpperCase(),
      requestPath(parts.path),
      query.value,
      parts.timestamp,
      parts.bodySha256,
    ].join("\n"),
  };
}

export function signLegacyServiceAuth(params: {
  secret: string;
  keyId: string;
  method: string;
  path: string;
  rawQuery: string;
  timestamp: string;
  rawBody: Uint8Array;
}): { ok: true; signatureHex: string; signingString: string } | { ok: false } {
  const built = buildSigningString({
    keyId: params.keyId,
    method: params.method,
    path: params.path,
    rawQuery: params.rawQuery,
    timestamp: params.timestamp,
    bodySha256: sha256Hex(params.rawBody),
  });
  if (!built.ok) return { ok: false };
  return {
    ok: true,
    signingString: built.value,
    signatureHex: hmacSha256Hex(params.secret, built.value),
  };
}
