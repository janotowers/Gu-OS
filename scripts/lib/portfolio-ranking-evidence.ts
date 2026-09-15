// Hosted-evidence evaluation for R1 SL-12, the Work Portfolio v2 (contextual
// ranking and conversational access).
//
// Split out of `verify-portfolio-ranking.ts` for the same reason every R1
// verifier splits its evaluator: the part of the hosted run that decides
// pass/fail is pure, so it is unit-tested without a hosted environment. The
// runner keeps the I/O — resolving the target, the bounded flag activation,
// the optional controlled seed, the read-only checkpoints, reading captures.
//
// WHAT THE RS-2 OBLIGATIONS ASK (Slice Plan SL-12, "RS-2 evidence obligations"),
// each pass or fail:
//
//   1. Needs Attention ranked by the pass, with each shown claim grounded;
//   2. a must-surface item present regardless of its rank;
//   3. the ranking call's AI usage correlated to the Organization;
//   4. a chat question answered from the same projection under the advisor's
//      authorization, and a cross-user attempt refused.
//
// Boundaries: no persisted ranking, no authority change, no write to SL-4's
// evidence Cases or SL-7's seeded Case — proven by fingerprinting the whole
// containment surface at T0 and T1.
//
// The rule every R1 verifier inherits: an assertion must test what its label
// says. "the page rendered" does not prove "every claim cites its own Case";
// "a tool call happened" does not prove "the chat read the same projection".

import {
  digestRows,
  fingerprint,
  type Fingerprint,
  type HostedCheck,
  type Row,
} from "./portfolio-evidence";

export { digestRows, fingerprint };
export type { Fingerprint, HostedCheck, Row };

export const RANKING_MODEL_ROLE = "relationship_portfolio_ranking";
export const PORTFOLIO_TOOL = "work_portfolio_read";
export const RANKING_FLAG = "portfolio_contextual_ranking";

/**
 * The DurableRef kinds a contextual claim can cite: exactly the aliases the
 * ranking frame gives the model for a Case (`ranking/frame.ts`). A governed
 * item's `.aN` alias never appears on a contextual card, because a Case with a
 * governed item is never admitted contextually.
 */
export const CITABLE_KINDS = ["case", "case_fact", "case_subject", "work_item", "case_event"] as const;
export type CitableKind = (typeof CITABLE_KINDS)[number];

/**
 * Business and configuration tables fingerprinted WHOLE at each checkpoint:
 * the containment surface. `ai_usage_events` is deliberately absent — the
 * session adds to it by design — and is checked on its own (RS2-3); the chat's
 * own tables (sessions, messages, tool calls) are outside it for the same
 * reason.
 */
export const CONTAINMENT_TABLES = [
  "operational_cases",
  "case_facts",
  "case_subjects",
  "case_subject_external_refs",
  "operational_case_events",
  "case_approvals",
  "case_relationships",
  "work_items",
  "work_item_attempts",
  "work_item_events",
  "internal_user_notifications",
  "portfolio_presentation_state",
  "organizations",
  "organization_memberships",
  "organization_feature_flags",
] as const;
export type ContainmentTable = (typeof CONTAINMENT_TABLES)[number];

export interface CaseIdentity {
  id: string;
  assigned_to_user_id: string | null;
  runtime_authority: string | null;
}

export interface UsageRow {
  id: string;
  occurred_at: string;
  organization_id: string | null;
  user_id: string | null;
  channel: string | null;
  status: string;
  model_role: string;
}

/** A `work_portfolio_read` call, reduced to identities: no titles, no claims. */
export interface PortfolioToolCall {
  id: string;
  created_at: string;
  status: string;
  view: "mine" | "organization";
  /** The tool's own status, then the Portfolio read's (`ok`, `inert`, …). */
  toolStatus: string | null;
  readStatus: string | null;
  needs: Array<{ case_id: string; kind: string }>;
  others: string[];
}

export interface RankingCheckpoint {
  label: string;
  /** This process's clock — ordering only, never evidence of elapsed time. */
  takenAt: string;
  flags: { relationshipOps: boolean; contextualRanking: boolean };
  /** Every Case of the pilot Organization. */
  cases: CaseIdentity[];
  /** Per Case, the ids of the rows a claim may cite, by kind. Ids only. */
  citable: Record<string, Partial<Record<CitableKind, string[]>>>;
  /** Per Case, the must-surface predicates SL-7's pure rules find now. */
  mustSurface: Record<string, string[]>;
  containment: Record<ContainmentTable, Fingerprint>;
  /** Every ranking-role usage row (any Organization), minimal fields. */
  rankingUsage: UsageRow[];
  /** Every `work_portfolio_read` call in the advisor's sessions. */
  portfolioToolCalls: PortfolioToolCall[];
}

