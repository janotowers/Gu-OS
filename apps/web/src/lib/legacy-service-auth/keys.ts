/**
 * Key registry for LegacyServiceAuth v1 (ADR-111 §6).
 *
 * Lookup is by the named key id only — never a trial of other secrets.
 * Q16 has not assigned a provisioning owner, so no real key is shipped.
 * Production loads from LEGACY_SERVICE_AUTH_KEYS_JSON or is empty (fail closed).
 * Tests bind the ratified fixture secret themselves.
 */
import type {
  LegacyServiceAuthKey,
  LegacyServiceAuthPurpose,
} from "@agents/types";
import { LEGACY_SERVICE_AUTH_PURPOSES } from "@agents/types";

function isPurpose(value: unknown): value is LegacyServiceAuthPurpose {
  return (
    typeof value === "string" &&
    (LEGACY_SERVICE_AUTH_PURPOSES as readonly string[]).includes(value)
  );
}

function asIntegerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("legacy service auth key: notBefore/notAfter must be integer or null");
  }
  return value;
}

export function parseLegacyServiceAuthKey(value: unknown): LegacyServiceAuthKey {
  if (!value || typeof value !== "object") {
    throw new Error("legacy service auth key: expected an object");
  }
  const row = value as Record<string, unknown>;
  const scope = row.legacySourceScope;
  if (!scope || typeof scope !== "object") {
    throw new Error("legacy service auth key: legacySourceScope is required");
  }
  const scoped = scope as Record<string, unknown>;
  if (typeof row.keyId !== "string" || !row.keyId.trim()) {
    throw new Error("legacy service auth key: keyId is required");
  }
  if (typeof row.secret !== "string" || row.secret.length === 0) {
    throw new Error("legacy service auth key: secret is required");
  }
  if (typeof row.service !== "string" || !row.service.trim()) {
    throw new Error("legacy service auth key: service is required");
  }
  if (!isPurpose(row.purpose)) {
    throw new Error("legacy service auth key: purpose is not a declared purpose");
  }
  if (typeof row.organizationId !== "string" || !row.organizationId.trim()) {
    throw new Error("legacy service auth key: organizationId is required");
  }
  if (typeof scoped.sourceSystem !== "string" || !scoped.sourceSystem.trim()) {
    throw new Error("legacy service auth key: sourceSystem is required");
  }
  if (!Array.isArray(scoped.ownerRefs) || scoped.ownerRefs.some((item) => typeof item !== "string")) {
    throw new Error("legacy service auth key: ownerRefs must be a string array");
  }
  if (typeof row.revoked !== "boolean") {
    throw new Error("legacy service auth key: revoked must be boolean");
  }
  return {
    keyId: row.keyId,
    secret: row.secret,
    service: row.service,
    purpose: row.purpose,
    organizationId: row.organizationId,
    legacySourceScope: {
      sourceSystem: scoped.sourceSystem,
      ownerRefs: scoped.ownerRefs as string[],
    },
    notBefore: asIntegerOrNull(row.notBefore),
    notAfter: asIntegerOrNull(row.notAfter),
    revoked: row.revoked,
  };
}

export function parseLegacyServiceAuthKeysJson(
  raw: string | undefined
): Map<string, LegacyServiceAuthKey> {
  const map = new Map<string, LegacyServiceAuthKey>();
  if (!raw?.trim()) return map;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("LEGACY_SERVICE_AUTH_KEYS_JSON must be an array");
  }
  for (const item of parsed) {
    const key = parseLegacyServiceAuthKey(item);
    if (map.has(key.keyId)) {
      throw new Error(`duplicate legacy service auth key id: ${key.keyId}`);
    }
    map.set(key.keyId, key);
  }
  return map;
}

export function lookupLegacyServiceAuthKey(
  keyId: string,
  env: Record<string, string | undefined> = process.env
): LegacyServiceAuthKey | null {
  const keys = parseLegacyServiceAuthKeysJson(env.LEGACY_SERVICE_AUTH_KEYS_JSON);
  return keys.get(keyId) ?? null;
}

export function lookupFromMap(
  keys: ReadonlyMap<string, LegacyServiceAuthKey>
): (keyId: string) => LegacyServiceAuthKey | null {
  return (keyId) => keys.get(keyId) ?? null;
}
