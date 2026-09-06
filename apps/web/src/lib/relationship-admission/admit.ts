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
 *   3. inbox + claim    — one logical event ⇒ one canonical processing owner
 *                          ⇒ one recoverable settled outcome (SA-2.4)
 *   4. platform bounds  — a hard bound wins over any policy and any confident
 *                          model judgment (SA-2.5)
 *   5. policy           — effective policy resolved and attributed by version;
 *                          missing ⇒ platform baseline, invalid ⇒ fail closed
 *                          (SA-2.7)
 *   6. interpretation   — only now does a model run
 *   7. exclusion        — a policy-excluded category is not auto-admitted,
 *                          however confident the judgment (SA-2.6)
 *   8. **record the decision** — durably, before anything irreversible
 *   9. materialisation  — exactly one Opportunity Case, with provenance-bearing
 *                          facts; nothing admitted means no Case at all
 *                          (SA-2.2, EC-01)
 *  10. settlement       — only once everything the decision owes exists
 *
 * Steps 4, 5 and 7 are placed *around* step 6 deliberately. A model that ran
 * first, or whose output was consulted before the bounds, could argue its way
 * past them; here it cannot, because by the time it speaks the bound has
 * already refused and by the time it has spoken the exclusion still applies.
 *
 * ## At-least-once safety (S1 AC-05 and §8.16)
 *
 * A duplicate delivery must never invent an outcome. The inbox row's processing
 * state — not merely its existence — decides what a duplicate gets:
 *
 *   * `completed`  — the settled decision comes back, and when it admitted, the
 *                    canonical Case id with it. Same event, same answer, forever.
 *   * `processing` with a live claim — another worker owns it. The duplicate is
 *                    reported as **in flight**: it does not decide, does not
 *                    create, and does not fabricate `not_admitted`, because an
 *                    unsettled event is "not decided yet".
 *   * `processing` with an expired claim, or `failed`, or `pending` — abandoned,
 *                    so the duplicate reclaims and resumes.
 *
 * ## Why the decision is written before the Case (step 8)
 *
 * Creating the Case first and recording why afterwards leaves a window where an
 * Opportunity exists whose governing policy version is unrecoverable. A retry
 * could then only guess it, or substitute the policy effective at recovery time
 * — rewriting the historical authority context of a consequential decision,
 * which ADR-108 and SA-2.1 forbid. So the decision, with its effective policy
 * attribution, is durable **before** any irreversible write. Recovery replays
 * that decision; it never re-decides and never re-runs the model.
 *
 * ## Why resuming is safe (steps 9–10)
 *
 * Materialisation is idempotent and finishes what the decision owes: the Case
 * (whose creation is structurally unique per source event), the inbox link,
 * each admitting fact, the timeline event, and only then settlement. Every step
 * checks what already exists, so a resume after a crash at any boundary
 * converges on the one canonical materialisation rather than duplicating part
 * of it — and the event is never settled while something it owes is missing.
 *
 * ## Fencing
 *
 * Ownership is durable, not remembered. Each claim carries an epoch, and every
 * write this module makes to the inbox is conditional on it, so a worker that
 * stalls past its lease is locked out the instant another reclaims. Losing the
 * claim is reported, never silently treated as success.
 *
 * Shadow throughout: no prospect-facing effect is reachable from this module.
 * It writes Gu OS rows and nothing else — no send, no legacy write, no
 * suppression of legacy behavior.
 */