/** What the capture script extracts from the advisor's rendered page. */
export interface PageCapture {
  view: string | null;
  rankingStatus: string | null;
  entries: Array<{
    caseId: string;
    section: string;
    kind: string;
    rank: number | null;
    visible: boolean;
    predicates: string[];
    claimRefs: string[];
  }>;
}

export interface ProbeRead {
  target: "other_organization_cases" | "other_user_presentation";
  status: number;
  rows: number;
}

export interface ProbeResult {
  attempted: boolean;
  how: string;
  reads: ProbeRead[];
}

export interface RankingEvidenceInputs {
  organizationId: string;
  advisorUserId: string;
  t0: RankingCheckpoint;
  t1: RankingCheckpoint;
  captures: {
    organizationWork: PageCapture;
    myWork: PageCapture;
    /** The chat's visible answer, as rendered; evidence keeps only its digest. */
    chatAnswer: string;
  };
  /** Ids of Cases owned by any OTHER Organization in the environment. */
  otherOrganizationCaseIds: string[];
  /** Presentation rows of other users in the pilot — the probe's non-vacuity. */
  otherUserPresentationRows: number;
  probe: ProbeResult | null;
}

function check(assertion: string, label: string, ok: boolean, detail?: string): HostedCheck {
  return { assertion, label, ok, ...(detail ? { detail } : {}) };
}

/** Cases must-surface at BOTH checkpoints: the capture falls between them. */
export function stableMustSurface(t0: RankingCheckpoint, t1: RankingCheckpoint): string[] {
  return Object.keys(t1.mustSurface)
    .filter((id) => (t1.mustSurface[id] ?? []).length > 0 && (t0.mustSurface[id] ?? []).length > 0)
    .sort();
}

/** `kind:id` → is it a row of `caseId`, as the checkpoint recorded it? */
export function citesOwnCase(ref: string, caseId: string, citable: RankingCheckpoint["citable"]): boolean {
  const colon = ref.indexOf(":");
  if (colon <= 0) return false;
  const kind = ref.slice(0, colon) as CitableKind;
  const id = ref.slice(colon + 1);
  if (!(CITABLE_KINDS as readonly string[]).includes(kind)) return false;
  if (kind === "case") return id === caseId;
  return (citable[caseId]?.[kind] ?? []).includes(id);
}

const newRows = <T extends { id: string }>(before: readonly T[], after: readonly T[]) => {
  const seen = new Set(before.map((r) => r.id));
  return after.filter((r) => !seen.has(r.id));
};

function rankDetail(ids: readonly string[], capture: PageCapture): string {
  const ranks = ids.map((id) => {
    const entry = capture.entries.find((e) => e.caseId === id);
    return entry ? (entry.rank === null ? "unranked" : `#${entry.rank}`) : "absent";
  });
  return `${ids.length} must-surface Case(s): ${ranks.join(", ") || "none"}`;
}

