/**
 * The deterministic admission executor (R1 SL-2 / S1 / Technical Plan §3).
 *
 * Composition: **model semantic interpreter → structured proposal → deterministic
 * contract executor**. This file is the executor. Every guarantee the Slice
 * promises is enforced here, in a fixed order, and the order *is* the guarantee:
 *
 *   1. flags            — `relationship_ops` off ⇒ fully inert (SA-2.9)
 *   2. Organization gate — the SL-1 binding check precedes any source read,
 *                          and an out-of-Organization lead reads nothing (SA-2.8)
 *   3. idempotency      — the `dedup_key` collision returns the original
 *                          outcome instead of deciding again (SA-2.4)
 *   4. platform bounds  — a hard bound wins over any policy and any confident
 *                          model judgment (SA-2.5)
 *   5. policy           — effective policy resolved and attributed by version;
 *                          missing ⇒ platform baseline, invalid ⇒ fail closed
 *                          (SA-2.7)
 *   6. interpretation   — only now does a model run
 *   7. exclusion        — a policy-excluded category is not auto-admitted,
 *                          however confident the judgment (SA-2.6)
 *   8. materialisation  — exactly one Opportunity Case, with provenance-bearing
 *                          facts; nothing admitted means no Case at all
 *                          (SA-2.2, EC-01)
 *
 * Steps 4, 5 and 7 are placed *around* step 6 deliberately. A model that ran
 * first, or whose output was consulted before the bounds, could argue its way
 * past them; here it cannot, because by the time it speaks the bound has
 * already refused and by the time it has spoken the exclusion still applies.
 *
 * Shadow throughout: no prospect-facing effect is reachable from this module.
 * It writes Gu OS rows and nothing else — no send, no legacy write, no
 * suppression of legacy behavior.
 */
import {
  createOperationalCase,
  getActiveMembership,
  getGlobalOperationalCaseTypeBySlug,
  getRelationshipAdmissionMode,
  insertCaseFact,
  insertOperationalCaseEvent,
  isRelationshipOpsEnabled,
  recordSourceEvent,
  settleSourceEvent,
} from "@agents/db";
import {
  ADMISSION_FACT_KEYS,
  LEAD_OPPORTUNITY_CASE_TYPE,
  type AdmissionDecision,
  type AdmissionOutcome,
  type AdmissionProposal,
  type EffectivePolicyAttribution,
  type RelationshipAdmissionMode,
  type RelationshipAdmissionPolicy,
  type SourceEventKind,
} from "@agents/types";
import {
  assertPreReadGate,
  type GatewayCallerContext,
  type GatewayEnv,
} from "../legacy-gateway/authorization";
import { resolveEffectiveAdmissionPolicy } from "./policy";
import type { PlatformHardBoundProbe } from "./hard-bounds";
import type {
  AdmissionInterpreter,
  AdmissionInterpreterInput,
} from "./interpreter";

/** Why admission did nothing at all. Distinct from deciding not to admit. */
export type AdmissionInertReason =
  | "relationship_ops_disabled"
  | "admission_mode_disabled";

export type AdmissionResult =
  | { status: "inert"; reason: AdmissionInertReason }
  | { status: "evaluated"; outcome: AdmissionOutcome };

