/**
 * ADR-111 §2 header grammar. Transcribed from the fenced block, not a table.
 */
export const HEADER_KEY_ID = "x-guos-key-id";
export const HEADER_TIMESTAMP = "x-guos-timestamp";
export const HEADER_SIGNATURE = "x-guos-signature";

export const KEY_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
export const TIMESTAMP_RE = /^(?:0|[1-9][0-9]{0,11})$/;
export const SIGNATURE_RE = /^v1=[0-9a-f]{64}$/;

export interface ParsedAuthHeaders {
  keyId: string;
  timestamp: string;
  signatureHex: string;
}

export function parseAuthHeaders(
  headers: Headers
): ParsedAuthHeaders | null {
  const keyId = headers.get(HEADER_KEY_ID);
  const timestamp = headers.get(HEADER_TIMESTAMP);
  const signature = headers.get(HEADER_SIGNATURE);
  if (
    keyId === null ||
    timestamp === null ||
    signature === null ||
    !KEY_ID_RE.test(keyId) ||
    !TIMESTAMP_RE.test(timestamp) ||
    !SIGNATURE_RE.test(signature)
  ) {
    return null;
  }
  return { keyId, timestamp, signatureHex: signature.slice("v1=".length) };
}
