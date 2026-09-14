/**
 * The presentation filter — R1 SL-7, TD-9's hard guard (second half),
 * Slice Plan SA-7.5, SA-7.6, SA-7.7.
 *
 * A person's snooze, hide, pin and seen marker decide what THEY see and in
 * what order — and nothing else. Two rules make that safe:
 *
 *  1. **a must-surface item is exempt from snooze and hide entirely.** It stays
 *     visibly present whatever the person chose; the choice is still reported,
 *     so the view can say "you snoozed this — it stays because it is required",
 *     but it cannot remove the item (S4 §13: personal presentation cannot
 *     erase an underlying obligation);
 *  2. **a snooze defers a non-must-surface item by at most 14 days (D6).** The
 *     database clamps any longer write, and this filter reads a stored value
 *     against the same cap, so no path — the Portfolio's own or a direct
 *     user-JWT write — can defer further.
 *
 * Nothing here resolves a need. Seen / snoozed / hidden / pinned are
 * presentation; a need exits only when durable truth changes (S4 §6.8,
 * invariant 6).
 */
import {
  PORTFOLIO_SNOOZE_CAP_DAYS,
  type PortfolioPresentationState,
} from "@agents/types";
import type { PortfolioPresentationPatch } from "@agents/db";

const DAY_MS = 86_400_000;

export type PresentationChange =
  | { kind: "seen" }
  | { kind: "snooze"; days: number }
  | { kind: "unsnooze" }
  | { kind: "hide" }
  | { kind: "unhide" }
  | { kind: "pin" }
  | { kind: "unpin" };

/**
 * The column patch a change writes. Throws for a snooze outside 1…14 whole
 * days — refused before any write rather than silently clamped, so a caller
 * asking for more learns that it cannot have it.
 */
export function presentationPatchFor(
  change: PresentationChange,
  now: Date
): PortfolioPresentationPatch {
  switch (change.kind) {
    case "seen":
      return { seen_at: now.toISOString() };
    case "snooze": {
      if (!Number.isInteger(change.days) || change.days < 1 || change.days > PORTFOLIO_SNOOZE_CAP_DAYS) {
        throw new Error(
          `snooze must be 1..${PORTFOLIO_SNOOZE_CAP_DAYS} whole days (D6), got ${change.days}`
        );
      }
      return { snooze_until: new Date(now.getTime() + change.days * DAY_MS).toISOString() };
    }
    case "unsnooze":
      return { snooze_until: null };
    case "hide":
      return { hidden_at: now.toISOString() };
    case "unhide":
      return { hidden_at: null };
    case "pin":
      return { pinned: true };
    case "unpin":
      return { pinned: false };
  }
}

/** When a stored snooze actually ends: never later than 14 days after its write. */
export function effectiveSnoozeUntil(row: PortfolioPresentationState): string | null {
  if (!row.snooze_until) return null;
  const stored = Date.parse(row.snooze_until);
  const cap = Date.parse(row.updated_at) + PORTFOLIO_SNOOZE_CAP_DAYS * DAY_MS;
  if (Number.isNaN(stored)) return null;
  return new Date(Number.isNaN(cap) ? stored : Math.min(stored, cap)).toISOString();
}

export interface PresentationDecision {
  /** Whether this person's list shows the entry. Always true when must-surface. */
  visible: boolean;
  /** The person hid or snoozed it, and it shows anyway because it is required. */
  exemptBecauseMustSurface: boolean;
  /** What the person chose, reported even when it cannot apply. */
  userSuppression: "hidden" | "snoozed" | null;
  pinned: boolean;
  seenAt: string | null;
  snoozedUntil: string | null;
}

export function decidePresentation(
  entry: { mustSurface: boolean },
  row: PortfolioPresentationState | null,
  now: Date
): PresentationDecision {
  if (!row) {
    return {
      visible: true,
      exemptBecauseMustSurface: false,
      userSuppression: null,
      pinned: false,
      seenAt: null,
      snoozedUntil: null,
    };
  }
  const snoozeEnd = effectiveSnoozeUntil(row);
  const snoozed = snoozeEnd !== null && Date.parse(snoozeEnd) > now.getTime();
  const userSuppression = row.hidden_at ? "hidden" : snoozed ? "snoozed" : null;
  return {
    visible: entry.mustSurface || userSuppression === null,
    exemptBecauseMustSurface: entry.mustSurface && userSuppression !== null,
    userSuppression,
    pinned: row.pinned,
    seenAt: row.seen_at,
    snoozedUntil: snoozed ? snoozeEnd : null,
  };
}