export function evaluateRankingEvidence(inputs: RankingEvidenceInputs): HostedCheck[] {
  const checks: HostedCheck[] = [];
  const { t0, t1, captures } = inputs;
  const org = captures.organizationWork;
  const mine = captures.myWork;
  const floor = stableMustSurface(t0, t1);
  const assignedToAdvisor = new Set(
    t1.cases.filter((c) => c.assigned_to_user_id === inputs.advisorUserId).map((c) => c.id)
  );
  const pilotCaseIds = new Set(t1.cases.map((c) => c.id));

  // ── Preconditions the rest depends on, checked rather than assumed.
  checks.push(
    check(
      "setup",
      "Relationship Operations and the contextual ranking are enabled for the pilot at T0 and T1",
      t0.flags.relationshipOps && t0.flags.contextualRanking && t1.flags.relationshipOps && t1.flags.contextualRanking
    )
  );
  checks.push(
    check(
      "setup",
      "the pilot holds a must-surface Case at both checkpoints, so the floor is exercised",
      floor.length > 0,
      `${floor.length} stable must-surface Case(s)`
    )
  );

  // ── Obligation 1: ranked by the pass, each shown claim grounded.
  checks.push(
    check(
      "RS2-1",
      "the advisor's Organization Work is in Gu's order: the ranking pass ran and ranked",
      org.view === "org" && org.rankingStatus === "ranked",
      `view=${String(org.view)} status=${String(org.rankingStatus)}`
    )
  );
  const contextual = [...org.entries, ...mine.entries].filter((e) => e.kind === "contextual");
  const shownContextual = org.entries.filter((e) => e.kind === "contextual" && e.section === "needs_attention" && e.visible);
  checks.push(
    check(
      "RS2-1",
      "Needs Attention shows at least one contextual item, so grounding is exercised",
      shownContextual.length > 0,
      `${shownContextual.length} contextual item(s) shown`
    )
  );
  const refsChecked = contextual.flatMap((e) => e.claimRefs.map((ref) => ({ ref, caseId: e.caseId })));
  const ungrounded = refsChecked.filter(({ ref, caseId }) => !citesOwnCase(ref, caseId, t1.citable));
  const bare = contextual.filter((e) => e.claimRefs.length === 0);
  checks.push(
    check(
      "RS2-1",
      "every claim shown cites only rows of its own Case",
      contextual.length > 0 && bare.length === 0 && ungrounded.length === 0,
      `${refsChecked.length} ref(s) on ${contextual.length} card(s); ${ungrounded.length} not the Case's own; ${bare.length} card(s) citing nothing`
    )
  );
  const misplaced = contextual.filter((e) => e.predicates.length > 0 || floor.includes(e.caseId));
  checks.push(
    check(
      "RS2-1",
      "a contextual item never sits on a governed Case, and never carries a predicate",
      misplaced.length === 0,
      `${misplaced.length} misplaced`
    )
  );

  // ── Obligation 2: the governed floor, whatever the rank.
  const orgMissing = floor.filter((id) => {
    const entry = org.entries.find((e) => e.caseId === id);
    return !entry || entry.section !== "needs_attention" || entry.kind !== "governed" || !entry.visible || entry.predicates.length === 0;
  });
  checks.push(
    check(
      "RS2-2",
      "every must-surface Case is in Organization Work's Needs Attention, visible and governed, whatever its rank",
      floor.length > 0 && orgMissing.length === 0,
      `${rankDetail(floor, org)}; missing ${orgMissing.length}`
    )
  );
  const mineFloor = floor.filter((id) => assignedToAdvisor.has(id));
  const mineMissing = mineFloor.filter((id) => {
    const entry = mine.entries.find((e) => e.caseId === id);
    return !entry || entry.section !== "needs_attention" || entry.kind !== "governed" || !entry.visible;
  });
  checks.push(
    check(
      "RS2-2",
      "every must-surface Case assigned to the advisor is in My Work's Needs Attention too",
      mine.view === "mine" && mineMissing.length === 0,
      `${mineFloor.length} assigned to the advisor; missing ${mineMissing.length}`
    )
  );

  // ── Obligation 3: the model call, correlated.
  const usage = newRows(t0.rankingUsage, t1.rankingUsage);
  const uncorrelated = usage.filter(
    (u) => u.organization_id !== inputs.organizationId || u.user_id !== inputs.advisorUserId || u.channel !== "web"
  );
  checks.push(
    check(
      "RS2-3",
      "the ranking call's AI usage is recorded, correlated to the pilot Organization and the advisor, on the web channel",
      usage.some((u) => u.status === "ok") && uncorrelated.length === 0,
      `${usage.length} ranking call(s) in the session, ${usage.filter((u) => u.status === "ok").length} ok, ${uncorrelated.length} uncorrelated`
    )
  );

  // ── Obligation 4: the chat reads the same projection; a cross-user attempt fails.
  const calls = newRows(t0.portfolioToolCalls, t1.portfolioToolCalls).filter(
    (c) => c.status === "executed" && c.toolStatus === "ok" && c.readStatus === "ok"
  );
  const call = calls[calls.length - 1];
  checks.push(
    check(
      "RS2-4",
      "the advisor's web chat read the Portfolio through work_portfolio_read, successfully",
      Boolean(call),
      `${calls.length} successful call(s) in the session`
    )
  );
  const expectedGoverned = floor.filter((id) => (call?.view === "mine" ? assignedToAdvisor.has(id) : true));
  const chatGoverned = [...new Set((call?.needs ?? []).filter((n) => n.kind === "governed").map((n) => n.case_id))].sort();
  checks.push(
    check(
      "RS2-4",
      "the chat read is the page's projection: its governed Cases are exactly the must-surface Cases of the view it read",
      Boolean(call) && JSON.stringify(chatGoverned) === JSON.stringify(expectedGoverned),
      call ? `view=${call.view}; governed ${chatGoverned.length}, expected ${expectedGoverned.length}` : "no call"
    )
  );
  const chatIds = call ? [...call.needs.map((n) => n.case_id), ...call.others] : [];
  const foreign = chatIds.filter((id) => !pilotCaseIds.has(id) || inputs.otherOrganizationCaseIds.includes(id));
  checks.push(
    check(
      "RS2-4",
      "the chat read holds only the pilot's Cases, none of another Organization",
      Boolean(call) && chatIds.length > 0 && foreign.length === 0,
      `${chatIds.length} Case(s) read, ${foreign.length} foreign`
    )
  );
  checks.push(
    check(
      "RS2-4",
      "the chat question has a captured answer",
      captures.chatAnswer.trim().length > 0
    )
  );
  const orgRead = inputs.probe?.reads.find((r) => r.target === "other_organization_cases");
  const userRead = inputs.probe?.reads.find((r) => r.target === "other_user_presentation");
  checks.push(
    check(
      "RS2-4",
      "with the advisor's own session, a read of another Organization's Cases returns nothing (cross-user attempt)",
      inputs.probe?.attempted === true &&
        inputs.otherOrganizationCaseIds.length > 0 &&
        Boolean(orgRead) &&
        orgRead!.rows === 0,
      inputs.otherOrganizationCaseIds.length === 0
        ? "no other-Organization Case exists — the attempt is not exercised"
        : orgRead
          ? `status=${orgRead.status} rows=${orgRead.rows}; ${inputs.otherOrganizationCaseIds.length} exist`
          : "no probe recorded"
    )
  );
  checks.push(
    check(
      "RS2-4",
      "with the advisor's own session, a read of another user's presentation state returns nothing",
      inputs.probe?.attempted === true && Boolean(userRead) && userRead!.rows === 0,
      userRead
        ? `status=${userRead.status} rows=${userRead.rows}; ${inputs.otherUserPresentationRows} such row(s) exist${inputs.otherUserPresentationRows === 0 ? " — vacuous" : ""}`
        : "no probe recorded"
    )
  );

  // ── Boundaries of the run.
  const moved = CONTAINMENT_TABLES.filter((t) => t0.containment[t]?.digest !== t1.containment[t]?.digest);
  checks.push(
    check(
      "boundary",
      "no business or configuration row changed during the session: the ranking persisted nothing and no authority moved",
      moved.length === 0,
      moved.join(",") || `${CONTAINMENT_TABLES.length} tables identical`
    )
  );
  return checks;
}

