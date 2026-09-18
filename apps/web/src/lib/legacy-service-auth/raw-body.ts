/**
 * Raw-body capture for LegacyServiceAuth (ADR-111 §4).
 *
 * The hash is over the exact received bytes. Next.js App Router has no
 * Express `verify` callback; this helper is that contract: read the body
 * once as bytes, reject Content-Encoding, enforce the purpose cap before
 * hashing, and never parse-then-re-serialize.
 */
export const AUTHORITY_READ_MAX_BODY_BYTES = 16 * 1024;

export type RawBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 401 | 413 };

export function contentEncodingOf(headers: Headers): string | null {
  const value = headers.get("content-encoding");
  return value && value.trim() !== "" ? value : null;
}

export function declaredContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null || raw === "") return null;
  if (!/^(?:0|[1-9][0-9]{0,11})$/.test(raw)) return null;
  return Number(raw);
}

export async function readSignedRawBody(
  request: Request,
  maxBodyBytes: number
): Promise<RawBodyResult> {
  if (contentEncodingOf(request.headers)) {
    return { ok: false, status: 401 };
  }
  const declared = declaredContentLength(request.headers);
  if (declared !== null && declared > maxBodyBytes) {
    return { ok: false, status: 413 };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) {
    return { ok: false, status: 413 };
  }
  return { ok: true, bytes };
}

export function requestTarget(request: Request): { path: string; rawQuery: string } {
  const url = new URL(request.url);
  return {
    path: url.pathname || "/",
    rawQuery: url.search.startsWith("?") ? url.search.slice(1) : "",
  };
}
