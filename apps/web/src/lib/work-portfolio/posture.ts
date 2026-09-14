/**
 * Posture derivation — R1 SL-7, Slice Plan SA-7.10 (S4 §5, §7; TD-9).
 *
 * Posture is EARNED from durable state, never invented:
 *
 *  - a Case with no settled Gu OS reconsideration has **no derived posture**,
 *    whatever else is true of it. It is shown with its runtime authority and
 *    as not yet reconsidered — never as "Gu Handling" (SA-7.10 clarification);
 *  - `stalled` is an integrity and attention predicate, not a posture, so it
 *    never appears here (a Case newly under `gu_os` may be stalled with no
 *    posture at all);
 *  - `gu_handling` never implies a running process (S4 §7.1, invariant 7): it
 *    derives from where the last settlement left responsibility, and running
 *    Work on its own derives nothing;
 *  - `watching` is never derived in SL-7. S4 §7.4 and invariant 9 require a
 *    credible detection mechanism, and the only re-entry mechanism R1
 *    Organization Cases have is the scheduled reconsideration — which is
 *    waiting, not watching. Event forwarding (SL-5) is what can make it true;
 *  - a posture derived while `runtime_authority` is not `gu_os` is a SHADOW
 *    posture: what Gu OS concluded while Legacy stayed authoritative. The mode
 *    travels with it so no renderer can present it as Gu OS being in charge.
 *
 * Postures are non-exclusive (S4 §4.3).
 */
import {
  PORTFOLIO_POSTURES,
  type AttentionProjection,
  type PortfolioPosture,
  type PostureAuthorityMode,
  type SupervisorYieldPosture,
} from "@agents/types";
import { latestSettledReconsideration, openAskWork } from "./must-surface";
import type { PortfolioCaseSnapshot, PortfolioReconsideration } from "./snapshot";

/** Gu retains responsibility and needs nothing from a human now (S4 §7.1–§7.2, §7.5). */
const HANDLING: ReadonlySet<SupervisorYieldPosture> = new Set<SupervisorYieldPosture>([
  "work_underway",
  "reconciliation_established",
  // Intentional quiescence with a re-entry path is valid handling, not a
  // stall (S4 §7.5–§7.6); every settlement carries its `next_action_at`.
  "no_useful_work_now",
  "lifecycle_reassessment_needed",
  "coordinate_with_other_case",
]);

/** Progression depends on a future time, response, event or condition (S4 §7.3). */
const WAITING: ReadonlySet<SupervisorYieldPosture> = new Set<SupervisorYieldPosture>([
  "waiting_for_prospect",
  "waiting_until_time",
  "waiting_for_external_signal",
  "human_leads_conversation",
]);

/** Gu is waiting on a HUMAN of the Organization — attention while unanswered. */
const HUMAN_WAIT: ReadonlySet<SupervisorYieldPosture> = new Set<SupervisorYieldPosture>([
  "waiting_for_human_input",
  "waiting_for_approval",
]);

export interface DerivedPosture {
  /** Empty when the Case was never reconsidered by Gu OS. */
  postures: PortfolioPosture[];
  reconsidered: boolean;
  mode: PostureAuthorityMode;
  /** The reconsideration the posture is derived from, when there is one. */
  basis: PortfolioReconsideration | null;
}

export function derivePosture(
  snapshot: PortfolioCaseSnapshot,
  attention: readonly AttentionProjection[]
): DerivedPosture {
  const mode: PostureAuthorityMode =
    snapshot.case.runtime_authority === "gu_os" ? "authoritative" : "shadow";
  const basis = latestSettledReconsideration(snapshot);
  if (!basis?.settlement) return { postures: [], reconsidered: false, mode, basis: null };

  const found = new Set<PortfolioPosture>();
  if (attention.length > 0) found.add("needs_attention");

  const yieldPosture = basis.settlement.yield_posture;
  if (HANDLING.has(yieldPosture)) {
    found.add("gu_handling");
  } else if (WAITING.has(yieldPosture)) {
    found.add("waiting");
  } else if (HUMAN_WAIT.has(yieldPosture)) {
    // Unanswered: Gu waits on the human (and the ask is in Needs Attention).
    // Answered: the human part is done and Gu holds the Case until its next
    // reconsideration — handling, not waiting on anyone.
    found.add(openAskWork(snapshot, basis).length > 0 ? "waiting" : "gu_handling");
  }

  if (snapshot.closure) found.add("outcomes");

  return {
    postures: PORTFOLIO_POSTURES.filter((p) => found.has(p)),
    reconsidered: true,
    mode,
    basis,
  };
}
