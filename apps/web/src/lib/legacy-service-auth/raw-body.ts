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

/** The only path this C2 route serves. Used as the signed path. */
export const LEGACY_AUTHORITY_PATH = "/api/legacy/authority";

/**
 * Path + query from a raw URL string without going through `URL`, which
 * collapses dot segments and re-encodes. ADR-111 §3 forbids that
 * normalization on the signed request-target.
 */
export function parseRequestTarget(url: string): { path: string; rawQuery: string } {
  const withoutHash = url.split("#")[0] ?? url;
  const queryAt = withoutHash.indexOf("?");
  const beforeQuery = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? "" : withoutHash.slice(queryAt + 1);
  const authority = /^[a-zA-Z][a-zA-Z+\-.]*:\/\/[^/?#]*/.exec(beforeQuery);
  const path = authority ? beforeQuery.slice(authority[0].length) || "/" : beforeQuery || "/";
  return { path, rawQuery };
}

/**
 * C2 is a fixed route. Next.js 16 / undici `Request.url` already collapses
 * `/a/../b` (and `%2e%2e`) before a route handler can observe the raw
 * request-target — an ADR-111 §3 contradiction recorded on the ADR, not
 * papered over. This function therefore:
 *   * never feeds `new URL(...).pathname` into the verifier as if it were raw;
 *   * signs/verifies the declared route path;
 *   * preserves the query string from the raw URL text when present.
 */
export function requestTarget(request: Request): { path: string; rawQuery: string } {
  const parsed = parseRequestTarget(request.url);
  return {
    path: LEGACY_AUTHORITY_PATH,
    rawQuery: parsed.rawQuery,
  };
}
