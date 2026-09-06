// Hosted-evidence evaluation for R1 SL-2 admission (SA-2.1, SA-2.2).
//
// Split out of `verify-admission.ts` deliberately: everything here is pure, so
// the part of the hosted run that actually decides pass/fail can be unit-tested
// without a hosted environment. What remains in the runner is I/O — resolving
// the target, reading rows, writing evidence.
//
// The rule these checks exist to enforce: an assertion must test what its label
// says. `Boolean(caseId)` does not prove "exactly one Case", and "every current
// fact has some source_ref" does not prove "this admission wrote the evidence
// its decision owes". Both questions are answered against the identity the
// implementation actually uses — `source_events:<id>` in `source_ref`, and
// `context_jsonb.source_event_id` on the Case.

export interface HostedCheck {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/** The subset of a Case row this evidence needs. Shaped, not the whole row. */
export interface HostedCaseRow {
  id: string;
  case_type: string;
  organization_id: string | null;
  runtime_authority: string | null;
  current_step: string | null;
  next_action_at: string | null;
  context_jsonb: Record<string, unknown> | null;
}

export interface HostedSourceEventRow {
  status: string;
  decision_jsonb: Record<string, unknown> | null;
  admitted_case_id: string | null;
}

export interface HostedFactRow {
  fact_key: string;
  source_ref: string | null;
  value_jsonb: unknown;
  superseded_by: string | null;
}

export interface HostedTimelineRow {
  payload_jsonb: Record<string, unknown> | null;
}

export interface HostedAdmissionInputs {
  organizationId: string;
  sourceEventId: string;
  /** The disposition admission returned, as recorded. */
  decision: {
    disposition: string;
    reason: string;
    policy?: { policy_id?: string; version?: number; source?: string } | null;
    proposal?: { objective?: string | null } | null;
  };
  returnedCaseId: string | null;
  /** Cases in this Organization whose context names this source event. */
  matchingCases: HostedCaseRow[];
  sourceEvent: HostedSourceEventRow | null;
  /** Every current fact on the Case, whatever its provenance. */
  caseFacts: HostedFactRow[];
  timeline: HostedTimelineRow[];
  /** Digest function, so no raw identifier reaches PR-safe evidence. */
  redact: (value: string | null) => string | null;
}

/** The provenance identity admission stamps on every fact it writes. */
export function admissionSourceRef(sourceEventId: string): string {
  return `source_events:${sourceEventId}`;
}

/**
 * Which fact keys the recorded decision owes.
 *
 * `opportunity.objective` is owed only when the decision actually carries an
 * objective — asking for it unconditionally would fail a legitimate admission
 * that came through the trusted-source route with no stated objective.
 */
export function owedFactKeys(inputs: {
  decision: HostedAdmissionInputs["decision"];
}): string[] {
  const owed = ["admission.disposition", "admission.source"];
  if (inputs.decision.proposal?.objective) owed.push("opportunity.objective");
  return owed;
}

function samePolicy(
  a: { policy_id?: string; version?: number; source?: string } | null | undefined,
  b: { policy_id?: string; version?: number; source?: string } | null | undefined
): boolean {
  if (!a || !b) return false;
  return (
    a.policy_id === b.policy_id &&
    a.version === b.version &&
    a.source === b.source
  );
}

/**
 * Turns hosted rows into the SA-2.1 / SA-2.2 evidence checks.
 *
 * Never fails because *unrelated* Case facts exist: a Case may legitimately
 * carry facts from other writers, and this asks only whether admission's own
 * owed evidence is present exactly once.
 */
export function evaluateHostedAdmissionEvidence(
  inputs: HostedAdmissionInputs
): HostedCheck[] {
  const checks: HostedCheck[] = [];
  const add = (
    assertion: string,
    label: string,
    ok: boolean,
    detail?: string
  ) => checks.push({ assertion, label, ok, detail });

  const admitted = inputs.decision.disposition === "admitted";
  const sourceRef = admissionSourceRef(inputs.sourceEventId);

  // ── The source event is the canonical row for this outcome.
  const event = inputs.sourceEvent;
  add(
    "SA-2.1",
    "the source event is settled in the hosted target",
    event?.status === "completed",
    event ? `status=${event.status}` : "source event row not found"
  );
  const settledDisposition = event?.decision_jsonb?.disposition;
  add(
    "SA-2.1",
    "the settled decision matches the returned disposition",
    settledDisposition === inputs.decision.disposition,
    `settled=${String(settledDisposition ?? "none")} returned=${inputs.decision.disposition}`
  );
  const settledPolicy = (event?.decision_jsonb?.policy ?? null) as
    | { policy_id?: string; version?: number; source?: string }
    | null;
  add(
    "SA-2.1",
    "the settled decision carries the same effective policy attribution",
    samePolicy(settledPolicy, inputs.decision.policy),
    `settled=${settledPolicy?.policy_id ?? "none"}@${settledPolicy?.version ?? "?"} ` +
      `returned=${inputs.decision.policy?.policy_id ?? "none"}@${inputs.decision.policy?.version ?? "?"}`
  );

  if (!admitted) {
    add(
      "SA-2.2",
      "an unadmitted lead materialises no Opportunity Case",
      inputs.matchingCases.length === 0 && inputs.returnedCaseId === null,
      `cases=${inputs.matchingCases.length}; disposition=${inputs.decision.disposition}. ` +
        "SA-2.2 needs an ADMITTED lead, so re-run against a lead the policy admits to complete it"
    );
    add(
      "SA-2.1",
      "the settled event points at no Case",
      (event?.admitted_case_id ?? null) === null,
      `admitted_case_id=${inputs.redact(event?.admitted_case_id ?? null) ?? "null"}`
    );
    return checks;
  }

  // ── Exactly one Case carries this source event's identity.
  add(
    "SA-2.2",
    "exactly one Opportunity Case exists for this source event",
    inputs.matchingCases.length === 1,
    `cases matching context.source_event_id = ${inputs.matchingCases.length}`
  );
  const materialised = inputs.matchingCases[0];
  add(
    "SA-2.2",
    "that Case is the one admission returned",
    Boolean(materialised) && materialised.id === inputs.returnedCaseId,
    `hosted=${inputs.redact(materialised?.id ?? null) ?? "none"} ` +
      `returned=${inputs.redact(inputs.returnedCaseId) ?? "none"}`
  );

  // ── The shadow materialisation properties the implementation writes.
  if (materialised) {
    add(
      "SA-2.2",
      "the Case is Organization-owned, lead_opportunity, and shadow",
      materialised.organization_id === inputs.organizationId &&
        materialised.case_type === "lead_opportunity" &&
        materialised.runtime_authority === "legacy" &&
        materialised.current_step === null &&
        materialised.next_action_at === null,
      `case_type=${materialised.case_type} ` +
        `runtime_authority=${materialised.runtime_authority ?? "null"} ` +
        `current_step=${materialised.current_step ?? "null"} ` +
        `next_action_at=${materialised.next_action_at === null ? "null" : "SET"}`
    );
  }

  add(
    "SA-2.1",
    "the settled event points at that Case",
    Boolean(event?.admitted_case_id) &&
      event?.admitted_case_id === inputs.returnedCaseId,
    `admitted_case_id=${inputs.redact(event?.admitted_case_id ?? null) ?? "null"}`
  );

  // ── The evidence THIS admission owes, identified by its own provenance.
  const owed = owedFactKeys({ decision: inputs.decision });
  const mine = inputs.caseFacts.filter((fact) => fact.source_ref === sourceRef);
  for (const key of owed) {
    const matching = mine.filter((fact) => fact.fact_key === key);
    add(
      "SA-2.2",
      `this admission wrote exactly one ${key} fact`,
      matching.length === 1,
      `found ${matching.length} with source_ref=source_events:<redacted>`
    );
  }

  const dispositionFact = mine.find(
    (fact) => fact.fact_key === "admission.disposition"
  );
  const factPolicy = (
    (dispositionFact?.value_jsonb as { policy?: unknown } | undefined)?.policy ??
    null
  ) as { policy_id?: string; version?: number; source?: string } | null;
  add(
    "SA-2.2",
    "the disposition fact preserves the effective policy attribution",
    samePolicy(factPolicy, inputs.decision.policy),
    `fact=${factPolicy?.policy_id ?? "none"}@${factPolicy?.version ?? "?"} ` +
      `returned=${inputs.decision.policy?.policy_id ?? "none"}@${inputs.decision.policy?.version ?? "?"}`
  );

  // ── The admission is narrated exactly once.
  const narrations = inputs.timeline.filter((entry) => {
    const payload = entry.payload_jsonb;
    return (
      payload?.kind === "admission_disposition" &&
      payload?.source_event_id === inputs.sourceEventId
    );
  });
  add(
    "SA-2.2",
    "the admission is narrated exactly once on the Case timeline",
    narrations.length === 1,
    `admission_disposition entries for this source event = ${narrations.length}`
  );

  return checks;
}