import { randomUUID } from "node:crypto";
import { runWithAiUsageContext } from "@agents/agent";
import {
  claimSourceEvent,
  createOperationalCase,
  failSourceEvent,
  findCaseMaterialisedBySourceEvent,
  getActiveMembership,
  getCurrentCaseFacts,
  getGlobalOperationalCaseTypeBySlug,
  getRecentOperationalCaseEvents,
  getRelationshipAdmissionMode,
  getSourceEventById,
  insertCaseFact,
  insertOperationalCaseEvent,
  isClaimExpired,
  isRelationshipOpsEnabled,
  linkAdmittedCase,
  reclaimSourceEvent,
  recordSourceEvent,
  recordSourceEventDecision,
  settleSourceEvent,
  type DbClient,
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
  type SourceEvent,
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

/** Postgres unique-violation: the materialisation race was lost. */
const UNIQUE_VIOLATION = "23505";

/** Why admission did nothing at all. Distinct from deciding not to admit. */
export type AdmissionInertReason =
  | "relationship_ops_disabled"
  | "admission_mode_disabled";

/**
 * The result of one admission call.
 *
 * `in_flight` is a first-class outcome, not an error. It is what a duplicate
 * gets while the original delivery is still being processed, and what a worker
 * gets when it discovers mid-run that it no longer owns the claim. Inventing a
 * disposition in either case is precisely what this shape prevents.
 */
export type AdmissionResult =
  | { status: "inert"; reason: AdmissionInertReason }
  | {
      status: "in_flight";
      sourceEventId: string;
      claimedBy: string | null;
      claimExpiresAt: string | null;
      /** True when THIS call held the claim and lost it to a reclaimer. */
      lostClaim: boolean;
    }
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
  /**
   * Identifies this worker on the claim it takes. Defaults to a per-call id; a
   * runner that wants attributable claims passes its own. Note that the epoch,
   * not this name, is what fences a stale writer out.
   */
  workerId?: string;
  /** Lease length for this run. Shorter values make recovery tests fast. */
  leaseSeconds?: number;
}

