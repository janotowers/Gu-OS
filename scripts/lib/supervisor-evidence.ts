// Hosted-evidence evaluation for R1 SL-4, the Case Supervisor loop (shadow).
//
// Split out of `verify-supervisor.ts` for the same reason SL-2 split
// `admission-evidence.ts` and SL-3 split `resolution-evidence.ts`: everything
// here is pure, so the part of the hosted run that actually decides pass/fail
// is unit-testable without a hosted environment. What stays in the runner is
// I/O — resolving the target, seeding the controlled Opportunity, running a
// reconsideration, reading rows back, writing evidence.
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT
//
// SA-4.3 says "across multiple days". A verifier that accepted three
// reconsiderations recorded within the same minute — or worse, three rows whose
// timestamps were written by the verifier itself — would report a multi-day
// posture history that never happened. So the day count is computed from the
// DATABASE's own `created_at` values, in UTC, and a run whose reconsiderations
// share a day fails the assertion rather than passing it with a caveat. That is
// why this verifier is resumable across days instead of being a single script
// that could quietly fake elapsed time.
//
// The rule inherited from SL-2 and SL-3 still governs every check: an assertion
// must test what its label says. "a posture was recorded" does not prove "the
// history is coherent and ordered"; "the reconsideration ran" does not prove
// "it is reconstructable from durable state alone".

export interface HostedCheck {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/** One reconsideration as the hosted timeline holds it. */
export interface HostedReconsiderationRow {
  /** `operational_case_events.created_at` — the DATABASE's clock, not ours. */
  created_at: string;
  case_id: string;
  payload: {
    kind?: string;
    v?: number;
    wake_key?: string;
    wake_reason?: string;
    posture?: string;
    yield_posture?: string;
    rationale?: string;
    diagnosis?: string | null;
    uncertainty?: string | null;
    next_action_at?: string | null;
    stage?: string;
    model_id?: string | null;
    [key: string]: unknown;
  };
}

/** One settlement row, matched to its claim by `wake_key`. */
export interface HostedSettlementRow {
  created_at: string;
  case_id: string;
  payload: {
    kind?: string;
    wake_key?: string;
    yield_posture?: string;
    proposed_work_ids?: string[];
    commitment_subject_ids?: string[];
    [key: string]: unknown;
  };
}

export interface HostedSubjectRow {
  id: string;
  case_id: string;
  subject_kind: string;
  attrs_jsonb: Record<string, unknown>;
}

export interface HostedFactRow {
  id: string;
  case_id: string;
  fact_key: string;
  subject_id: string | null;
  superseded_by: string | null;
  value_jsonb: unknown;
}

export interface HostedWorkRow {
  id: string;
  case_id: string;
  work_type: string;
  origin: string;
  status: string;
}

/** The Case row, read back to prove the shadow constraint held. */
export interface HostedCaseRow {
  id: string;
  organization_id: string | null;
  case_type: string;
  status: string;
  next_action_at: string | null;
  runtime_authority: string | null;
}

export interface HostedSupervisorInputs {
  /** The controlled Opportunity Cases this run supervised. */
  cases: readonly HostedCaseRow[];
  reconsiderations: readonly HostedReconsiderationRow[];
  settlements: readonly HostedSettlementRow[];
  subjects: readonly HostedSubjectRow[];
  facts: readonly HostedFactRow[];
  work: readonly HostedWorkRow[];
  /**
   * What a FRESH read reconstructed, with no session and no memory of the runs
   * that produced it — the SA-4.5 replay. Supplied separately so this evaluator
   * can check that reconstruction agrees with the raw rows rather than assuming
   * it does.
   */
  replay: {
    caseId: string;
    objective: string | null;
    commitmentCount: number;
    postureCount: number;
    waitingOn: string | null;
    nextWakeAt: string | null;
  } | null;
  /** Organization-scoped posture observability, read back from the same rows. */
  observability: {
    total: number;
    noAction: number;
    noActionRatio: number | null;
    distinctDays: number;
  } | null;
  /** The pilot Organization every controlled Case must belong to. */
  organizationId: string;
  /** Minimum distinct UTC days SA-4.3 requires. */
  requiredDistinctDays: number;
}

/**
 * Minimum real hours the first-to-last span must cover, per day required
 * beyond the first.
 *
 * Distinct UTC days are necessary and NOT sufficient, which is worth stating
 * plainly because it is a loophole in the obvious design. The operator running
 * this verifier is at UTC-6, so wakes at 17:59 and 18:01 local fall on two
 * different UTC days four minutes apart — and three such wakes would satisfy a
 * pure day count while covering almost no elapsed time at all. SA-4.3 says
 * "across multiple days" about the Opportunity's life, not about the calendar,
 * so the span is checked too.
 *
 * 20 rather than 24 deliberately: a wake at 09:00 one day and 08:00 the next is
 * a real day apart in every sense that matters, and demanding a full 24 would
 * make the assertion fail for a reason that has nothing to do with what it
 * measures. An **ordinary engineering value** under Methodology §14.1 — it
 * encodes no product or accepted-risk tolerance; the governed requirement is
 * that the days be real, and any value that cannot be gamed to minutes serves
 * it equally.
 */
export const MIN_HOURS_PER_ADDITIONAL_DAY = 20;

/** Distinct UTC calendar days covered by a set of database timestamps. */
export function distinctUtcDays(timestamps: readonly string[]): string[] {
  const days = new Set<string>();
  for (const stamp of timestamps) {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) continue;
    days.add(date.toISOString().slice(0, 10));
  }
  return [...days].sort();
}