/** The inbound situation, already normalized by the gateway. */
export interface AdmissionSourceEvent {
  kind: SourceEventKind;
  /** Opaque legacy lead identity. Carried whole, never parsed. */
  externalLeadRef: string;
  /** Stable identity of this delivery — see `buildSourceEventDedupKey`. */
  dedupKey: string;
  /** Most recent inbound prospect message, when the event carried one. */
  message?: string | null;
  priorMessages?: readonly string[];
  sourceLabel?: string | null;
  originLabel?: string | null;
  propertyContext?: string | null;
  /** Allowlisted normalized payload recorded on the inbox row. */
  payload?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface AdmissionRequest {
  ctx: GatewayCallerContext;
  event: AdmissionSourceEvent;
  /**
   * The advisor profile that will own the Opportunity Case.
   *
   * Required, not inferred. `operational_cases.user_id` is NOT NULL, and the
   * SL-1 lead context exposes the legacy *owner principal* rather than a
   * resolvable advisor identity — so guessing here would either invent an owner
   * or silently attribute the Case to whoever happened to be calling. It is
   * re-checked below: the named user must be an active member, because identity
   * is not authorization (ADR-106).
   */
  ownerUserId: string;
  interpreter: AdmissionInterpreter;
  hardBounds: PlatformHardBoundProbe;
  env?: GatewayEnv;
}

function decision(params: {
  disposition: AdmissionDecision["disposition"];
  reason: AdmissionDecision["reason"];
  policy: EffectivePolicyAttribution;
  hardBound?: string | null;
  proposal?: AdmissionProposal | null;
}): AdmissionDecision {
  return {
    disposition: params.disposition,
    reason: params.reason,
    policy: params.policy,
    hard_bound: params.hardBound ?? null,
    proposal: params.proposal ?? null,
  };
}

const HARD_BOUND_ATTRIBUTION: EffectivePolicyAttribution = {
  source: "platform_hard_bound",
  policy_id: "platform-hard-bound",
  version: 1,
  matched_rule: "platform_hard_bound_precedes_policy",
};

/**
 * Whether the effective policy permits admitting this proposal.
 *
 * Pure and exported so the eval set can exercise policy behavior against model
 * proposals without a database.
 */
export function applyPolicyToProposal(params: {
  policy: RelationshipAdmissionPolicy;
  attribution: EffectivePolicyAttribution;
  proposal: AdmissionProposal | null;
  sourceLabel: string | null;
}): AdmissionDecision {
  const { policy, attribution, proposal } = params;

  // A trusted source is an independent route to eligibility (S1 §8.4.4): the
  // event itself is sufficient, without semantic intent evidence in the text.
  const sourceIsTrusted =
    params.sourceLabel !== null &&
    policy.trusted_sources.includes(params.sourceLabel);

  // No judgment and no trusted source means no discernible objective. EC-01:
  // clarification stays open, and no Case exists merely because a message does.
  if (!proposal || !proposal.has_actionable_objective) {
    if (!sourceIsTrusted) {
      return decision({
        disposition: "deferred_clarification",
        reason: "ambiguous_objective",
        policy: attribution,
        proposal,
      });
    }
  }

  // EC-03: an excluded category is not admitted automatically, however
  // confident the judgment. Checked before the auto-admit switch so an
  // exclusion is never bypassed by a permissive one, and before the trusted
  // source route so a trusted source cannot carry an excluded objective in.
  const category = proposal?.objective_category ?? null;
  if (category && policy.excluded_categories.includes(category)) {
    return decision({
      disposition: "not_admitted",
      reason: "policy_excluded_category",
      policy: attribution,
      proposal,
    });
  }

  if (sourceIsTrusted) {
    return decision({
      disposition: "admitted",
      reason: "trusted_source",
      policy: attribution,
      proposal,
    });
  }

  if (!policy.auto_admit_clear_objectives) {
    return decision({
      disposition: "not_admitted",
      reason: "manual_admission_required",
      policy: attribution,
      proposal,
    });
  }

  return decision({
    disposition: "admitted",
    reason: "clear_objective",
    policy: attribution,
    proposal,
  });
}

/**
 * Evaluates one inbound source event and records the outcome.
 *
 * Returns rather than throws for every *decision*; throws only for a refusal
 * (the gateway's typed `LegacyReadRefusal`, e.g. a lead belonging to another
 * Organization) or a genuine fault. A refusal is not a disposition: nothing was
 * evaluated, so nothing may be recorded as if it had been.
 */
export async function runAdmission(
  request: AdmissionRequest
): Promise<AdmissionResult> {
  const { ctx, event } = request;
  const db = ctx.db;

  // ── 1. Flags. Off ⇒ fully inert: no disposition, no Case, no read (SA-2.9).
  if (!(await isRelationshipOpsEnabled(db, ctx.organizationId))) {
    return { status: "inert", reason: "relationship_ops_disabled" };
  }
  const mode: RelationshipAdmissionMode = await getRelationshipAdmissionMode(
    db,
    ctx.organizationId
  );
  // SL-2 ships `shadow` only. `assisted` and `live` are later Slices, and a
  // flag value this Slice does not implement must not silently behave as if it
  // did — so it is inert rather than treated as shadow.
  if (mode !== "shadow") {
    return { status: "inert", reason: "admission_mode_disabled" };
  }

  // ── 2. The Organization gate, before any source read (SA-2.8).
  //
  // Reuses the SL-1 gate rather than restating it: this is the same check the
  // gateway performs, so admission cannot drift away from it. A lead bound to a
  // different Organization throws here, having read nothing.
  await assertPreReadGate({
    ctx,
    capability: "legacy_lead_get_context",
    externalId: event.externalLeadRef,
    bindingKind: "legacy_lead",
    env: request.env,
  });

  // ── 3. Idempotency (SA-2.4).
  //
  // The insert is the check: the UNIQUE (organization_id, dedup_key) index
  // rejects a redelivery, and the original decision comes back with it. There
  // is no read-then-write race to lose.
  const recorded = await recordSourceEvent(db, {
    organizationId: ctx.organizationId,
    sourceSystem: "traditional_gu",
    eventKind: event.kind,
    dedupKey: event.dedupKey,
    externalRef: event.externalLeadRef,
    externalLeadRef: event.externalLeadRef,
    payload: event.payload ?? {},
    provenance: event.provenance ?? {},
  });

  if (!recorded.created) {
    const prior = recorded.event.decision_jsonb as AdmissionDecision | null;
    return {
      status: "evaluated",
      outcome: {
        decision:
          prior ??
          decision({
            disposition: "not_admitted",
            reason: "duplicate_source_event",
            policy: HARD_BOUND_ATTRIBUTION,
          }),
        // A duplicate never materialises a second Case. When the original
        // admitted one, that Case is reachable from the original event; this
        // call reports the outcome, it does not re-create anything.
        case_id: null,
        source_event_id: recorded.event.id,
        deduplicated: true,
      },
    };
  }

  const settle = async (
    settled: AdmissionDecision,
    caseId: string | null
  ): Promise<AdmissionResult> => {
    await settleSourceEvent(db, {
      organizationId: ctx.organizationId,
      sourceEventId: recorded.event.id,
      decision: settled as unknown as Record<string, unknown>,
    });
    return {
      status: "evaluated",
      outcome: {
        decision: settled,
        case_id: caseId,
        source_event_id: recorded.event.id,
        deduplicated: false,
      },
    };
  };

  // ── 4. Platform hard bounds, before policy and before the model (SA-2.5).
  const bound = await request.hardBounds.evaluate({
    organizationId: ctx.organizationId,
    externalLeadRef: event.externalLeadRef,
    payload: event.payload ?? {},
  });
  if (bound) {
    return settle(
      decision({
        disposition: "not_admitted",
        reason: "platform_hard_bound",
        policy: HARD_BOUND_ATTRIBUTION,
        hardBound: bound,
      }),
      null
    );
  }

  // ── 5. Effective policy, attributed by version (SA-2.7 / ADR-108).
  const effective = await resolveEffectiveAdmissionPolicy(
    db,
    ctx.organizationId
  );
  if (effective.status === "unavailable") {
    return settle(
      decision({
        disposition: "not_admitted",
        reason: "policy_unavailable",
        policy: effective.attribution,
      }),
      null
    );
  }

  // ── 6. Semantic judgment. The model speaks only now, and only about intent.
  const interpreterInput: AdmissionInterpreterInput = {
    message: event.message ?? null,
    sourceLabel: event.sourceLabel ?? null,
    originLabel: event.originLabel ?? null,
    propertyContext: event.propertyContext ?? null,
    priorMessages: event.priorMessages ?? [],
  };
  const proposal = await request.interpreter.interpret(interpreterInput);

  // ── 7. Policy applied to the proposal (SA-2.3, SA-2.6).
  const settled = applyPolicyToProposal({
    policy: effective.policy,
    attribution: effective.attribution,
    proposal,
    sourceLabel: event.sourceLabel ?? null,
  });

  if (settled.disposition !== "admitted") return settle(settled, null);

  // ── 8. Materialisation. Only an admitted lead reaches this point.
  //
  // Membership is re-checked here rather than trusted from the caller: the
  // Case is about to carry durable responsibility for a named advisor, and a
  // revoked member must not become the owner of new work.
  const membership = await getActiveMembership(
    db,
    ctx.organizationId,
    request.ownerUserId
  );
  if (!membership) {
    throw new Error(
      "runAdmission: ownerUserId is not an active member of the Organization"
    );
  }

  const caseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    LEAD_OPPORTUNITY_CASE_TYPE
  );
  if (!caseType) {
    throw new Error(
      "runAdmission: the lead_opportunity case type is not registered"
    );
  }