export function allPassed(checks: readonly HostedCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.ok);
}

/** The capture script: run inside the advisor's page; reads the DOM only. */
export const CAPTURE_SNIPPET = `(() => {
  const root = document.querySelector("[data-ranking-status]");
  const entries = [...document.querySelectorAll("[data-portfolio-entry]")].map((el) => ({
    caseId: el.getAttribute("data-case-id"),
    section: el.getAttribute("data-section"),
    kind: el.getAttribute("data-kind"),
    rank: el.getAttribute("data-rank") ? Number(el.getAttribute("data-rank")) : null,
    visible: el.getAttribute("data-visible") === "true",
    predicates: [...el.querySelectorAll("[data-predicate]")].map((p) => p.getAttribute("data-predicate")),
    claimRefs: [...el.querySelectorAll("[data-claim-ref]")].map((r) => r.getAttribute("data-claim-ref")),
  }));
  return JSON.stringify({ view: root ? root.getAttribute("data-portfolio-view") : null, rankingStatus: root ? root.getAttribute("data-ranking-status") : null, entries });
})()`;

/** Digest of a capture, for the artifact: it binds the evidence to what was read. */
export function captureDigest(capture: PageCapture | string): string {
  return digestRows([{ capture: typeof capture === "string" ? capture : JSON.stringify(capture) } as Row]);
}
