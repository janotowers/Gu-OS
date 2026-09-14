// Hosted-evidence evaluation for R1 SL-7, the Work Portfolio v1.
//
// Split out of `verify-portfolio.ts` for the same reason every R1 verifier
// splits its evaluator: the part of the hosted run that decides pass/fail is
// pure, so it is unit-tested without a hosted environment. The runner keeps
// the I/O — resolving the target, seeding the one controlled Case, taking
// read-only checkpoints, reading the page captures.
//
// WHAT THE RS-2 PROTOCOL ASKS (Slice Plan SL-7, "RS-2 hosted protocol — fixed
// before implementation, 2026-09-13"), each pass or fail:
//
//   1. the seeded Case appears in the advisor's My Work and in Organization
//      Work; a Case of another Organization appears in neither; an attempt to
//      write another user's presentation state is refused;
//   2. the seeded must-surface item stays visible after the advisor snoozes
//      and hides it, its presentation-state row exists, and no business row
//      changed;
//   3. completing the seeded human-ask Work Item from the Portfolio changes
//      exactly the expected canonical rows, creates no Portfolio-only business
//      state, and the need exits.
//
// Evidence: digests only, with before/after fingerprints of everything outside
// the seeded Case to prove containment. SL-4's evidence Cases are never
// written, no authority changes, and no hosted positive case is claimed for
// `stalled` or for the three predicates without a producer.
//
// The rule every R1 verifier inherits: an assertion must test what its label
// says. "the page rendered" does not prove "the Case appears in My Work"; "no
// error was thrown" does not prove "exactly these rows changed".

import { createHash } from "node:crypto";

export interface HostedCheck {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export type Row = Record<string, unknown>;

/** Tables whose rows of the seeded Case are captured in full at each checkpoint. */
export const SEEDED_TABLES = [
  "operational_cases",
  "case_facts",
  "case_subjects",
  "operational_case_events",
  "case_approvals",
  "work_items",
  "work_item_attempts",
  "work_item_events",
  "internal_user_notifications",
] as const;

export type SeededTable = (typeof SEEDED_TABLES)[number];

/** Tables fingerprinted OUTSIDE the seeded Case — the containment surface. */
export const OUTSIDE_TABLES = [
  ...SEEDED_TABLES,
  "case_subject_external_refs",
  "case_relationships",
  "portfolio_presentation_state",
  "organizations",
  "organization_memberships",
  "organization_feature_flags",
  "ai_usage_events",
] as const;

export type OutsideTable = (typeof OUTSIDE_TABLES)[number];

export interface Fingerprint {
  rows: number;
  digest: string;
}

export interface PortfolioCheckpoint {
  label: string;
  /** This process's clock — ordering only, never evidence of elapsed time. */
  takenAt: string;
  seededCaseId: string;
  /** Every row of the seeded Case, per table, in full. */
  seeded: Record<SeededTable, Row[]>;
  /** Digest of every row NOT belonging to the seeded Case, per table. */
  outside: Record<OutsideTable, Fingerprint>;
  /** Every presentation row of the seeded Case (the advisor's, once written). */
  presentation: Row[];
}

/** What the pure projection says about the seeded Case at a checkpoint. */
export interface ProjectedSeed {
  predicates: string[];
  visible: boolean;
  exemptBecauseMustSurface: boolean;
  userSuppression: "hidden" | "snoozed" | null;
}

export interface PortfolioEvidenceInputs {
  organizationId: string;
  seededCaseId: string;
  advisorUserId: string;
  askWorkItemId: string;
  t0: PortfolioCheckpoint;
  t1: PortfolioCheckpoint;
  t2: PortfolioCheckpoint;
  projected: { t1: ProjectedSeed; t2: ProjectedSeed };
  /** Text of the advisor's own authenticated pages, as rendered. */
  captures: {
    myWork: string;
    organizationWork: string;
    afterSuppress: string;
    afterComplete: string;
  };
  /** Ids of Cases owned by any OTHER Organization in the environment. */
  otherOrganizationCaseIds: string[];
  /** The advisor's own attempt to write another user's presentation state. */
  probe: { attempted: boolean; refused: boolean; code: string | null } | null;
}

// ============================================================
// Digests
// ============================================================

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Row).sort()) out[key] = canonical((value as Row)[key]);
    return out;
  }
  return value;
}

