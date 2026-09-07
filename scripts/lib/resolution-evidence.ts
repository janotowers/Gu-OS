// Hosted-evidence evaluation for R1 SL-3 duplicate & supersession resolution.
//
// Split out of `verify-resolution.ts` for the same reason SL-2 split
// `admission-evidence.ts`: everything here is pure, so the part of the hosted
// run that actually decides pass/fail is unit-testable without a hosted
// environment. What stays in the runner is I/O — resolving the target, seeding
// the controlled scenario, reading rows, writing evidence.
//
// The rule these checks exist to enforce is the one SL-2 paid for: an assertion
// must test what its label says. "the edge exists" does not prove "lineage is
// queryable from EITHER Case"; "the Case is still there" does not prove "no
// history was rewritten". Each question below is answered against the identity
// the implementation actually uses — the typed columns on `case_relationships`,
// `source_ref = case_relationships:<edge id>` on the closure fact, and
// `payload_jsonb.relationship_id` on the narration.
//
// SL-3's Slice Plan contract is two governed operations, never one. The checks
// are grouped so a reader can see which half a failure lands in.

export interface HostedCheck {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * The lifecycle surface of a Case row, which a relationship write must leave
 * untouched (ADR-109 §4 / SA-3.4).
 *
 * `version` and `updated_at` are included deliberately: the optimistic-lock
 * counter and the row timestamp both move on ANY update to `operational_cases`,
 * so they detect a mutation this list did not think to name.
 */
export interface HostedCaseRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  case_type: string;
  status: string;
  current_step: string | null;
  next_action_at: string | null;
  due_at: string | null;
  runtime_authority: string | null;
  assigned_to_user_id: string | null;
  workflow_definition_id: string | null;
  version: number | null;
  updated_at: string | null;
}

export interface HostedRelationshipRow {
  id: string;
  organization_id: string;
  from_case_id: string;
  to_case_id: string;
  relationship_type: string;
  status: string;
  actor_kind: string;
  created_by_user_id: string | null;
  reason: string | null;
  evidence_refs_jsonb: Record<string, unknown> | null;
  provenance_jsonb: Record<string, unknown> | null;
  ended_at: string | null;
}

export interface HostedFactRow {
  id: string;
  case_id: string;
  fact_key: string;
  source_kind: string | null;
  source_ref: string | null;
  value_jsonb: unknown;
  superseded_by: string | null;
}

export interface HostedTimelineRow {
  case_id: string;
  payload_jsonb: Record<string, unknown> | null;
}

/** What `resolveCanonicalization` reported, as recorded. */
export interface HostedResolutionOutcome {
  status: string;
  relationshipId?: string | null;
  closureFactId?: string | null;
  narratedBothTimelines?: boolean;
  firstCompletion?: boolean;
  missing?: string;
  detail?: string;
  reason?: string;
}

export interface HostedSide {
  case: HostedCaseRow | null;
  /** EVERY fact row, superseded included — history is the thing being proved. */
  facts: HostedFactRow[];
  timeline: HostedTimelineRow[];
  /** Active edges where this Case is either endpoint, read keyed FROM this Case. */
  relationships: HostedRelationshipRow[];
}

export interface HostedResolutionInputs {
  /** Which of SL-3's two flows this scenario exercises. */
  kind: "duplicate" | "supersession";
  organizationId: string;
  closingCaseId: string;
  survivingCaseId: string;
  /** The fact key both Cases carry with disagreeing values (the AC-15 premise). */
  conflictingFactKey: string;
  /** Snapshots taken immediately before and after the resolution. */
  before: { closing: HostedSide; surviving: HostedSide };
  after: { closing: HostedSide; surviving: HostedSide };
  /** First application of the determination. */
  result: HostedResolutionOutcome;
  /** The SAME determination applied a second time (SA-3.7 convergence). */
  repeat: HostedResolutionOutcome;
  /** Snapshot after the repeat, to prove nothing doubled. */
  afterRepeat: { closing: HostedSide; surviving: HostedSide };
  /** `findIncompleteResolutions` for the closing Case, after completion. */
  incompleteAfter: Array<{ relationshipId: string; missing: string }>;
  /** Digest function, so no raw identifier reaches PR-safe evidence. */
  redact: (value: string | null) => string | null;
}