  const opportunity = await createOperationalCase(db, {
    userId: request.ownerUserId,
    caseTypeId: caseType.id,
    caseType: LEAD_OPPORTUNITY_CASE_TYPE,
    organizationId: ctx.organizationId,
    // ADR-107: admission decides whether Gu takes durable responsibility. It
    // does not acquire runtime decision authority — legacy still decides, and
    // authority only moves through a separate governed operation.
    runtimeAuthority: "legacy",
    status: "active",
    // No workflow stage: Opportunity progression lives in facts (TD-8, AC-7).
    currentStep: null,
    // Shadow: nothing is scheduled to act on this Case.
    nextActionAt: null,
    context: {
      relationship_ops: true,
      source_system: "traditional_gu",
      legacy_lead_id: event.externalLeadRef,
      source_event_id: recorded.event.id,
      admission_mode: mode,
    },
  });

  // Provenance-bearing facts (SA-2.2). `source_ref` carries the inbox row, so
  // every admitting fact is traceable to the event that produced it.
  //
  // `source_kind` is not uniform on purpose: what Traditional Gu reported is
  // `integration` evidence, while the disposition and the objective are Gu OS
  // conclusions drawn from it and are therefore `derived`. Collapsing the two
  // would make a Gu OS judgment look like a source fact.
  const factProvenance = {
    userId: request.ownerUserId,
    caseId: opportunity.id,
    sourceRef: `source_events:${recorded.event.id}`,
  };