/** Stable digest of a row set: independent of row and key order. */
export function digestRows(rows: readonly Row[]): string {
  const lines = rows
    .map((row) => JSON.stringify(canonical(row)))
    .sort();
  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

export function fingerprint(rows: readonly Row[]): Fingerprint {
  return { rows: rows.length, digest: digestRows(rows) };
}

/** Rows added, removed and changed between two captures of one table, by id. */
export function diffRows(before: readonly Row[], after: readonly Row[]) {
  const byId = (rows: readonly Row[]) => new Map(rows.map((r) => [String(r.id), r]));
  const a = byId(before);
  const b = byId(after);
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [...b.keys()].filter(
    (id) => a.has(id) && JSON.stringify(canonical(a.get(id))) !== JSON.stringify(canonical(b.get(id)))
  );
  return { added, removed, changed };
}

function check(assertion: string, label: string, ok: boolean, detail?: string): HostedCheck {
  return { assertion, label, ok, ...(detail ? { detail } : {}) };
}

function sameSeeded(a: PortfolioCheckpoint, b: PortfolioCheckpoint, tables: readonly SeededTable[]) {
  const moved = tables.filter((t) => digestRows(a.seeded[t]) !== digestRows(b.seeded[t]));
  return { ok: moved.length === 0, moved };
}

function sameOutside(a: PortfolioCheckpoint, b: PortfolioCheckpoint) {
  const moved = OUTSIDE_TABLES.filter((t) => a.outside[t]?.digest !== b.outside[t]?.digest);
  return { ok: moved.length === 0, moved };
}

const field = (row: Row | undefined, key: string): unknown => (row ? row[key] : undefined);

// ============================================================
// The three pass criteria
// ============================================================

export function evaluatePortfolioEvidence(inputs: PortfolioEvidenceInputs): HostedCheck[] {
  const checks: HostedCheck[] = [];
  const { seededCaseId: caseId, t0, t1, t2, captures } = inputs;

  // ── Preconditions the rest depends on, checked rather than assumed.
  const seededCase = t0.seeded.operational_cases[0];
  checks.push(
    check(
      "setup",
      "the seeded Case is an Organization Case of the pilot, assigned to the advisor, under legacy authority",
      t0.seeded.operational_cases.length === 1 &&
        field(seededCase, "organization_id") === inputs.organizationId &&
        field(seededCase, "assigned_to_user_id") === inputs.advisorUserId &&
        field(seededCase, "runtime_authority") === "legacy",
      `runtime_authority=${String(field(seededCase, "runtime_authority"))}`
    )
  );
  const ask = t0.seeded.work_items.find((w) => w.id === inputs.askWorkItemId);
  checks.push(
    check(
      "setup",
      "the seeded human ask is open Work proposed by a waiting_for_human_input settlement",
      Boolean(ask) &&
        field(ask, "status") === "todo" &&
        t0.seeded.operational_case_events.some((e) => {
          const p = (e.payload_jsonb ?? {}) as Row;
          return (
            p.kind === "supervisor_reconsideration_settled" &&
            p.yield_posture === "waiting_for_human_input" &&
            Array.isArray(p.proposed_work_ids) &&
            (p.proposed_work_ids as unknown[]).includes(inputs.askWorkItemId)
          );
        })
    )
  );

  // ── Criterion 1: visibility and authorization in the advisor's session.
  checks.push(
    check("RS2-1", "the seeded Case appears in the advisor's My Work", captures.myWork.includes(caseId))
  );
  checks.push(
    check(
      "RS2-1",
      "the seeded Case appears in the advisor's Organization Work",
      captures.organizationWork.includes(caseId)
    )
  );
  const leaked = inputs.otherOrganizationCaseIds.filter(
    (id) => captures.myWork.includes(id) || captures.organizationWork.includes(id)
  );
  checks.push(
    check(
      "RS2-1",
      "a Case of another Organization appears in neither",
      inputs.otherOrganizationCaseIds.length > 0 && leaked.length === 0,
      inputs.otherOrganizationCaseIds.length === 0
        ? "no other-Organization Case exists — the negative is not exercised"
        : `${inputs.otherOrganizationCaseIds.length} other-Organization Case(s) checked, ${leaked.length} visible`
    )
  );
  checks.push(
    check(
      "RS2-1",
      "an attempt to write another user's presentation state is refused",
      inputs.probe?.attempted === true && inputs.probe.refused === true,
      inputs.probe ? `code=${inputs.probe.code ?? "none"}` : "no probe recorded"
    )
  );

  // ── Criterion 2: the governed item survives snooze + hide; nothing business moved.
  const advisorRow = t1.presentation.find(
    (r) => r.user_id === inputs.advisorUserId && r.subject_id === caseId && r.subject_kind === "case"
  );
  checks.push(
    check(
      "RS2-2",
      "the advisor's presentation-state row exists, snoozed and hidden",
      Boolean(advisorRow) && field(advisorRow, "snooze_until") != null && field(advisorRow, "hidden_at") != null
    )
  );
  checks.push(
    check(
      "RS2-2",
      "the seeded must-surface items stay in the projection with that presentation applied",
      inputs.projected.t1.predicates.includes("blocked_on_human") &&
        inputs.projected.t1.predicates.includes("due_commitment") &&
        inputs.projected.t1.visible &&
        inputs.projected.t1.exemptBecauseMustSurface &&
        inputs.projected.t1.userSuppression === "hidden",
      `predicates=${inputs.projected.t1.predicates.join(",")}`
    )
  );
  checks.push(
    check(
      "RS2-2",
      "the advisor's page still lists the seeded Case after snoozing and hiding it",
      captures.afterSuppress.includes(caseId)
    )
  );
  const businessT0T1 = sameSeeded(t0, t1, SEEDED_TABLES);
  checks.push(
    check(
      "RS2-2",
      "no business row of the seeded Case changed between T0 and T1",
      businessT0T1.ok,
      businessT0T1.moved.join(",") || "all seeded tables identical"
    )
  );
  const outsideT0T1 = sameOutside(t0, t1);
  checks.push(
    check(
      "RS2-2",
      "nothing outside the seeded Case changed between T0 and T1",
      outsideT0T1.ok,
      outsideT0T1.moved.join(",") || `${OUTSIDE_TABLES.length} tables identical`
    )
  );

  // ── Criterion 3: completing the ask moves exactly the Work Plane rows.
  const workDiff = diffRows(t1.seeded.work_items, t2.seeded.work_items);
  const askAfter = t2.seeded.work_items.find((w) => w.id === inputs.askWorkItemId);
  const answer = ((askAfter?.result_jsonb ?? {}) as Row).human_answer as Row | undefined;
  checks.push(
    check(
      "RS2-3",
      "work_items: only the ask changed, to done, answered by the advisor",
      workDiff.added.length === 0 &&
        workDiff.removed.length === 0 &&
        workDiff.changed.length === 1 &&
        workDiff.changed[0] === inputs.askWorkItemId &&
        field(askAfter, "status") === "done" &&
        field(answer, "answered_by") === inputs.advisorUserId &&
        typeof field(answer, "text") === "string" &&
        String(field(answer, "text")).trim() !== "",
      `changed=${workDiff.changed.length} added=${workDiff.added.length} status=${String(field(askAfter, "status"))}`
    )
  );
  const attemptDiff = diffRows(t1.seeded.work_item_attempts, t2.seeded.work_item_attempts);
  const attempt = t2.seeded.work_item_attempts.find((a) => a.id === attemptDiff.added[0]);
  checks.push(
    check(
      "RS2-3",
      "work_item_attempts: exactly one new attempt, by a human executor, succeeded",
      attemptDiff.added.length === 1 &&
        attemptDiff.changed.length === 0 &&
        attemptDiff.removed.length === 0 &&
        field(attempt, "work_item_id") === inputs.askWorkItemId &&
        field(attempt, "executor_kind") === "human" &&
        field(attempt, "status") === "succeeded"
    )
  );
  const eventDiff = diffRows(t1.seeded.work_item_events, t2.seeded.work_item_events);
  const newEvents = t2.seeded.work_item_events
    .filter((e) => eventDiff.added.includes(String(e.id)))
    .map((e) => String(e.event_type))
    .sort();
  checks.push(
    check(
      "RS2-3",
      "work_item_events: exactly ready, claimed and done were appended for the ask",
      eventDiff.changed.length === 0 &&
        eventDiff.removed.length === 0 &&
        JSON.stringify(newEvents) === JSON.stringify(["claimed", "done", "ready"]),
      `appended=${newEvents.join(",")}`
    )
  );
  const otherSeeded = sameSeeded(t1, t2, [
    "operational_cases",
    "case_facts",
    "case_subjects",
    "operational_case_events",
    "case_approvals",
    "internal_user_notifications",
  ]);
  checks.push(
    check(
      "RS2-3",
      "no other row of the seeded Case changed: Case, facts, subjects, timeline, approvals, notifications",
      otherSeeded.ok,
      otherSeeded.moved.join(",") || "identical"
    )
  );
  const outsideT1T2 = sameOutside(t1, t2);
  const presentationT1T2 = digestRows(t1.presentation) === digestRows(t2.presentation);
  checks.push(
    check(
      "RS2-3",
      "no Portfolio-only business state: nothing outside the seeded Case and no presentation row changed",
      outsideT1T2.ok && presentationT1T2,
      outsideT1T2.moved.join(",") || (presentationT1T2 ? "identical" : "presentation changed")
    )
  );
  checks.push(
    check(
      "RS2-3",
      "the need exits: the ask is no longer a must-surface item; the due commitment still is",
      !inputs.projected.t2.predicates.includes("blocked_on_human") &&
        inputs.projected.t2.predicates.includes("due_commitment"),
      `predicates=${inputs.projected.t2.predicates.join(",") || "none"}`
    )
  );

  // ── Boundaries of the run.
  const authorityHeld = [t0, t1, t2].every(
    (cp) => field(cp.seeded.operational_cases[0], "runtime_authority") === "legacy"
  );
  const outsideT0T2 = sameOutside(t0, t2);
  checks.push(
    check(
      "boundary",
      "no authority change and no write outside the seeded Case across the whole session (T0 → T2)",
      authorityHeld && outsideT0T2.ok,
      outsideT0T2.moved.join(",") || "containment held"
    )
  );
  return checks;
}

export function allPassed(checks: readonly HostedCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.ok);
}
