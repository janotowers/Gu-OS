/**
 * POST /api/legacy/authority — C2 advisory (SL-6 / TD-3 / SA-6.12).
 *
 * Authenticates per ADR-111, resolves Organization from the key, answers
 * who holds the conversation, and persists fail-safe incidents
 * idempotently on `provider_message_id`. Returning C2 data and recording
 * an internal fail-safe about a bound Case are distinct. The answer is
 * advisory: it writes no runtime_authority and suppresses no reply.
 */
import type { DbClient } from "@agents/db";
import { AuthorityResolutionIdentityConflict } from "@agents/db";
import type {
  ConversationThreadKind,
  InteractionAuthorityResolution,
  LegacyAuthorityRequestBody,
  LegacyAuthorityResponseBody,
  LegacyServiceAuthKey,
} from "@agents/types";
import {
  LEGACY_SERVICE_AUTH_C2_SERVICE,
  LEGACY_SERVICE_AUTH_C2_SOURCE_SYSTEM,
  LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY,
} from "@agents/types";
import {
  recordAuthorityResolutionObservation,
  resolveInteractionAuthority,
  type ReadCurrentConversationAuthority,
} from "../relationship-authority";
import {
  AUTHORITY_READ_MAX_BODY_BYTES,
  HEADER_KEY_ID,
  KEY_ID_RE,
  assertObservedOwnerInScope,
  contentEncodingOf,
  readSignedRawBody,
  requestTarget,
  verifyLegacyServiceAuth,
} from "../legacy-service-auth";
import {
  classifyC2PresentedKeyId,
  rateLimit,
} from "../public-rate-limit";

const THREAD_KINDS = new Set<ConversationThreadKind>(["gu", "advisor_wa"]);
const AUTHORITY_READ_RATE_MAX = 120;
const AUTHORITY_READ_RATE_WINDOW_MS = 60_000;

export interface LegacyServiceAuthAuditEntry {
  event: "legacy_service_auth";
  key_id: string | null;
  purpose: "authority-read";
  outcome: "accepted" | "rejected";
  status: number;
  reason: string;
}