/** Raised internally when a fenced write finds the claim is no longer ours. */
class ClaimLost extends Error {
  constructor() {
    super("admission: the claim on this source event was reclaimed");
    this.name = "ClaimLost";
  }
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
 * Rebuilds the settled outcome of an already-completed event.
 *
 * Returning `disposition: admitted` with a null `case_id` would be internally
 * contradictory, so when the pointer is somehow missing the Case is looked up
 * rather than assumed absent.
 */
async function reconstructSettled(
  db: DbClient,
  organizationId: string,
  event: SourceEvent
): Promise<AdmissionOutcome> {
  const settled = event.decision_jsonb as unknown as AdmissionDecision;
  let caseId = event.admitted_case_id;
  if (!caseId && settled?.disposition === "admitted") {
    caseId = await findCaseMaterialisedBySourceEvent(db, {
      organizationId,
      sourceEventId: event.id,
    });
  }
  return {
    decision: settled,
    case_id: caseId ?? null,
    source_event_id: event.id,
    deduplicated: true,
  };
}

function inFlight(event: SourceEvent, lostClaim = false): AdmissionResult {
  return {
    status: "in_flight",
    sourceEventId: event.id,
    claimedBy: event.claimed_by,
    claimExpiresAt: event.claim_expires_at,
    lostClaim,
  };
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
  const workerId = request.workerId ?? `admission:${randomUUID()}`;

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

  // ── 3. Inbox + claim (SA-2.4).
  //
  // The insert is the dedup check: UNIQUE (organization_id, dedup_key) rejects a
  // redelivery, so there is no read-then-write race to lose. What happens next
  // depends on the existing row's PROCESSING STATE, never on its mere existence.
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

  let inbox = recorded.event;

  if (inbox.status === "completed") {
    return {
      status: "evaluated",
      outcome: await reconstructSettled(db, ctx.organizationId, inbox),
    };
  }
  if (inbox.status === "processing" && !isClaimExpired(inbox)) {
    // Someone else owns it right now. Do not decide, do not create, and do not
    // pretend the answer is `not_admitted` — it is simply not settled.
    return inFlight(inbox);
  }

  const claim =
    inbox.status === "pending"
      ? await claimSourceEvent(db, {
          organizationId: ctx.organizationId,
          sourceEventId: inbox.id,
          claimedBy: workerId,
          observedEpoch: inbox.claim_epoch,
          leaseSeconds: request.leaseSeconds,
        })
      : await reclaimSourceEvent(db, {
          organizationId: ctx.organizationId,
          sourceEventId: inbox.id,
          claimedBy: workerId,
          observedEpoch: inbox.claim_epoch,
          leaseSeconds: request.leaseSeconds,
        });

  if (!claim) {
    // Lost the claim race, or the row settled in the meantime.
    const current = await getSourceEventById(db, ctx.organizationId, inbox.id);
    if (current?.status === "completed") {
      return {
        status: "evaluated",
        outcome: await reconstructSettled(db, ctx.organizationId, current),
      };
    }
    return inFlight(current ?? inbox);
  }

  inbox = claim.event;
  const epoch = claim.epoch;
  const sourceEventId = inbox.id;

  try {
    // ── 4–8. Decide, unless a previous attempt already did.
    //
    // Replaying the recorded decision rather than re-deciding is what preserves
    // the ORIGINAL effective policy version: the policy in force now may differ
    // from the one that governed this admission, and attributing the decision
    // to today's version would rewrite history (ADR-108).
    let settled = inbox.decision_jsonb as unknown as AdmissionDecision | null;

    if (!settled) {
      settled = await decide({ request, epoch, sourceEventId });
      // Durable BEFORE anything irreversible.
      if (
        !(await recordSourceEventDecision(db, {
          organizationId: ctx.organizationId,
          sourceEventId,
          epoch,
          decision: settled as unknown as Record<string, unknown>,
        }))
      ) {
        throw new ClaimLost();
      }
    }

    // ── 9–10. Finish everything this decision owes, then settle.
    return await completeMaterialisation({
      db,
      request,
      sourceEventId,
      epoch,
      settled,
    });
  } catch (error) {
    if (error instanceof ClaimLost) {
      const current = await getSourceEventById(db, ctx.organizationId, sourceEventId);
      if (current?.status === "completed") {
        return {
          status: "evaluated",
          outcome: await reconstructSettled(db, ctx.organizationId, current),
        };
      }
      return inFlight(current ?? inbox, true);
    }
    // Release the claim so a retry can reclaim, rather than leaving the
    // dedup_key owned by a dead worker until the lease runs out. Fenced: if we
    // already lost the claim, this changes nothing and must not clobber the new
    // owner's row.
    await failSourceEvent(db, {
      organizationId: ctx.organizationId,
      sourceEventId,
      epoch,
      error: describeFailure(error),
    }).catch(() => undefined);
    throw error;
  }
}

/** Steps 4–7: bounds, policy, model, exclusion. */
async function decide(params: {
  request: AdmissionRequest;
  epoch: number;
  sourceEventId: string;
}): Promise<AdmissionDecision> {
  const { request } = params;
  const { ctx, event } = request;
  const db = ctx.db;

  // ── 4. Platform hard bounds, before policy and before the model (SA-2.5).
  const bound = await request.hardBounds.evaluate({
    organizationId: ctx.organizationId,
    externalLeadRef: event.externalLeadRef,
    payload: event.payload ?? {},
  });
  if (bound) {
    return decision({
      disposition: "not_admitted",
      reason: "platform_hard_bound",
      policy: HARD_BOUND_ATTRIBUTION,
      hardBound: bound,
    });
  }

  // ── 5. Effective policy, attributed by version (SA-2.7 / ADR-108).
  const effective = await resolveEffectiveAdmissionPolicy(db, ctx.organizationId);
  if (effective.status === "unavailable") {
    return decision({
      disposition: "not_admitted",
      reason: "policy_unavailable",
      policy: effective.attribution,
    });
  }

  // ── 6. Semantic judgment. The model speaks only now, and only about intent.
  const interpreterInput: AdmissionInterpreterInput = {
    message: event.message ?? null,
    sourceLabel: event.sourceLabel ?? null,
    originLabel: event.originLabel ?? null,
    propertyContext: event.propertyContext ?? null,
    priorMessages: event.priorMessages ?? [],
  };
  //
  // The model call runs inside a bound AI-usage context, which is what makes
  // its cost attributable (Technical Plan §7 (a), the correlation-coverage
  // check that applies from SL-2). Without this the meter finds no ambient
  // context and DROPS the event: the column would exist and stay empty.
  //
  // `organizationId` is the only correlation dimension available here — the
  // interpreter runs before any Case exists, so `operational_case_id` and
  // `work_item_id` are both genuinely null rather than merely unset.
  // Callback-scoped rather than `bindAiUsageContext`, so admission never leaves
  // its attribution behind in a caller's async context.
  const proposal = await runWithAiUsageContext(
    {
      userId: request.ownerUserId,
      organizationId: ctx.organizationId,
      // A polled, server-initiated path with no interactive channel.
      channel: "cron",
    },
    db,
    () => request.interpreter.interpret(interpreterInput)
  );

  // ── 7. Policy applied to the proposal (SA-2.3, SA-2.6).
  return applyPolicyToProposal({
    policy: effective.policy,
    attribution: effective.attribution,
    proposal,
    sourceLabel: event.sourceLabel ?? null,
  });
}

/**
 * Writes everything the decision owes, then settles. Idempotent at every step.
 *
 * The owed set for an admitted decision is:
 *
 *   1. the Opportunity Case — creation is structurally unique per source event,
 *      so two workers cannot both create one;
 *   2. `source_events.admitted_case_id` — the recovery anchor;
 *   3. the `admission.disposition` fact;
 *   4. the `admission.source` fact;
 *   5. the `opportunity.objective` fact, when the decision carries an objective;
 *   6. the admission timeline event;
 *   7. settlement.
 *
 * A resume checks each before writing it, so a crash at any boundary converges
 * on exactly one canonical materialisation. Settlement is last and unconditional
 * on nothing: the event is never marked completed while something it owes is
 * missing.
 */
async function completeMaterialisation(params: {
  db: DbClient;
  request: AdmissionRequest;
  sourceEventId: string;
  epoch: number;
  settled: AdmissionDecision;
}): Promise<AdmissionResult> {
  const { db, request, sourceEventId, epoch, settled } = params;
  const { ctx, event } = request;

  const settle = async (caseId: string | null): Promise<AdmissionResult> => {
    const applied = await settleSourceEvent(db, {
      organizationId: ctx.organizationId,
      sourceEventId,
      epoch,
      decision: settled as unknown as Record<string, unknown>,
      admittedCaseId: caseId,
    });
    if (!applied) throw new ClaimLost();
    return {
      status: "evaluated",
      outcome: {
        decision: settled,
        case_id: caseId,
        source_event_id: sourceEventId,
        deduplicated: false,
      },
    };
  };

  if (settled.disposition !== "admitted") return settle(null);

  // Membership is re-checked here rather than trusted from the caller: the Case
  // is about to carry durable responsibility for a named advisor, and a revoked
  // member must not become the owner of new work.
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

  // ── 1. The Case. Find first — a resume, or a lost materialisation race.
  let caseId = await findCaseMaterialisedBySourceEvent(db, {
    organizationId: ctx.organizationId,
    sourceEventId,
  });

  if (!caseId) {
    const caseType = await getGlobalOperationalCaseTypeBySlug(
      db,
      LEAD_OPPORTUNITY_CASE_TYPE
    );
    if (!caseType) {
      throw new Error(
        "runAdmission: the lead_opportunity case type is not registered"
      );
    }
    try {
      const opportunity = await createOperationalCase(db, {
        userId: request.ownerUserId,
        caseTypeId: caseType.id,
        caseType: LEAD_OPPORTUNITY_CASE_TYPE,
        organizationId: ctx.organizationId,
        // ADR-107: admission decides whether Gu takes durable responsibility. It
        // does not acquire runtime decision authority — legacy still decides,
        // and authority only moves through a separate governed operation.
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
          // The materialisation identity. A partial UNIQUE index on this makes
          // "one source event admits at most one Opportunity" structural, so a
          // worker past the fence still cannot create a second one.
          source_event_id: sourceEventId,
          admission_mode: "shadow",
        },
      });
      caseId = opportunity.id;
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      // Another worker materialised it first. Converge on theirs.
      caseId = await findCaseMaterialisedBySourceEvent(db, {
        organizationId: ctx.organizationId,
        sourceEventId,
      });
      if (!caseId) throw error;
    }
  }

