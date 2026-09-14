/**
 * The Work Portfolio projection — R1 SL-7, Slice Plan SA-7.1 (S4 §4.2;
 * AC-9 §14.1–§14.2; TD-9 v1).
 *
 * My Work and Organization Work are two authorized projections over ONE
 * truth: each Case becomes one entry, and the two views are filters over the
 * same entries — never two stores, never two copies that could disagree.
 *
 * Input order is the contract: the snapshots are already the actor's
 * authorized candidate set (`load.ts` builds them from the actor's own-JWT
 * read), the predicates run next, and a person's presentation state is
 * applied last, to ordering and visibility only.
 */
import type {
  AttentionProjection,
  OrganizationRole,
  PortfolioPresentationState,
} from "@agents/types";
import { commitmentDueState, compareAttention, evaluateMustSurface, type CommitmentDueState } from "./must-surface";
import { derivePosture, type DerivedPosture } from "./posture";
import { decidePresentation, type PresentationDecision } from "./presentation";
import type { PortfolioCase, PortfolioCaseSnapshot, PortfolioWork } from "./snapshot";

/**
 * Who may decide an approval on an Organization Case (D3). Rendering only —
 * the gate is `authorizeOrgAction(…, "case_approval.decide")`, and the
 * selftest holds the two in agreement for every role.
 */
export const APPROVAL_DECIDER_ROLES: readonly OrganizationRole[] = ["owner", "org_admin"];

export function canDecideApprovals(role: OrganizationRole): boolean {
  return APPROVAL_DECIDER_ROLES.includes(role);
}

export interface PortfolioActor {
  userId: string;
  role: OrganizationRole;
}

/**
 * Where an entry is listed. Exactly one per entry, exception-first (S4 §4.1);
 * the entry's postures stay the full non-exclusive set.
 *
 * `not_reconsidered` holds a Case Gu OS never reconsidered — no derived
 * posture, shown with its runtime authority (SA-7.10).
 */
export type PortfolioSection =
  | "needs_attention"
  | "gu_handling"
  | "waiting"
  | "not_reconsidered"
  | "outcomes";

export const PORTFOLIO_SECTIONS: readonly PortfolioSection[] = [
  "needs_attention",
  "gu_handling",
  "waiting",
  "not_reconsidered",
  "outcomes",
];

export interface CommitmentView {
  subjectId: string;
  expected: string | null;
  actor: string | null;
  status: string | null;
  dueState: CommitmentDueState;
  /** A full instant, when the fact carries one. */
  dueAt: string | null;
  /** Stated-but-unresolved timing, verbatim — never converted (D5). */
  dueExpression: string | null;
}

export interface PortfolioEntry {
  case: PortfolioCase;
  objective: string | null;
  attention: AttentionProjection[];
  posture: DerivedPosture;
  closure: { factId: string; outcome: string | null; reason: string | null } | null;
  commitments: CommitmentView[];
  /** Work that has not reached `done` or `cancelled`. */
  openWork: PortfolioWork[];
  section: PortfolioSection;
  /** Why the entry is in the actor's My Work; empty when it is not. */
  myWorkReasons: Array<"assigned" | "approval_authority">;
  canDecideApprovals: boolean;
  presentation: PresentationDecision;
}

export interface PortfolioView {
  /** Shown, in order. Every must-surface entry is here. */
  entries: PortfolioEntry[];
  /** Hidden or snoozed by this person — never a must-surface entry. */
  suppressed: PortfolioEntry[];
}

export interface WorkPortfolio {
  actor: PortfolioActor;
  generatedAt: string;
  myWork: PortfolioView;
  organizationWork: PortfolioView;
}

function field(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : null;
}

