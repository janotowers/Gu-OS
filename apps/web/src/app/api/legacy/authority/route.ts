/**
 * POST /api/legacy/authority
 *
 * C2 advisory seam (SL-6). Authenticated by LegacyServiceAuth v1.
 * Raw body is hashed as received. Parsing happens only after the HMAC.
 */
import { createServerClient } from "@agents/db";
import { handleLegacyAuthorityRequest } from "@/lib/legacy-authority/handle";
import { lookupLegacyServiceAuthKey } from "@/lib/legacy-service-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleLegacyAuthorityRequest({
    request,
    db: createServerClient(),
    lookupKey: lookupLegacyServiceAuthKey,
  });
}