  await insertCaseFact(db, {
    ...factProvenance,
    sourceKind: "derived",
    factKey: ADMISSION_FACT_KEYS.disposition,
    value: settled,
  });
  await insertCaseFact(db, {
    ...factProvenance,
    sourceKind: "integration",
    factKey: ADMISSION_FACT_KEYS.source,
    value: {
      source_system: "traditional_gu",
      event_kind: event.kind,
      legacy_lead_id: event.externalLeadRef,
      source_label: event.sourceLabel ?? null,
      origin_label: event.originLabel ?? null,
      dedup_key: event.dedupKey,
    },
  });
  if (settled.proposal?.objective) {
    await insertCaseFact(db, {
      ...factProvenance,
      sourceKind: "derived",
      factKey: ADMISSION_FACT_KEYS.objective,
      value: {
        objective: settled.proposal.objective,
        category: settled.proposal.objective_category,
      },
      confidence: confidenceToNumber(settled.proposal.confidence),
    });
  }

  await insertOperationalCaseEvent(db, {
    caseId: opportunity.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      kind: "admission_disposition",
      disposition: settled.disposition,
      reason: settled.reason,
      effective_policy: settled.policy,
      source_event_id: recorded.event.id,
    },
  });

  return settle(settled, opportunity.id);
}

/**
 * `case_facts.confidence` is numeric while the interpreter reports a band.
 * Mapped explicitly rather than invented per call site, so the same band always
 * means the same number in stored evidence.
 */
function confidenceToNumber(
  band: AdmissionProposal["confidence"]
): number {
  switch (band) {
    case "high":
      return 0.9;
    case "medium":
      return 0.6;
    case "low":
      return 0.3;
  }
}