function commitmentViews(snapshot: PortfolioCaseSnapshot): CommitmentView[] {
  return snapshot.commitments.map((commitment) => {
    const dueState = commitmentDueState(commitment);
    const due = commitment.due?.value;
    return {
      subjectId: commitment.subject_id,
      expected: field(commitment.expected_outcome?.value, "expected_outcome") ?? commitment.label,
      actor: field(commitment.actor?.value, "actor"),
      status: field(commitment.status?.value, "status"),
      dueState,
      dueAt: dueState === "instant" ? field(due, "due_at") : null,
      dueExpression: dueState === "expression" ? field(due, "due_expression") : null,
    };
  });
}

function sectionOf(attention: readonly AttentionProjection[], snapshot: PortfolioCaseSnapshot, posture: DerivedPosture): PortfolioSection {
  if (attention.length > 0) return "needs_attention";
  if (snapshot.closure) return "outcomes";
  if (posture.postures.includes("gu_handling")) return "gu_handling";
  if (posture.postures.includes("waiting")) return "waiting";
  return "not_reconsidered";
}

function compareEntries(a: PortfolioEntry, b: PortfolioEntry): number {
  const bySection = PORTFOLIO_SECTIONS.indexOf(a.section) - PORTFOLIO_SECTIONS.indexOf(b.section);
  if (bySection !== 0) return bySection;
  // Pinning reorders within a section; it can never move an entry out of one.
  if (a.presentation.pinned !== b.presentation.pinned) return a.presentation.pinned ? -1 : 1;
  if (a.section === "needs_attention") {
    const byNeed = compareAttention(a.attention[0], b.attention[0]);
    if (byNeed !== 0) return byNeed;
  }
  const byRecency = Date.parse(b.case.updated_at) - Date.parse(a.case.updated_at);
  return byRecency !== 0 ? byRecency : a.case.id.localeCompare(b.case.id);
}

function view(entries: readonly PortfolioEntry[]): PortfolioView {
  const shown = entries.filter((e) => e.presentation.visible).sort(compareEntries);
  const suppressed = entries.filter((e) => !e.presentation.visible).sort(compareEntries);
  return { entries: shown, suppressed };
}

export function buildWorkPortfolio(params: {
  actor: PortfolioActor;
  snapshots: readonly PortfolioCaseSnapshot[];
  presentation: readonly PortfolioPresentationState[];
  now: Date;
}): WorkPortfolio {
  const { actor, now } = params;
  // Presentation is personal: only the actor's own rows ever apply to them.
  const mine = new Map<string, PortfolioPresentationState>();
  for (const row of params.presentation) {
    if (row.user_id === actor.userId && row.subject_kind === "case") mine.set(row.subject_id, row);
  }
  const decides = canDecideApprovals(actor.role);

  const entries: PortfolioEntry[] = params.snapshots.map((snapshot) => {
    const attention = evaluateMustSurface(snapshot, now);
    const posture = derivePosture(snapshot, attention);
    const reasons: PortfolioEntry["myWorkReasons"] = [];
    if (snapshot.case.assigned_to_user_id === actor.userId) reasons.push("assigned");
    if (decides && attention.some((a) => a.predicate === "pending_approval")) {
      reasons.push("approval_authority");
    }
    return {
      case: snapshot.case,
      objective: field(snapshot.objective?.value, "objective"),
      attention,
      posture,
      closure: snapshot.closure
        ? {
            factId: snapshot.closure.id,
            outcome: field(snapshot.closure.value, "outcome"),
            reason: field(snapshot.closure.value, "reason"),
          }
        : null,
      commitments: commitmentViews(snapshot),
      openWork: snapshot.work.filter((w) => w.status !== "done" && w.status !== "cancelled"),
      section: sectionOf(attention, snapshot, posture),
      myWorkReasons: reasons,
      canDecideApprovals: decides,
      presentation: decidePresentation(
        { mustSurface: attention.length > 0 },
        mine.get(snapshot.case.id) ?? null,
        now
      ),
    };
  });

  return {
    actor,
    generatedAt: now.toISOString(),
    myWork: view(entries.filter((e) => e.myWorkReasons.length > 0)),
    organizationWork: view(entries),
  };
}