export const OPPORTUNITY_CLOSURE_FACT_KEY_NAME = "opportunity.closure";

const SHAPE = {
  duplicate: {
    edgeType: "duplicate_of",
    outcome: "duplicate",
    reason: "same_objective_canonicalized",
  },
  supersession: {
    edgeType: "superseded_by",
    outcome: "superseded",
    reason: "replaced_by_successor_opportunity",
  },
} as const;

/** `source_ref` a resolution stamps on the closure it writes. */
export function closureSourceRefFor(relationshipId: string): string {
  return `case_relationships:${relationshipId}`;
}

/** The lifecycle columns SA-3.4 forbids a relationship write from moving. */
const LIFECYCLE_COLUMNS: Array<keyof HostedCaseRow> = [
  "user_id",
  "organization_id",
  "case_type",
  "status",
  "current_step",
  "next_action_at",
  "due_at",
  "runtime_authority",
  "assigned_to_user_id",
  "workflow_definition_id",
  "version",
  "updated_at",
];

function lifecycleDrift(
  before: HostedCaseRow,
  after: HostedCaseRow
): string[] {
  const moved: string[] = [];
  for (const column of LIFECYCLE_COLUMNS) {
    if (before[column] !== after[column]) {
      moved.push(String(column));
    }
  }
  return moved;
}

/** Active lineage edges for this exact determination, from one Case's listing. */
function edgesFor(
  rows: HostedRelationshipRow[],
  params: { from: string; to: string; type: string }
): HostedRelationshipRow[] {
  return rows.filter(
    (row) =>
      row.from_case_id === params.from &&
      row.to_case_id === params.to &&
      row.relationship_type === params.type &&
      row.status === "active"
  );
}

/** Current (non-superseded) closure rows on a Case. */
function currentClosures(facts: HostedFactRow[]): HostedFactRow[] {
  return facts.filter(
    (row) =>
      row.fact_key === OPPORTUNITY_CLOSURE_FACT_KEY_NAME &&
      row.superseded_by === null
  );
}

