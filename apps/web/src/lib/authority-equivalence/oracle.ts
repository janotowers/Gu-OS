/**
 * Independent observation of Traditional Gu takeover behavior (SL-6 T6).
 *
 * This is not a Gu OS invariant. Audit §8.3 records the reminder job:
 *
 *   bypass_bot = true
 *   and last_owner_interaction_wba < now - 5 minutes
 *
 * which then clears the flag. The number five lives only in this file.
 * The resolver, the persist path and the inbound route must not import
 * this module and must not encode that window.
 *
 * The per-number kill switch is observed and never folded into
 * `humanActive`.
 */

export const LEGACY_RESUME_WINDOW_MS = 5 * 60 * 1000;

export interface OracleObservedInputs {
  leadTakeoverActive: boolean | null;
  lastOwnerInteractionAt: string | null;
  numberKillSwitchActive: boolean | null;
  observedAt: string;
}

export interface OracleVerdict {
  humanActive: boolean | null;
  windowExpired: boolean;
  reason: string;
}

function parseInstant(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What legacy's own sweep would treat as current speaking suppression,
 * given the same observed fields the capability exposes.
 */
export function observeLegacyTakeover(
  inputs: OracleObservedInputs
): OracleVerdict {
  if (inputs.leadTakeoverActive === null) {
    return {
      humanActive: null,
      windowExpired: false,
      reason: "lead_takeover_not_boolean",
    };
  }

  if (inputs.leadTakeoverActive === false) {
    return {
      humanActive: false,
      windowExpired: false,
      reason: "legacy_bypass_bot_false",
    };
  }

  if (!inputs.lastOwnerInteractionAt) {
    return {
      humanActive: true,
      windowExpired: false,
      reason: "bypass_bot_true_without_timestamp",
    };
  }

  const last = parseInstant(inputs.lastOwnerInteractionAt);
  const now = parseInstant(inputs.observedAt);
  if (last === null || now === null) {
    return {
      humanActive: null,
      windowExpired: false,
      reason: "unparseable_timestamp",
    };
  }

  const ageMs = now - last;
  if (ageMs > LEGACY_RESUME_WINDOW_MS) {
    return {
      humanActive: false,
      windowExpired: true,
      reason: "legacy_sweep_would_clear_bypass_bot",
    };
  }

  return {
    humanActive: true,
    windowExpired: false,
    reason: "bypass_bot_true_inside_resume_window",
  };
}
