/**
 * Platform hard bounds (S1 §8.4.5, AC-06, EC-02).
 *
 * These are not policy. No Organization configuration and no model judgment,
 * however confident, may relax them — so they are evaluated **before** policy
 * and before the interpreter runs, and their result is not an input the rest of
 * the pipeline can weigh against anything else.
 *
 * The probe is an injectable interface because what counts as "blocked" or "not
 * a genuine prospect record" comes from evidence the admission module does not
 * own. Keeping it behind an interface is what lets the deterministic test in
 * SA-2.5 assert the *precedence* — a bound beating a permissive policy and a
 * confident model — without needing the real blocking source to exist yet.
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
 * The bounds resolvable from evidence SL-2 actually has.
 *
 * Deliberately narrow. `prospect_blocked` needs a blocking source that no
 * approved artifact places in this Slice, so it is not fabricated here — a probe
 * that guessed would be worse than one that abstains, because a wrong "not
 * blocked" is invisible. `organization_not_authorized` is enforced upstream by
 * the flag check and the gateway binding gate, and is repeated here so a caller
 * that ever bypasses those still cannot admit.
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
      if (isNonProspectRecord(subject.payload)) return "non_prospect_record";
      return null;
    },
  };
}

/**
 * Whether the inbound record is a test/internal artifact rather than a real
 * prospect (S1 §8.4.3, "obvious spam/test/known duplicate ... do not create a
 * normal active Opportunity").
 *
 * Reads an explicit marker the normalizer set. It does NOT sniff message text:
 * deciding from text is semantic judgment, which belongs to the interpreter and
 * to the eval set, not to a deterministic bound that no policy may override.
 */
function isNonProspectRecord(payload: Record<string, unknown>): boolean {
  return payload.is_test_record === true || payload.is_internal_record === true;
}