function narrationsFor(
  timeline: HostedTimelineRow[],
  params: { caseId: string; relationshipId: string }
): HostedTimelineRow[] {
  return timeline.filter(
    (row) =>
      row.case_id === params.caseId &&
      row.payload_jsonb?.kind === "case_relationship" &&
      row.payload_jsonb?.relationship_id === params.relationshipId
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonEmptyRecord(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && Object.keys(record).length > 0;
}

/**
 * Evaluates one hosted resolution scenario.
 *
 * Ordered so the evidence file reads as the argument it is: first that the
 * scenario's premise was real, then EC-06 (both Cases survive, related with
 * traceability), then AC-15 (exactly one ongoing responsibility, history
 * retained), then the structural assertions the Slice contract names.
 */
export function evaluateHostedResolutionEvidence(
  inputs: HostedResolutionInputs
): HostedCheck[] {
  const checks: HostedCheck[] = [];
  const shape = SHAPE[inputs.kind];
  const record = (
    assertion: string,
    label: string,
    ok: boolean,
    detail?: string
  ): void => {
    checks.push({ assertion, label, ok, detail });
  };

  const beforeClosing = inputs.before.closing.case;
  const beforeSurviving = inputs.before.surviving.case;
  const afterClosing = inputs.after.closing.case;
  const afterSurviving = inputs.after.surviving.case;

  // ── Premise. AC-15 is "suspected duplicate WITH CONFLICTING FACTS". If the
  // pair does not actually disagree, every check below is testing a weaker
  // scenario than the one the Definition of Done asks for.
  const closingConflict = inputs.before.closing.facts.filter(
    (row) => row.fact_key === inputs.conflictingFactKey && row.superseded_by === null
  );
  const survivingConflict = inputs.before.surviving.facts.filter(
    (row) => row.fact_key === inputs.conflictingFactKey && row.superseded_by === null
  );
  const conflictReal =
    closingConflict.length === 1 &&
    survivingConflict.length === 1 &&
    JSON.stringify(closingConflict[0].value_jsonb) !==
      JSON.stringify(survivingConflict[0].value_jsonb);
  record(
    "premise",
    "the pair carries conflicting facts on the same key before resolution",
    conflictReal,
    `${inputs.conflictingFactKey}: closing=${closingConflict.length} surviving=${survivingConflict.length} differ=${
      closingConflict.length === 1 && survivingConflict.length === 1
        ? JSON.stringify(closingConflict[0].value_jsonb) !==
          JSON.stringify(survivingConflict[0].value_jsonb)
        : "n/a"
    }`
  );

  record(
    "premise",
    "both Cases are ongoing and unrelated before resolution",
    beforeClosing?.status === "active" &&
      beforeSurviving?.status === "active" &&
      edgesFor(inputs.before.closing.relationships, {
        from: inputs.closingCaseId,
        to: inputs.survivingCaseId,
        type: shape.edgeType,
      }).length === 0,
    `closing=${beforeClosing?.status ?? "missing"} surviving=${beforeSurviving?.status ?? "missing"} priorEdges=${
      edgesFor(inputs.before.closing.relationships, {
        from: inputs.closingCaseId,
        to: inputs.survivingCaseId,
        type: shape.edgeType,
      }).length
    }`
  );

  record(
    "premise",
    "neither Case carries a business closure before resolution",
    currentClosures(inputs.before.closing.facts).length === 0 &&
      currentClosures(inputs.before.surviving.facts).length === 0,
    `closing=${currentClosures(inputs.before.closing.facts).length} surviving=${currentClosures(inputs.before.surviving.facts).length}`
  );

  // ── The resolution itself completed. A half-completed pair must never be
  // reported as a resolution (SA-3.12), so this is read from what the executor
  // returned, not inferred from the rows.
  const resolved = inputs.result.status === "resolved";
  record(
    "SA-3.1",
    "the governed determination is applied and reported as a completed resolution",
    resolved,
    resolved
      ? `status=resolved firstCompletion=${inputs.result.firstCompletion} narratedBothTimelines=${inputs.result.narratedBothTimelines}`
      : `status=${inputs.result.status} missing=${inputs.result.missing ?? inputs.result.reason ?? "n/a"} detail=${inputs.result.detail ?? "n/a"}`
  );

  const relationshipId = inputs.result.relationshipId ?? null;

  // ── EC-06 — preserve both, relate with traceability, never delete.
  record(
    "EC-06",
    "both Cases survive resolution — neither is deleted",
    afterClosing !== null && afterSurviving !== null,
    `closing=${afterClosing ? "present" : "MISSING"} surviving=${afterSurviving ? "present" : "MISSING"}`
  );

  const beforeFactIds = new Set(
    [...inputs.before.closing.facts, ...inputs.before.surviving.facts].map((r) => r.id)
  );
  const afterFactRows = [...inputs.after.closing.facts, ...inputs.after.surviving.facts];
  const afterFactIds = new Set(afterFactRows.map((r) => r.id));
  const lostFacts = [...beforeFactIds].filter((id) => !afterFactIds.has(id));
  record(
    "EC-06",
    "no history is discarded — every pre-resolution fact row still exists",
    lostFacts.length === 0,
    `before=${beforeFactIds.size} stillPresent=${beforeFactIds.size - lostFacts.length} lost=${lostFacts.length}`
  );

  const beforeValues = new Map(
    [...inputs.before.closing.facts, ...inputs.before.surviving.facts].map((r) => [
      r.id,
      JSON.stringify(r.value_jsonb),
    ])
  );
  const rewritten = afterFactRows.filter(
    (row) => beforeValues.has(row.id) && beforeValues.get(row.id) !== JSON.stringify(row.value_jsonb)
  );
  record(
    "EC-06",
    "no history is rewritten — pre-resolution fact values are unchanged",
    rewritten.length === 0,
    `compared=${beforeValues.size} rewritten=${rewritten.length}`
  );

  const closingEdges = relationshipId
    ? edgesFor(inputs.after.closing.relationships, {
        from: inputs.closingCaseId,
        to: inputs.survivingCaseId,
        type: shape.edgeType,
      })
    : [];
  const edge = closingEdges.find((row) => row.id === relationshipId) ?? null;

  record(
    "EC-06",
    `the pair is related by a typed, directed, active ${shape.edgeType} edge`,
    edge !== null,
    edge
      ? `type=${edge.relationship_type} status=${edge.status} direction=closing→surviving org=${inputs.redact(edge.organization_id)}`
      : `no active ${shape.edgeType} edge from the closing Case to the surviving Case matches the returned relationship id`
  );

  record(
    "EC-06",
    "the edge carries traceability — actor, reason, evidence refs and provenance",
    edge !== null &&
      typeof edge.actor_kind === "string" &&
      edge.actor_kind.length > 0 &&
      typeof edge.reason === "string" &&
      edge.reason.trim().length > 0 &&
      isNonEmptyRecord(edge.evidence_refs_jsonb) &&
      isNonEmptyRecord(edge.provenance_jsonb),
    edge
      ? `actor_kind=${edge.actor_kind} reason=${edge.reason ? "present" : "MISSING"} evidence_refs=${Object.keys(edge.evidence_refs_jsonb ?? {}).length} provenance=${Object.keys(edge.provenance_jsonb ?? {}).length}`
      : "no edge to inspect"
  );

  // ── AC-15 — one canonical active responsibility; lineage/history retained.
  const closingClosures = currentClosures(inputs.after.closing.facts);
  const survivingClosures = currentClosures(inputs.after.surviving.facts);
  const closure = closingClosures[0] ?? null;
  const closureValue = asRecord(closure?.value_jsonb);

  record(
    "AC-15",
    "exactly one ongoing canonical responsibility — only the non-canonical Case is closed",
    closingClosures.length === 1 && survivingClosures.length === 0,
    `closingClosures=${closingClosures.length} survivingClosures=${survivingClosures.length}`
  );

  record(
    "AC-15",
    `the closure records outcome=${shape.outcome} with reason, evidence and provenance`,
    closureValue !== null &&
      closureValue.outcome === shape.outcome &&
      closureValue.reason === shape.reason &&
      closureValue.counterpart_case_id === inputs.survivingCaseId &&
      typeof closureValue.actor_kind === "string" &&
      isNonEmptyRecord(closureValue.evidence_refs) &&
      typeof closure?.source_kind === "string" &&
      closure.source_ref === closureSourceRefFor(relationshipId ?? ""),
    closureValue
      ? `outcome=${String(closureValue.outcome)} reason=${String(closureValue.reason)} counterpart=${inputs.redact(String(closureValue.counterpart_case_id ?? ""))} actor_kind=${String(closureValue.actor_kind)} evidence_refs=${Object.keys(asRecord(closureValue.evidence_refs) ?? {}).length} source_kind=${closure?.source_kind} source_ref_names_edge=${closure?.source_ref === closureSourceRefFor(relationshipId ?? "")}`
      : "no current closure fact on the closing Case"
  );

  record(
    "AC-15",
    "the surviving Case keeps its ongoing responsibility untouched by the closure",
    survivingClosures.length === 0 && afterSurviving?.status === "active",
    `status=${afterSurviving?.status ?? "missing"} closures=${survivingClosures.length}`
  );

  // ── SA-3.3 — lineage queryable from EITHER Case, as structured data.
  const survivingEdges = relationshipId
    ? edgesFor(inputs.after.surviving.relationships, {
        from: inputs.closingCaseId,
        to: inputs.survivingCaseId,
        type: shape.edgeType,
      })
    : [];
  record(
    "SA-3.3",
    "lineage is queryable from EITHER Case as typed structured data",
    edge !== null &&
      survivingEdges.some((row) => row.id === relationshipId) &&
      closingEdges.some((row) => row.id === relationshipId),
    `fromClosing=${closingEdges.filter((r) => r.id === relationshipId).length} fromSurviving=${survivingEdges.filter((r) => r.id === relationshipId).length}; typed columns only, no free-text parsing`
  );

  // ── SA-3.4 — the relationship write mutates neither Case row.
  //
  // The scenario applies BOTH governed halves, and closure is a `case_facts`
  // write that also never touches `operational_cases`. So the whole resolution
  // must leave both rows byte-identical on every lifecycle column.
  const closingDrift =
    beforeClosing && afterClosing ? lifecycleDrift(beforeClosing, afterClosing) : ["case row missing"];
  const survivingDrift =
    beforeSurviving && afterSurviving
      ? lifecycleDrift(beforeSurviving, afterSurviving)
      : ["case row missing"];
  record(
    "SA-3.4",
    "neither Case row is mutated — no lifecycle, ownership, workflow or scheduling column moves",
    closingDrift.length === 0 && survivingDrift.length === 0,
    `columnsCompared=${LIFECYCLE_COLUMNS.length} closingMoved=[${closingDrift.join(",")}] survivingMoved=[${survivingDrift.join(",")}]`
  );

  // ── SA-3.5 — a relationship event on BOTH timelines, once each.
  const closingNarrations = relationshipId
    ? narrationsFor(inputs.after.closing.timeline, {
        caseId: inputs.closingCaseId,
        relationshipId,
      })
    : [];
  const survivingNarrations = relationshipId
    ? narrationsFor(inputs.after.surviving.timeline, {
        caseId: inputs.survivingCaseId,
        relationshipId,
      })
    : [];
  record(
    "SA-3.5",
    "a relationship event is appended to BOTH Cases' timelines, exactly once each",
    closingNarrations.length === 1 && survivingNarrations.length === 1,
    `closing=${closingNarrations.length} surviving=${survivingNarrations.length}`
  );
  record(
    "SA-3.5",
    "each narration reads correctly from its own side of the edge",
    closingNarrations[0]?.payload_jsonb?.side === "from" &&
      closingNarrations[0]?.payload_jsonb?.counterpart_case_id === inputs.survivingCaseId &&
      survivingNarrations[0]?.payload_jsonb?.side === "to" &&
      survivingNarrations[0]?.payload_jsonb?.counterpart_case_id === inputs.closingCaseId,
    `closingSide=${String(closingNarrations[0]?.payload_jsonb?.side ?? "n/a")} survivingSide=${String(survivingNarrations[0]?.payload_jsonb?.side ?? "n/a")}`
  );

  // ── SA-3.6 — conflicting facts preserved and still attributable.
  const closingConflictAfter = inputs.after.closing.facts.filter(
    (row) => row.fact_key === inputs.conflictingFactKey && row.superseded_by === null
  );
  const survivingConflictAfter = inputs.after.surviving.facts.filter(
    (row) => row.fact_key === inputs.conflictingFactKey && row.superseded_by === null
  );
  const sameValue = (a: HostedFactRow[], b: HostedFactRow[]): boolean =>
    a.length === 1 && b.length === 1 && JSON.stringify(a[0].value_jsonb) === JSON.stringify(b[0].value_jsonb);
  record(
    "SA-3.6",
    "both sides' conflicting facts survive resolution, each attributable to its own Case",
    closingConflictAfter.length === 1 &&
      survivingConflictAfter.length === 1 &&
      closingConflictAfter[0].case_id === inputs.closingCaseId &&
      survivingConflictAfter[0].case_id === inputs.survivingCaseId &&
      sameValue(closingConflict, closingConflictAfter) &&
      sameValue(survivingConflict, survivingConflictAfter) &&
      JSON.stringify(closingConflictAfter[0].value_jsonb) !==
        JSON.stringify(survivingConflictAfter[0].value_jsonb),
    `closing=${closingConflictAfter.length} surviving=${survivingConflictAfter.length}; neither side's value was reconciled away`
  );

  // ── SA-3.7 — repeated resolution converges on ONE active edge.
  const repeatConverged =
    inputs.repeat.status === "resolved" &&
    inputs.repeat.relationshipId === relationshipId &&
    inputs.repeat.closureFactId === inputs.result.closureFactId &&
    inputs.repeat.firstCompletion === false;
  record(
    "SA-3.7",
    "repeating the same determination converges rather than resolving twice",
    repeatConverged,
    `status=${inputs.repeat.status} sameEdge=${inputs.repeat.relationshipId === relationshipId} sameClosure=${inputs.repeat.closureFactId === inputs.result.closureFactId} firstCompletion=${inputs.repeat.firstCompletion}`
  );

  const repeatEdges = relationshipId
    ? edgesFor(inputs.afterRepeat.closing.relationships, {
        from: inputs.closingCaseId,
        to: inputs.survivingCaseId,
        type: shape.edgeType,
      })
    : [];
  const repeatClosures = currentClosures(inputs.afterRepeat.closing.facts);
  const repeatNarrations = relationshipId
    ? narrationsFor(inputs.afterRepeat.closing.timeline, {
        caseId: inputs.closingCaseId,
        relationshipId,
      })
    : [];
  const repeatNarrationsSurviving = relationshipId
    ? narrationsFor(inputs.afterRepeat.surviving.timeline, {
        caseId: inputs.survivingCaseId,
        relationshipId,
      })
    : [];
  record(
    "SA-3.7",
    "after the repeat there is still exactly one edge, one closure and one narration per side",
    repeatEdges.length === 1 &&
      repeatClosures.length === 1 &&
      repeatNarrations.length === 1 &&
      repeatNarrationsSurviving.length === 1,
    `edges=${repeatEdges.length} closures=${repeatClosures.length} narrations=${repeatNarrations.length}/${repeatNarrationsSurviving.length}`
  );

  // ── SA-3.11 — the supersession flow specifically.
  if (inputs.kind === "supersession") {
    record(
      "SA-3.11",
      "a directed superseded_by edge plus a superseded closure, both histories intact",
      edge?.relationship_type === "superseded_by" &&
        edge.from_case_id === inputs.closingCaseId &&
        edge.to_case_id === inputs.survivingCaseId &&
        closureValue?.outcome === "superseded" &&
        lostFacts.length === 0 &&
        rewritten.length === 0,
      `edge=${edge?.relationship_type ?? "missing"} direction=${edge ? "closing→surviving" : "n/a"} outcome=${String(closureValue?.outcome ?? "missing")} historyLost=${lostFacts.length} historyRewritten=${rewritten.length}`
    );
  }

  // ── SA-3.12 — the recovery read, exercised hosted.
  //
  // The fault injection itself is slice-local and deterministic; what only a
  // hosted run can establish is that the discovery query actually works against
  // the real database, so "safely retryable" stays a property rather than a
  // claim about an in-memory fake.
  record(
    "SA-3.12",
    "the incomplete-resolution recovery read runs hosted and reports nothing owed for a completed resolution",
    inputs.incompleteAfter.length === 0,
    `incomplete=${inputs.incompleteAfter.length}${
      inputs.incompleteAfter.length > 0
        ? ` [${inputs.incompleteAfter.map((row) => `${inputs.redact(row.relationshipId)}:${row.missing}`).join(",")}]`
        : ""
    }`
  );

  return checks;
}

/** True when every check passed. */
export function allPassed(checks: readonly HostedCheck[]): boolean {
  return checks.every((check) => check.ok);
}
