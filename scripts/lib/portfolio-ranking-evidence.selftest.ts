// Selftest for the SL-12 RS-2 evaluator. Every check is shown to PASS on an
// honest session and to FAIL when the thing its label names is not true — an
// evaluator that cannot fail is not evidence of anything.

import assert from "node:assert/strict";
import {
  allPassed,
  CONTAINMENT_TABLES,
  evaluateRankingEvidence,
  fingerprint,
  type ContainmentTable,
  type PageCapture,
  type RankingCheckpoint,
  type RankingEvidenceInputs,
} from "./portfolio-ranking-evidence";

const ORG = "org-pilot";
const ADVISOR = "user-advisor";
const G = "case-governed"; // must-surface, assigned to the advisor
const X = "case-contextual"; // admitted contextually
const Q = "case-quiet";

let passed = 0;
function t(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function checkpoint(label: string, extra: Partial<RankingCheckpoint> = {}): RankingCheckpoint {
  const containment = {} as Record<ContainmentTable, ReturnType<typeof fingerprint>>;
  for (const table of CONTAINMENT_TABLES) containment[table] = fingerprint([{ id: `${table}-1` }]);
  return {
    label,
    takenAt: label === "t0" ? "2026-09-15T15:00:00.000Z" : "2026-09-15T15:30:00.000Z",
    flags: { relationshipOps: true, contextualRanking: true },
    cases: [
      { id: G, assigned_to_user_id: ADVISOR, runtime_authority: "legacy" },
      { id: X, assigned_to_user_id: ADVISOR, runtime_authority: "legacy" },
      { id: Q, assigned_to_user_id: "user-other", runtime_authority: "legacy" },
    ],
    citable: {
      [G]: { case: [G], case_fact: ["fact-g"] },
      [X]: { case: [X], case_fact: ["fact-x"], case_event: ["event-x"] },
      [Q]: { case: [Q], work_item: ["work-q"] },
    },
    mustSurface: { [G]: ["due_commitment"], [X]: [], [Q]: [] },
    containment,
    rankingUsage: [],
    portfolioToolCalls: [],
    ...extra,
  };
}

const capture = (view: "org" | "mine", entries: PageCapture["entries"]): PageCapture => ({
  view,
  rankingStatus: "ranked",
  entries,
});

const governedEntry = (rank: number | null = 2) => ({
  caseId: G,
  section: "needs_attention",
  kind: "governed",
  rank,
  visible: true,
  predicates: ["due_commitment"],
  claimRefs: [],
});
const contextualEntry = (claimRefs = [`case:${X}`, "case_fact:fact-x", "case_event:event-x"]) => ({
  caseId: X,
  section: "needs_attention",
  kind: "contextual",
  rank: 1,
  visible: true,
  predicates: [],
  claimRefs,
});
const quietEntry = { caseId: Q, section: "gu_handling", kind: "none", rank: null, visible: true, predicates: [], claimRefs: [] };

function honest(): RankingEvidenceInputs {
  const t0 = checkpoint("t0");
  const t1 = checkpoint("t1", {
    rankingUsage: [
      { id: "usage-1", occurred_at: "2026-09-15T15:10:00.000Z", organization_id: ORG, user_id: ADVISOR, channel: "web", status: "ok", model_role: "relationship_portfolio_ranking" },
    ],
    portfolioToolCalls: [
      {
        id: "call-1",
        created_at: "2026-09-15T15:20:00.000Z",
        status: "executed",
        view: "organization",
        toolStatus: "ok",
        readStatus: "ok",
        needs: [
          { case_id: X, kind: "contextual" },
          { case_id: G, kind: "governed" },
        ],
        others: [Q],
      },
    ],
  });
  return {
    organizationId: ORG,
    advisorUserId: ADVISOR,
    t0,
    t1,
    captures: {
      organizationWork: capture("org", [contextualEntry(), governedEntry(), quietEntry]),
      myWork: capture("mine", [contextualEntry(), governedEntry()]),
      chatAnswer: "Hoy te necesitan dos Casos: …",
    },
    otherOrganizationCaseIds: ["case-other-org"],
    otherUserPresentationRows: 1,
    probe: {
      attempted: true,
      how: "in the advisor's page",
      reads: [
        { target: "other_organization_cases", status: 200, rows: 0 },
        { target: "other_user_presentation", status: 200, rows: 0 },
      ],
    },
  };
}

function failing(inputs: RankingEvidenceInputs, labelPart: string): void {
  const checks = evaluateRankingEvidence(inputs);
  const target = checks.filter((c) => c.label.includes(labelPart));
  assert.ok(target.length > 0, `no check labelled "${labelPart}"`);
  assert.ok(target.some((c) => !c.ok), `"${labelPart}" should fail`);
  assert.equal(allPassed(checks), false);
}

function main(): void {
  console.log("portfolio-ranking-evidence selftest (R1 SL-12 RS-2)");

  t("an honest session passes every check", () => {
    const checks = evaluateRankingEvidence(honest());
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail ?? ""}`);
    assert.deepEqual(failed, []);
    assert.ok(checks.length >= 15);
  });

  t("setup: the ranking off at either checkpoint fails", () => {
    const i = honest();
    i.t1.flags.contextualRanking = false;
    failing(i, "contextual ranking are enabled");
  });

  t("setup: no must-surface Case means the floor is not exercised — fails", () => {
    const i = honest();
    i.t0.mustSurface = { [G]: [], [X]: [], [Q]: [] };
    failing(i, "floor is exercised");
  });

  t("RS2-1: a page in the deterministic order is not 'ranked by the pass'", () => {
    const i = honest();
    i.captures.organizationWork.rankingStatus = "timeout";
    failing(i, "ranking pass ran and ranked");
  });

  t("RS2-1: no contextual item shown — grounding would be vacuous, so it fails", () => {
    const i = honest();
    i.captures.organizationWork.entries = [governedEntry(), quietEntry];
    i.captures.myWork.entries = [governedEntry()];
    failing(i, "at least one contextual item");
  });

  t("RS2-1: a claim citing ANOTHER Case's row, an unknown row, a foreign kind, or nothing — each fails", () => {
    for (const refs of [["case_fact:fact-g"], ["case_fact:fact-nope"], ["authority_resolution:x"], [`case:${G}`], []]) {
      const i = honest();
      i.captures.organizationWork.entries = [contextualEntry(refs), governedEntry(), quietEntry];
      failing(i, "cites only rows of its own Case");
    }
  });

  t("RS2-1: a contextual card on a governed Case, or carrying a predicate, fails", () => {
    const i = honest();
    i.captures.organizationWork.entries.push({ ...contextualEntry([`case:${G}`]), caseId: G });
    failing(i, "never sits on a governed Case");
  });

  t("RS2-2: a must-surface Case missing, hidden, or shown outside Needs Attention fails", () => {
    for (const mutate of [
      (e: PageCapture["entries"]) => e.filter((x) => x.caseId !== G),
      (e: PageCapture["entries"]) => e.map((x) => (x.caseId === G ? { ...x, visible: false } : x)),
      (e: PageCapture["entries"]) => e.map((x) => (x.caseId === G ? { ...x, section: "waiting" } : x)),
    ]) {
      const i = honest();
      i.captures.organizationWork.entries = mutate(i.captures.organizationWork.entries);
      failing(i, "every must-surface Case is in Organization Work");
    }
  });

  t("RS2-2: whatever its rank — an unranked governed Case still passes", () => {
    const i = honest();
    i.captures.organizationWork.entries = [contextualEntry(), governedEntry(null), quietEntry];
    assert.equal(allPassed(evaluateRankingEvidence(i)), true);
  });

  t("RS2-2: a must-surface Case assigned to the advisor missing from My Work fails", () => {
    const i = honest();
    i.captures.myWork.entries = [contextualEntry()];
    failing(i, "assigned to the advisor is in My Work");
  });

  t("RS2-3: no ranking call, only failed calls, or a call correlated elsewhere — each fails", () => {
    const base = honest().t1.rankingUsage[0];
    for (const usage of [[], [{ ...base, status: "error" }], [{ ...base, organization_id: "org-other" }], [base, { ...base, id: "usage-2", channel: "cron" }]]) {
      const i = honest();
      i.t1.rankingUsage = usage;
      failing(i, "AI usage is recorded, correlated");
    }
  });

  t("RS2-3: usage rows already present at T0 are not the session's", () => {
    const i = honest();
    i.t0.rankingUsage = [...i.t1.rankingUsage];
    failing(i, "AI usage is recorded, correlated");
  });

  t("RS2-4: no successful work_portfolio_read in the session fails", () => {
    for (const change of [{ status: "failed" }, { readStatus: "inert" }, { toolStatus: "no_user_session" }]) {
      const i = honest();
      i.t1.portfolioToolCalls = [{ ...i.t1.portfolioToolCalls[0], ...change }];
      failing(i, "read the Portfolio through work_portfolio_read");
    }
  });

  t("RS2-4: a chat read whose governed Cases differ from the must-surface set fails", () => {
    for (const needs of [[{ case_id: X, kind: "contextual" }], [{ case_id: G, kind: "governed" }, { case_id: X, kind: "governed" }]]) {
      const i = honest();
      i.t1.portfolioToolCalls = [{ ...i.t1.portfolioToolCalls[0], needs }];
      failing(i, "the chat read is the page's projection");
    }
  });

  t("RS2-4: My Work's read expects only the advisor's must-surface Cases", () => {
    const i = honest();
    i.t1.mustSurface = { ...i.t1.mustSurface, [Q]: ["due_commitment"] };
    i.t0.mustSurface = { ...i.t0.mustSurface, [Q]: ["due_commitment"] };
    i.captures.organizationWork.entries = [contextualEntry(), governedEntry(), { ...governedEntry(3), caseId: Q }];
    i.t1.portfolioToolCalls = [{ ...i.t1.portfolioToolCalls[0], view: "mine", others: [] }];
    assert.equal(allPassed(evaluateRankingEvidence(i)), true, "Q is not the advisor's, so My Work need not hold it");
  });

  t("RS2-4: a Case of another Organization, or outside the pilot, in the chat read fails", () => {
    for (const others of [["case-other-org"], ["case-nowhere"]]) {
      const i = honest();
      i.t1.portfolioToolCalls = [{ ...i.t1.portfolioToolCalls[0], others }];
      failing(i, "holds only the pilot's Cases");
    }
  });

  t("RS2-4: an empty chat answer fails", () => {
    const i = honest();
    i.captures.chatAnswer = "   ";
    failing(i, "captured answer");
  });

  t("RS2-4: the cross-user read returning rows, unexercised, or not recorded — each fails", () => {
    const leaked = honest();
    leaked.probe!.reads[0] = { target: "other_organization_cases", status: 200, rows: 1 };
    failing(leaked, "another Organization's Cases returns nothing");
    const vacuous = honest();
    vacuous.otherOrganizationCaseIds = [];
    failing(vacuous, "another Organization's Cases returns nothing");
    const absent = honest();
    absent.probe = null;
    failing(absent, "another Organization's Cases returns nothing");
    const presentation = honest();
    presentation.probe!.reads[1] = { target: "other_user_presentation", status: 200, rows: 2 };
    failing(presentation, "another user's presentation state returns nothing");
  });

  t("boundary: any business or configuration row changing during the session fails", () => {
    for (const table of ["case_facts", "work_items", "portfolio_presentation_state", "organization_feature_flags"] as const) {
      const i = honest();
      i.t1.containment = { ...i.t1.containment, [table]: fingerprint([{ id: "changed" }]) };
      failing(i, "no business or configuration row changed");
    }
  });

  console.log(`portfolio-ranking-evidence selftest ok — ${passed} checks passed`);
}

main();
