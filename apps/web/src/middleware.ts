import { updateSession } from "@/lib/supabase/middleware";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // /api/legacy is service-to-service (ADR-111). Session middleware must
    // not touch those requests: the body is hashed as raw bytes.
    "/((?!_next/static|_next/image|favicon.ico|api/legacy(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