export interface HandleLegacyAuthorityDeps {
  request: Request;
  db: DbClient;
  lookupKey: (keyId: string) => LegacyServiceAuthKey | null;
  nowSeconds?: number;
  readCurrent?: ReadCurrentConversationAuthority;
  persist?: typeof recordAuthorityResolutionObservation;
  rateLimit?: (bucketKey: string) => { ok: true } | { ok: false; retryAfterMs: number };
  audit?: (entry: LegacyServiceAuthAuditEntry) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized(): Response {
  return json(401, LEGACY_SERVICE_AUTH_UNAUTHORIZED_BODY);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : undefined;
}

function presentedKeyId(headers: Headers): string | null {
  const raw = headers.get(HEADER_KEY_ID)?.trim();
  return raw ? raw : null;
}

function defaultAudit(entry: LegacyServiceAuthAuditEntry): void {
  console.info(JSON.stringify(entry));
}

function parseAuthorityBody(
  bytes: Uint8Array
):
  | { ok: true; body: LegacyAuthorityRequestBody }
  | { ok: false } {
  if (bytes.byteLength === 0) {
    return { ok: true, body: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false };
  }
  const raw = parsed as Record<string, unknown>;
  const threadKind = optionalString(raw.thread_kind);
  if (threadKind !== undefined && !THREAD_KINDS.has(threadKind as ConversationThreadKind)) {
    return { ok: false };
  }
  if (
    raw.legacy_lead_id !== undefined &&
    raw.legacy_lead_id !== null &&
    typeof raw.legacy_lead_id !== "string"
  ) {
    return { ok: false };
  }
  if (raw.case_id !== undefined && raw.case_id !== null && typeof raw.case_id !== "string") {
    return { ok: false };
  }
  if (
    raw.organization_id !== undefined &&
    raw.organization_id !== null &&
    typeof raw.organization_id !== "string"
  ) {
    return { ok: false };
  }
  if (
    raw.legacy_owner_ref !== undefined &&
    raw.legacy_owner_ref !== null &&
    typeof raw.legacy_owner_ref !== "string"
  ) {
    return { ok: false };
  }
  if (
    raw.provider_message_id !== undefined &&
    raw.provider_message_id !== null &&
    typeof raw.provider_message_id !== "string"
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    body: {
      legacy_lead_id: optionalString(raw.legacy_lead_id),
      case_id: optionalString(raw.case_id),
      thread_kind: threadKind as ConversationThreadKind | undefined,
      organization_id: optionalString(raw.organization_id),
      legacy_owner_ref: optionalString(raw.legacy_owner_ref),
      provider_message_id: optionalString(raw.provider_message_id),
    },
  };
}

function toResponse(
  organizationId: string,
  resolution: InteractionAuthorityResolution
): LegacyAuthorityResponseBody {
  return {
    advisory: true,
    organization_id: organizationId,
    runtime_authority: resolution.runtimeAuthority,
    conversation_authority: resolution.conversationAuthority,
    human_active: resolution.humanActive,
    lead_takeover_active: resolution.leadTakeoverActive,
    last_owner_interaction_at: resolution.lastOwnerInteractionAt,
    number_kill_switch_active: resolution.numberKillSwitchActive,
    gu_number_ref: resolution.guNumberRef,
    advisor_wa_ignored: resolution.advisorWaIgnored,
    answered_from: resolution.answeredFrom,
    fail_safe_reason: resolution.failSafeReason,
  };
}

function isFailSafe(resolution: InteractionAuthorityResolution): boolean {
  return (
    resolution.conversationAuthority === "unknown" ||
    resolution.conversationAuthority === "conflicting"
  );
}

/**
 * Returning C2 data requires an observed owner inside the key scope.
 * Recording an internal fail-safe is allowed only for a Case bound by
 * a server-side active `gu` mapping when owner observation failed.
 * An out-of-scope observed owner, or an unmapped Lead with no owner,
 * never persists — a valid key must not fabricate incidents.
 */
function persistPolicy(
  resolution: InteractionAuthorityResolution,
  scoped: { ok: boolean }
): { mayReturnC2: boolean; mayPersistFailSafe: boolean } {
  const mayReturnC2 = scoped.ok;
  const observed = resolution.observedOwnerRef?.trim() || null;
  const boundCaseId = resolution.caseId?.trim() || null;
  const outOfScopeOwner = Boolean(observed) && !scoped.ok;
  const ownerUnavailable = !observed;
  const mayPersistFailSafe =
    isFailSafe(resolution) &&
    !outOfScopeOwner &&
    (mayReturnC2 || Boolean(boundCaseId && ownerUnavailable));
  return { mayReturnC2, mayPersistFailSafe };
}

export async function handleLegacyAuthorityRequest(
  deps: HandleLegacyAuthorityDeps
): Promise<Response> {
  const audit = deps.audit ?? defaultAudit;
  const presented = presentedKeyId(deps.request.headers);
  const wellFormed = presented !== null && KEY_ID_RE.test(presented);
  const known = wellFormed && deps.lookupKey(presented) !== null;
  const classified = classifyC2PresentedKeyId({
    presented,
    wellFormed,
    known,
  });
  const limit =
    deps.rateLimit ??
    ((bucketKey: string) =>
      rateLimit(
        `legacy-authority:${bucketKey}`,
        AUTHORITY_READ_RATE_MAX,
        AUTHORITY_READ_RATE_WINDOW_MS
      ));
  const limited = limit(classified.bucketKey);
  if (!limited.ok) {
    audit({
      event: "legacy_service_auth",
      key_id: classified.auditKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status: 429,
      reason: "rate_limited",
    });
    return json(429, {
      error: "rate_limited",
      retry_after_ms: limited.retryAfterMs,
    });
  }

  if (deps.request.method !== "POST") {
    audit({
      event: "legacy_service_auth",
      key_id: classified.auditKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status: 405,
      reason: "method_not_allowed",
    });
    return json(405, { error: "method_not_allowed" });
  }

  const raw = await readSignedRawBody(deps.request, AUTHORITY_READ_MAX_BODY_BYTES);
  if (!raw.ok) {
    const status = raw.status === 413 ? 413 : 401;
    audit({
      event: "legacy_service_auth",
      key_id: classified.auditKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status,
      reason: status === 413 ? "payload_too_large" : "authentication_failed",
    });
    return raw.status === 413
      ? json(413, { error: "payload_too_large" })
      : unauthorized();
  }

  const target = requestTarget(deps.request);
  const parsed = parseAuthorityBody(raw.bytes);
  const organizationClaim = parsed.ok ? parsed.body.organization_id ?? null : null;
  const ownerClaim = parsed.ok ? parsed.body.legacy_owner_ref ?? null : null;

  const verified = verifyLegacyServiceAuth({
    method: deps.request.method,
    path: target.path,
    rawQuery: target.rawQuery,
    headers: deps.request.headers,
    rawBody: raw.bytes,
    contentEncoding: contentEncodingOf(deps.request.headers),
    nowSeconds: deps.nowSeconds ?? Math.floor(Date.now() / 1000),
    requiredPurpose: "authority-read",
    requiredService: LEGACY_SERVICE_AUTH_C2_SERVICE,
    requiredSourceSystem: LEGACY_SERVICE_AUTH_C2_SOURCE_SYSTEM,
    maxBodyBytes: AUTHORITY_READ_MAX_BODY_BYTES,
    lookupKey: deps.lookupKey,
    organizationClaim,
    legacyOwnerRef: ownerClaim,
  });

  if (!verified.ok) {
    audit({
      event: "legacy_service_auth",
      key_id: classified.auditKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status: verified.status,
      reason: verified.reason,
    });
    if (verified.status === 401) return unauthorized();
    if (verified.status === 413) return json(413, { error: "payload_too_large" });
    return json(403, { error: "forbidden", reason: verified.reason });
  }

  const verifiedKeyId = verified.key.keyId;
  if (!parsed.ok) {
    audit({
      event: "legacy_service_auth",
      key_id: verifiedKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status: 400,
      reason: "invalid_body",
    });
    return json(400, { error: "invalid_body" });
  }

  const organizationId = verified.key.organizationId;
  const body = parsed.body;
  let resolution: InteractionAuthorityResolution;
  try {
    resolution = await resolveInteractionAuthority({
      ctx: { db: deps.db, organizationId },
      refs: {
        legacyLeadId: body.legacy_lead_id,
        caseId: body.case_id,
        threadKind: body.thread_kind,
      },
      readCurrent: deps.readCurrent,
    });
  } catch {
    audit({
      event: "legacy_service_auth",
      key_id: verifiedKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status: 500,
      reason: "internal_error",
    });
    return json(500, { error: "internal_error" });
  }

  const scoped = assertObservedOwnerInScope({
    key: verified.key,
    observedOwnerRef: resolution.observedOwnerRef,
    claimedOwnerRef: ownerClaim,
  });
  const { mayReturnC2, mayPersistFailSafe } = persistPolicy(resolution, scoped);
  const providerMessageId = body.provider_message_id?.trim() || null;
  const persist = deps.persist ?? recordAuthorityResolutionObservation;

  async function persistObservation(): Promise<Response | null> {
    try {
      await persist({
        db: deps.db,
        resolution,
        caseId: resolution.caseId,
        legacyLeadId:
          resolution.externalConversationRef ?? body.legacy_lead_id ?? null,
        providerMessageId,
      });
      return null;
    } catch (error) {
      if (error instanceof AuthorityResolutionIdentityConflict) {
        audit({
          event: "legacy_service_auth",
          key_id: verifiedKeyId,
          purpose: "authority-read",
          outcome: "rejected",
          status: 409,
          reason: "logical_identity_conflict",
        });
        return json(409, {
          error: "conflict",
          reason: "logical_identity_conflict",
        });
      }
      audit({
        event: "legacy_service_auth",
        key_id: verifiedKeyId,
        purpose: "authority-read",
        outcome: "rejected",
        status: 500,
        reason: "persist_failed",
      });
      return json(500, { error: "internal_error" });
    }
  }

  if (mayPersistFailSafe && !providerMessageId) {
    audit({
      event: "legacy_service_auth",
      key_id: verifiedKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status: 400,
      reason: "provider_message_id_required",
    });
    return json(400, { error: "invalid_body", reason: "provider_message_id_required" });
  }

  if (!mayReturnC2) {
    if (mayPersistFailSafe) {
      const failed = await persistObservation();
      if (failed) return failed;
    }
    const reason = scoped.ok ? "source_scope_mismatch" : scoped.reason;
    audit({
      event: "legacy_service_auth",
      key_id: verifiedKeyId,
      purpose: "authority-read",
      outcome: "rejected",
      status: 403,
      reason,
    });
    return json(403, { error: "forbidden", reason });
  }

  const failed = await persistObservation();
  if (failed) return failed;

  audit({
    event: "legacy_service_auth",
    key_id: verifiedKeyId,
    purpose: "authority-read",
    outcome: "accepted",
    status: 200,
    reason: "ok",
  });
  return json(200, toResponse(organizationId, resolution));
}
