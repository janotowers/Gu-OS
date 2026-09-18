/**
 * LegacyServiceAuth v1 verifier (ADR-111 §6–§7).
 *
 * A valid signature does not let a caller self-select an Organization.
 * Purpose, Organization and source-scope checks run only after the HMAC
 * matches, and they are 403s so they can distinguish themselves.
 */
import { timingSafeEqual } from "node:crypto";
import type {
  LegacyServiceAuthKey,
  LegacyServiceAuthPurpose,
} from "@agents/types";
import { LEGACY_SERVICE_AUTH_FRESHNESS_SECONDS } from "@agents/types";
import { buildSigningString, hmacSha256Hex, sha256Hex } from "./canonicalize";
import { parseAuthHeaders } from "./headers";

export type VerifyFailureStatus = 401 | 403 | 413;

export type VerifyResult =
  | { ok: true; key: LegacyServiceAuthKey }
  | {
      ok: false;
      status: VerifyFailureStatus;
      reason:
        | "authentication_failed"
        | "purpose_mismatch"
        | "organization_mismatch"
        | "source_scope_mismatch"
        | "payload_too_large";
    };

export interface VerifyLegacyServiceAuthInput {
  method: string;
  path: string;
  rawQuery: string;
  headers: Headers;
  rawBody: Uint8Array;
  contentEncoding?: string | null;
  nowSeconds: number;
  requiredPurpose: LegacyServiceAuthPurpose;
  maxBodyBytes: number;
  lookupKey: (keyId: string) => LegacyServiceAuthKey | null;
  organizationClaim?: string | null;
  legacyOwnerRef?: string | null;
}

function unauthorized(): VerifyResult {
  return { ok: false, status: 401, reason: "authentication_failed" };
}

function signaturesMatch(expectedHex: string, presentedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const presented = Buffer.from(presentedHex, "hex");
  if (expected.length !== 32 || presented.length !== 32) return false;
  return timingSafeEqual(expected, presented);
}

function keyIsValid(key: LegacyServiceAuthKey, nowSeconds: number): boolean {
  if (key.revoked) return false;
  if (key.notBefore !== null && nowSeconds < key.notBefore) return false;
  if (key.notAfter !== null && nowSeconds > key.notAfter) return false;
  return true;
}

export function verifyLegacyServiceAuth(
  input: VerifyLegacyServiceAuthInput
): VerifyResult {
  if (input.contentEncoding && input.contentEncoding.trim() !== "") {
    return unauthorized();
  }
  if (input.rawBody.byteLength > input.maxBodyBytes) {
    return { ok: false, status: 413, reason: "payload_too_large" };
  }

  const headers = parseAuthHeaders(input.headers);
  if (!headers) return unauthorized();

  const timestamp = Number(headers.timestamp);
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(input.nowSeconds - timestamp) > LEGACY_SERVICE_AUTH_FRESHNESS_SECONDS
  ) {
    return unauthorized();
  }

  const key = input.lookupKey(headers.keyId);
  if (!key || !keyIsValid(key, input.nowSeconds)) {
    return unauthorized();
  }

  const signing = buildSigningString({
    keyId: headers.keyId,
    method: input.method,
    path: input.path,
    rawQuery: input.rawQuery,
    timestamp: headers.timestamp,
    bodySha256: sha256Hex(input.rawBody),
  });
  if (!signing.ok) return unauthorized();

  const expected = hmacSha256Hex(key.secret, signing.value);
  if (!signaturesMatch(expected, headers.signatureHex)) {
    return unauthorized();
  }

  if (key.purpose !== input.requiredPurpose) {
    return { ok: false, status: 403, reason: "purpose_mismatch" };
  }

  const organizationClaim = input.organizationClaim?.trim() || null;
  if (organizationClaim && organizationClaim !== key.organizationId) {
    return { ok: false, status: 403, reason: "organization_mismatch" };
  }

  const ownerRef = input.legacyOwnerRef?.trim() || null;
  if (ownerRef && !key.legacySourceScope.ownerRefs.includes(ownerRef)) {
    return { ok: false, status: 403, reason: "source_scope_mismatch" };
  }

  return { ok: true, key };
}
