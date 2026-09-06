/**
 * Platform hard bounds (S1 §8.4.5, AC-06, EC-02).
 *
 * These are not policy. No Organization configuration and no model judgment,
 * however confident, may relax them — so they are evaluated **before** policy
 * and before the interpreter runs, and their result is not an input the rest of
 * the pipeline can weigh against anything else.
 *
 * ## What is, and is not, a hard bound
 *
 * S1 §8.4.5 lists the non-overridable bounds exhaustively. Organization
 * configuration and Gu judgment must not: cross tenant/organization
 * authorization boundaries; treat model confidence as permission; bypass
 * applicable communication/privacy/safety restrictions; create or attach an
 * Opportunity to an unauthorized contact/organization; silently disclose
 * prospect data across brokerages; erase provenance; or declare business
 * outcomes unsupported by evidence.
 *
 * **Spam and test records are not on that list.** They appear in §8.4.3 under
 * *Recommended default behavior* — "obvious spam/test/known duplicate or
 * non-overridable blocked/unauthorized context: do not create a normal active
 * Opportunity" — a sentence that bundles a default-policy behavior with a hard
 * bound. Recognising an obvious test or spam opener is semantic judgment about
 * what a message is, which belongs to the interpreter and its eval set. Encoding
 * it here would invent a stronger, non-overridable product restriction than S1
 * approves, and would do it with exactly the keyword-matching this Slice's
 * contract forbids.
 *
 * The probe is an injectable interface because the evidence these bounds turn on
 * is not owned by the admission module. That is also what lets the deterministic
 * test for SA-2.5 assert the *precedence* — a bound beating a permissive policy
 * and a confident model — without the real blocking source existing yet.
 */
import type { PlatformHardBound } from "@agents/types";

export interface HardBoundSubject {
  organizationId: string;
  /** The opaque legacy lead identity being evaluated. */
  externalLeadRef: string;
  /** Normalized inbound payload, as recorded on the source event. */
  payload: Record<string, unknown>;
}

export interface PlatformHardBoundProbe {
  /** Returns the bound that forbids admission, or null when none applies. */
  evaluate(subject: HardBoundSubject): Promise<PlatformHardBound | null>;
}

/**
 * The production probe for SL-2.
 *
 * It enforces exactly one bound — `organization_not_authorized` — and that is
 * the honest extent of what this Slice can decide from evidence it has:
 *
 *   * **`organization_not_authorized`** — enforced. S1 §8.4.5's tenant/
 *     authorization boundary. Also enforced upstream by the flag check and the
 *     SL-1 binding gate; repeated here so a caller that ever bypasses those
 *     still cannot admit.
 *
 *   * **`prospect_blocked`** — declared in the vocabulary and **not enforceable
 *     from SL-2's evidence**. It needs a platform blocking/opt-out source that
 *     no approved artifact places in this Slice, and the SL-1 gateway exposes no
 *     such signal. A probe that guessed would be worse than one that abstains,
 *     because a wrong "not blocked" is invisible. The interface exists so a real
 *     bound *wins* once its source lands, and the deterministic suite proves
 *     that precedence today with an injected probe.
 *
 *   * **`non_prospect_record`** — deliberately not enforced here at all: see the
 *     module note above. Spam/test is Recommended-default semantic judgment,
 *     evidenced by the eval set, not a platform bound.
 */
export function createDefaultHardBoundProbe(params: {
  /** Organizations authorized for Relationship Operations, per the flag check. */
  isOrganizationAuthorized: (organizationId: string) => Promise<boolean>;
}): PlatformHardBoundProbe {
  return {
    async evaluate(subject) {
      if (!(await params.isOrganizationAuthorized(subject.organizationId))) {
        return "organization_not_authorized";
      }
      return null;
    },
  };
}
