/**
 * Delivery eligibility — the deterministic half of S2 §8.12 that SL-4 owes.
 *
 * S2 splits one question into two that must not be collapsed:
 *
 *     IS CONTACT ALLOWED?  → governed eligibility  ← this module
 *     IS CONTACT USEFUL?   → situational judgment  ← the model seam
 *
 * Everything here is a **hard bound**: non-overridable, and specifically not
 * something model judgment may argue around (§8.12, §8.1 invariant 19 — "a
 * timer cannot override explicit prospect contact restrictions"). That is why
 * the restriction is never passed into the judge's prompt: a confident model
 * given the restriction would be given the opportunity to reason past AC-03,
 * and this Slice's contract makes the guarantee deterministic instead.
 *
 * SCOPE, STATED PRECISELY
 *
 * SL-4 owns the two hard bounds its acceptance contract names and its evidence
 * can exercise: an explicit "contact me after X" (SA-4.7 / S2 AC-03) and an
 * explicit opt-out. The opt-out is included not as scope creep but because the
 * gate has to return *something* for an opted-out prospect, and returning
 * "allowed" would be wrong in a way no later Slice would notice.
 *
 * Deliberately NOT here, and not half-built:
 *
 *  - **runtime and conversation authority** (§8.12: "active human conversation
 *    authority", "runtime authority not belonging to Gu OS"). The resolver is
 *    TD-3/TD-4 and lands at SL-6 advisory, SL-11 enforcing, both gated on the
 *    C2 cross-repo contract. A partial local imitation of it would be a second
 *    authority mechanism, which Technical Plan §6 forbids;
 *  - **soft policy** — cooldowns, frequency, delivery windows. Soft guidance
 *    lowers the expected value of contact; it does not forbid it (§8.12), so it
 *    belongs to the judgment side, not this gate;
 *  - **channel and regulatory restrictions**, which arrive with the channel
 *    contracts at SL-9+.
 *
 * The fact-key namespace is settled incrementally by the Slice that first needs
 * each part (TD-8), and Technical Plan §11 assigns contact-preference
 * representation to "SL-4+" as slice-owned work with no human gate. This
 * settles the minimum SL-4 needs and deliberately invents no broader taxonomy
 * of contact preference.
 */
import type { CaseFact } from "@agents/types";

/** The single case-level fact holding current prospect contact restrictions. */
export const DELIVERY_RESTRICTION_FACT_KEY = "delivery.restriction";

/**
 * Current restriction state for one Opportunity.
 *
 * One fact rather than one fact per restriction, because `case_facts` holds one
 * current value per key: a Case whose prospect both opted out and asked to be
 * contacted after a date has ONE restriction state, and a change supersedes it
 * as a whole with its provenance intact.
 */
export interface DeliveryRestrictionFactValue {
  /** Explicit do-not-contact. Absolute while current. */
  opt_out: boolean;
  /** Explicit "not before X" as an ISO-8601 instant, when one was given. */
  not_before: string | null;
  /** How the restriction was established, for provenance. */
  basis: "prospect_stated" | "advisor_recorded";
  /** The prospect's own words, when they are what established it. */
  note: string | null;
}

export type OutboundBlockReason = "opt_out" | "not_before";

export interface DeliveryEligibility {
  /** True only when no hard bound currently forbids prospect-facing contact. */
  outboundAllowed: boolean;
  /** Why not, when not. Null when allowed. */
  blockedBy: OutboundBlockReason | null;
  /** The instant the `not_before` bound lifts, when that is the blocker. */
  liftsAt: string | null;
  /**
   * Always true in SL-4, and it is the point of AC-03: a restriction on
   * *outbound* never suspends internal work. Research, reconciliation and
   * durable Work stay permitted while the prospect is not to be contacted.
   */
  internalWorkAllowed: true;
}

const ALLOWED: DeliveryEligibility = {
  outboundAllowed: true,
  blockedBy: null,
  liftsAt: null,
  internalWorkAllowed: true,
};

function parseRestriction(value: unknown): DeliveryRestrictionFactValue | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const optOut = raw.opt_out === true;
  const notBefore =
    typeof raw.not_before === "string" && raw.not_before.trim() !== ""
      ? raw.not_before
      : null;
  if (!optOut && notBefore === null) return null;
  return {
    opt_out: optOut,
    not_before: notBefore,
    basis: raw.basis === "advisor_recorded" ? "advisor_recorded" : "prospect_stated",
    note: typeof raw.note === "string" ? raw.note : null,
  };
}

/**
 * Resolves whether prospect-facing contact is currently permitted.
 *
 * Pure, and deliberately so: it takes the already-read current facts and a
 * clock rather than a database handle, which is what lets AC-03 be proven by a
 * deterministic policy test at both sides of the boundary instant.
 *
 * **Fails closed on an unparseable restriction.** A restriction fact that
 * exists but cannot be read is not the same as no restriction: the prospect
 * said something, and the safe reading of "we cannot tell what" is that
 * outbound is blocked. Treating it as absent would let a malformed row silently
 * restore permission the prospect withdrew.
 */
export function resolveDeliveryEligibility(params: {
  currentFacts: ReadonlyMap<string, CaseFact>;
  now: Date;
}): DeliveryEligibility {
  const fact = params.currentFacts.get(DELIVERY_RESTRICTION_FACT_KEY);
  if (!fact) return ALLOWED;

  const restriction = parseRestriction(fact.value_jsonb);
  if (!restriction) {
    return {
      outboundAllowed: false,
      blockedBy: "opt_out",
      liftsAt: null,
      internalWorkAllowed: true,
    };
  }

  if (restriction.opt_out) {
    return {
      outboundAllowed: false,
      blockedBy: "opt_out",
      liftsAt: null,
      internalWorkAllowed: true,
    };
  }

  if (restriction.not_before) {
    const liftsAt = new Date(restriction.not_before);
    if (Number.isNaN(liftsAt.getTime())) {
      // Same reasoning as an unparseable restriction: an uninterpretable
      // boundary is not an absent one.
      return {
        outboundAllowed: false,
        blockedBy: "not_before",
        liftsAt: null,
        internalWorkAllowed: true,
      };
    }
    // The boundary is inclusive of "at X": at exactly the stated instant the
    // prospect asked to be contacted AFTER, contact becomes permitted.
    if (params.now.getTime() < liftsAt.getTime()) {
      return {
        outboundAllowed: false,
        blockedBy: "not_before",
        liftsAt: restriction.not_before,
        internalWorkAllowed: true,
      };
    }
  }

  return ALLOWED;
}