  // ── 2. The recovery anchor, before any fact.
  if (
    !(await linkAdmittedCase(db, {
      organizationId: ctx.organizationId,
      sourceEventId,
      epoch,
      caseId,
    }))
  ) {
    throw new ClaimLost();
  }

  // ── 3–5. The admitting facts, each written only if it is missing.
  //
  // `source_kind` is not uniform on purpose: what Traditional Gu reported is
  // `integration` evidence, while the disposition and the objective are Gu OS
  // conclusions drawn from it and are therefore `derived`. Collapsing the two
  // would make a Gu OS judgment look like a source fact.
  const existingFacts = await getCurrentCaseFacts(
    db,
    request.ownerUserId,
    caseId
  );
  const factProvenance = {
    userId: request.ownerUserId,
    caseId,
    sourceRef: `source_events:${sourceEventId}`,
  };

  if (!existingFacts.has(ADMISSION_FACT_KEYS.disposition)) {
    await insertCaseFact(db, {
      ...factProvenance,
      sourceKind: "derived",
      factKey: ADMISSION_FACT_KEYS.disposition,
      value: settled,
    });
  }
  if (!existingFacts.has(ADMISSION_FACT_KEYS.source)) {
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
  }
  if (
    settled.proposal?.objective &&
    !existingFacts.has(ADMISSION_FACT_KEYS.objective)
  ) {
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

  // ── 6. The timeline event, once. `operational_case_events` is append-only
  // with no dedup of its own, so a resume must check rather than re-append.
  const timeline = await getRecentOperationalCaseEvents(db, caseId, 50);
  const alreadyRecorded = timeline.some((entry) => {
    const payload = entry.payload_jsonb as Record<string, unknown> | null;
    return (
      payload?.kind === "admission_disposition" &&
      payload?.source_event_id === sourceEventId
    );
  });
  if (!alreadyRecorded) {
    await insertOperationalCaseEvent(db, {
      caseId,
      eventType: "state_changed",
      actor: "system",
      payload: {
        kind: "admission_disposition",
        disposition: settled.disposition,
        reason: settled.reason,
        effective_policy: settled.policy,
        source_event_id: sourceEventId,
      },
    });
  }

  // ── 7. Only now.
  return settle(caseId);
}

/**
 * A readable failure string.
 *
 * PostgREST rejects with a plain `{ code, message }` object rather than an
 * Error, and `String(...)` on one yields "[object Object]" — a processing_error
 * that tells an operator nothing about why the event failed.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const shaped = error as { code?: unknown; message?: unknown };
    const message =
      typeof shaped.message === "string" ? shaped.message : JSON.stringify(error);
    return typeof shaped.code === "string"
      ? `${shaped.code}: ${message}`
      : message;
  }
  return String(error);
}

/**
 * `case_facts.confidence` is numeric while the interpreter reports a band.
 * Mapped explicitly rather than invented per call site, so the same band always
 * means the same number in stored evidence.
 */
function confidenceToNumber(band: AdmissionProposal["confidence"]): number {
  switch (band) {
    case "high":
      return 0.9;
    case "medium":
      return 0.6;
    case "low":
      return 0.3;
  }
}