function check(
  assertion: string,
  label: string,
  ok: boolean,
  detail?: string
): HostedCheck {
  return { assertion, label, ok, detail };
}

/**
 * Evaluates one hosted SL-4 run.
 *
 * Grouped by the acceptance assertion each check belongs to, so a failure lands
 * somewhere a reader can act on rather than in an undifferentiated list.
 */
export function evaluateHostedSupervisorEvidence(
  input: HostedSupervisorInputs
): HostedCheck[] {
  const checks: HostedCheck[] = [];
  const {
    cases,
    reconsiderations,
    settlements,
    subjects,
    facts,
    work,
    organizationId,
    requiredDistinctDays,
  } = input;

  const caseIds = new Set(cases.map((c) => c.id));
  const settlementByWake = new Map<string, HostedSettlementRow>();
  for (const row of settlements) {
    const key = row.payload.wake_key;
    if (typeof key === "string") settlementByWake.set(key, row);
  }

  // ── SA-4.2 — result and rationale recorded, inspectable per Case
  checks.push(
    check(
      "SA-4.2",
      "every reconsideration carries a posture and a rationale",
      reconsiderations.length > 0 &&
        reconsiderations.every(
          (r) =>
            typeof r.payload.posture === "string" &&
            typeof r.payload.rationale === "string" &&
            r.payload.rationale.trim() !== ""
        ),
      `${reconsiderations.length} reconsideration(s)`
    )
  );
  checks.push(
    check(
      "SA-4.2",
      "every reconsideration is attributable to a named wake",
      reconsiderations.length > 0 &&
        reconsiderations.every(
          (r) =>
            typeof r.payload.wake_key === "string" &&
            r.payload.wake_key !== "" &&
            typeof r.payload.wake_reason === "string"
        )
    )
  );
  checks.push(
    check(
      "SA-4.2",
      "every reconsideration belongs to a controlled Case of the pilot Organization",
      reconsiderations.length > 0 &&
        reconsiderations.every((r) => caseIds.has(r.case_id)) &&
        cases.every((c) => c.organization_id === organizationId)
    )
  );

  // ── SA-4.3 — coherent, ordered, MULTI-DAY posture history
  const byCase = new Map<string, HostedReconsiderationRow[]>();
  for (const row of reconsiderations) {
    const list = byCase.get(row.case_id) ?? [];
    list.push(row);
    byCase.set(row.case_id, list);
  }

  const days = distinctUtcDays(reconsiderations.map((r) => r.created_at));
  checks.push(
    check(
      "SA-4.3",
      `the posture history spans at least ${requiredDistinctDays} distinct UTC days`,
      days.length >= requiredDistinctDays,
      // Named explicitly, because this is the assertion a synthetic run would
      // most easily fake: the days come from the database's own created_at.
      `days observed (from the database clock): ${days.join(", ") || "none"}`
    )
  );

  const stamps = reconsiderations
    .map((r) => new Date(r.created_at).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const spanHours =
    stamps.length >= 2 ? (stamps[stamps.length - 1] - stamps[0]) / 3_600_000 : 0;
  const requiredSpanHours =
    Math.max(0, requiredDistinctDays - 1) * MIN_HOURS_PER_ADDITIONAL_DAY;
  checks.push(
    check(
      "SA-4.3",
      `the first and last reconsideration are at least ${requiredSpanHours}h apart`,
      spanHours >= requiredSpanHours,
      // Distinct days alone are gameable across a UTC boundary — see
      // MIN_HOURS_PER_ADDITIONAL_DAY. This is what makes "multi-day" mean
      // elapsed time rather than three calendar labels.
      `span ${spanHours.toFixed(1)}h across ${stamps.length} reconsideration(s)`
    )
  );

  let orderedEverywhere = true;
  let nonDuplicating = true;
  for (const [, rows] of byCase) {
    const sorted = [...rows].sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].created_at < sorted[i - 1].created_at) orderedEverywhere = false;
    }
    const wakes = new Set(sorted.map((r) => r.payload.wake_key));
    if (wakes.size !== sorted.length) nonDuplicating = false;
  }
  checks.push(
    check(
      "SA-4.3",
      "each Case's reconsiderations are strictly ordered in time",
      orderedEverywhere
    )
  );
  checks.push(
    check(
      "SA-4.3 / SA-4.6",
      "no wake produced two reconsiderations on the same Case",
      nonDuplicating
    )
  );
  checks.push(
    check(
      "SA-4.3",
      "every reconsideration left a re-entry path — none stranded responsibility",
      reconsiderations.length > 0 &&
        reconsiderations.every(
          (r) =>
            typeof r.payload.next_action_at === "string" &&
            r.payload.next_action_at !== ""
        )
    )
  );
  checks.push(
    check(
      "SA-4.3",
      "every reconsideration settled — none was left half-recorded",
      reconsiderations.length > 0 &&
        reconsiderations.every((r) =>
          settlementByWake.has(String(r.payload.wake_key))
        ),
      `${settlementByWake.size} settlement(s) for ${reconsiderations.length} claim(s)`
    )
  );

  // ── SA-4.4 — commitments as subjects with clean, id-free keys
  const commitmentSubjects = subjects.filter(
    (s) => s.subject_kind === "commitment"
  );
  const subjectFacts = facts.filter((f) => f.subject_id !== null);
  const subjectIds = new Set(subjects.map((s) => s.id));

  checks.push(
    check(
      "SA-4.4",
      "every subject-scoped fact points at a subject of its own Case",
      subjectFacts.every(
        (f) =>
          subjectIds.has(f.subject_id as string) &&
          subjects.find((s) => s.id === f.subject_id)?.case_id === f.case_id
      ),
      `${subjectFacts.length} subject-scoped fact(s)`
    )
  );
  checks.push(
    check(
      "SA-4.4",
      "no subject-scoped fact key carries an entity id",
      subjectFacts.every((f) => {
        const parts = f.fact_key.split(".");
        return (
          parts.length === 2 &&
          !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(f.fact_key)
        );
      }),
      subjectFacts.length === 0
        ? "no subject facts in this run"
        : [...new Set(subjectFacts.map((f) => f.fact_key))].join(", ")
    )
  );
  checks.push(
    check(
      "SA-4.4",
      "two commitments never share a current fact row for the same key",
      (() => {
        const current = subjectFacts.filter((f) => f.superseded_by === null);
        const seen = new Set<string>();
        for (const fact of current) {
          const key = `${fact.subject_id}:${fact.fact_key}`;
          if (seen.has(key)) return false;
          seen.add(key);
        }
        return true;
      })(),
      `${commitmentSubjects.length} commitment subject(s)`
    )
  );

  // ── SA-4.8 — shadow inertness, observed rather than assumed
  checks.push(
    check(
      "SA-4.8",
      "every Work Item this Slice created is agent_proposed",
      work.every((w) => w.origin === "agent_proposed"),
      `${work.length} Work Item(s)`
    )
  );
  checks.push(
    check(
      "SA-4.8",
      "no controlled Case acquired runtime authority",
      cases.every((c) => c.runtime_authority === null),
      "ADR-107: shadow acquires no runtime or conversation authority"
    )
  );
  checks.push(
    check(
      "SA-4.8",
      "every reconsideration recorded itself as stage=shadow",
      reconsiderations.length > 0 &&
        reconsiderations.every((r) => r.payload.stage === "shadow")
    )
  );

  // ── SA-4.5 — reconstruction from durable state alone
  if (input.replay) {
    const replay = input.replay;
    const rowsForCase = byCase.get(replay.caseId) ?? [];
    checks.push(
      check(
        "SA-4.5",
        "a fresh reader reconstructs the same number of reconsiderations",
        replay.postureCount === rowsForCase.length,
        `replay ${replay.postureCount} vs rows ${rowsForCase.length}`
      )
    );
    checks.push(
      check(
        "SA-4.5",
        "the reconstruction recovers the objective and the next wake condition",
        replay.objective !== null && replay.nextWakeAt !== null
      )
    );
    checks.push(
      check(
        "SA-4.5",
        "the reconstruction recovers every commitment recorded on that Case",
        replay.commitmentCount ===
          commitmentSubjects.filter((s) => s.case_id === replay.caseId).length
      )
    );
    checks.push(
      check(
        "SA-4.5",
        "the reconstruction names what is being waited on",
        replay.waitingOn !== null
      )
    );
  } else {
    checks.push(
      check("SA-4.5", "a replay reconstruction was performed", false, "not run")
    );
  }

  // ── SA-4.9 — observability, WITHOUT a threshold
  if (input.observability) {
    const obs = input.observability;
    checks.push(
      check(
        "SA-4.9",
        "posture distribution and no-op rate are observable per Organization",
        obs.total > 0 && obs.noActionRatio !== null,
        // Reported, never judged: no governing artifact approves a ratio, so
        // this check asserts that the number EXISTS, not that it is any value.
        `total ${obs.total}, no-action ${obs.noAction}, ratio ${
          obs.noActionRatio === null ? "null" : obs.noActionRatio.toFixed(2)
        } — reported, not judged`
      )
    );
    checks.push(
      check(
        "SA-4.9",
        "observability agrees with the raw rows on the day span",
        obs.distinctDays === days.length,
        `observability ${obs.distinctDays} vs rows ${days.length}`
      )
    );
  } else {
    checks.push(
      check("SA-4.9", "posture observability was read back", false, "not run")
    );
  }

  // ── SA-4.12 — one Organization throughout
  checks.push(
    check(
      "SA-4.12",
      "every row this run produced belongs to the pilot Organization's Cases",
      cases.every((c) => c.organization_id === organizationId) &&
        subjects.every((s) => caseIds.has(s.case_id)) &&
        facts.every((f) => caseIds.has(f.case_id)) &&
        work.every((w) => caseIds.has(w.case_id)),
      // Stated rather than glossed, exactly as SL-3 did: the verifier holds a
      // service-role credential that bypasses RLS by design, so this observes
      // containment, it does not prove RLS enforcement. That is the DB-backed
      // cross-tenant suite's job.
      "containment observed; hosted RLS enforcement is NOT proven by this run"
    )
  );

  return checks;
}

export function allPassed(checks: readonly HostedCheck[]): boolean {
  return checks.every((c) => c.ok);
}
