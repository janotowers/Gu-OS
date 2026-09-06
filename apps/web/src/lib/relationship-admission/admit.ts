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
 *   8. materialisation  — exactly one Opportunity Case, with provenance-bearing
 *                          facts; nothing admitted means no Case at all
 *                          (SA-2.2, EC-01)
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
 *   * `completed`  — the settled decision is returned, and when it admitted, the
 *                    canonical Case id comes back with it. Same event, same
 *                    answer, forever.
 *   * `processing` with a live claim — another worker owns it. The duplicate is
 *                    reported as **in flight**. It does not decide, does not
 *                    create, and does not fabricate `not_admitted`: an unsettled
 *                    event is "not decided yet", never "decided not to admit".
 *   * `processing` with an expired claim, or `failed`, or `pending` — abandoned.
 *                    The duplicate reclaims the lease and reconciles: if a Case
 *                    was already materialised it converges on that Case rather
 *                    than creating a second Opportunity, reconstructing the
 *                    decision from the durable admission fact already written.
 *
 * Materialisation therefore writes in a recovery-safe order: create the Case,
 * immediately link it to the inbox row, then the facts, then settle. Every crash
 * point leaves either no Case or a findable one.
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
  getRelationshipAdmissionMode,
  getSourceEventById,
  insertCaseFact,
  insertOperationalCaseEvent,
  isClaimExpired,
  isRelationshipOpsEnabled,
  linkAdmittedCase,
  reclaimSourceEvent,
  recordSourceEvent,
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

/** Why admission did nothing at all. Distinct from deciding not to admit. */
export type AdmissionInertReason =
  | "relationship_ops_disabled"
  | "admission_mode_disabled";

/**
 * The result of one admission call.
 *
 * `in_flight` is a first-class outcome, not an error. It is what a duplicate
 * gets while the original delivery is still being processed, and inventing a
 * disposition there is precisely the defect this shape exists to prevent.
 */
export type AdmissionResult =
  | { status: "inert"; reason: AdmissionInertReason }
  | {
      status: "in_flight";
      sourceEventId: string;
      claimedBy: string | null;
      claimExpiresAt: string | null;
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
   * Identifies this worker on the claim it takes. Defaults to a per-call id;
   * a runner that wants its claims attributable passes its own.
   */
  workerId?: string;
  /** Lease length for this run. Shorter values make recovery tests fast. */
  leaseSeconds?: number;
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
 * Rebuilds the settled decision of an already-completed event.
 *
 * `decision_jsonb` is the record written at settlement; `admitted_case_id` is
 * the canonical Case. Returning `disposition: admitted` with a null `case_id`
 * would be internally contradictory, so when the pointer is somehow missing the
 * Case is looked up rather than assumed absent.
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

/**
 * Recovers the decision of an event that materialised a Case but died before
 * settlement.
 *
 * The Case's `admission.disposition` fact is the durable record of what was
 * actually decided, so recovery reads it rather than re-deciding — re-running
 * the model could produce a different answer and contradict the Case already
 * written. Returns null when no such fact exists, which means the crash landed
 * between Case creation and the first fact.
 */
async function recoverDecisionFromCase(
  db: DbClient,
  params: { ownerUserId: string; caseId: string }
): Promise<AdmissionDecision | null> {
  const facts = await getCurrentCaseFacts(db, params.ownerUserId, params.caseId);
  const fact = facts.get(ADMISSION_FACT_KEYS.disposition);
  if (!fact) return null;
  return fact.value_jsonb as unknown as AdmissionDecision;
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
  /** Set when this call is recovering an abandoned attempt rather than starting one. */
  let recovering = false;

  if (recorded.created) {
    const claimed = await claimSourceEvent(db, {
      organizationId: ctx.organizationId,
      sourceEventId: inbox.id,
      claimedBy: workerId,
      leaseSeconds: request.leaseSeconds,
    });
    if (!claimed) {
      // Another worker claimed the row between our insert and our claim.
      const current = await reloadInbox(db, ctx.organizationId, inbox.id);
      return inFlight(current ?? inbox);
    }
    inbox = claimed;
  } else {
    // A duplicate. Its processing state decides everything.
    if (inbox.status === "completed") {
      return {
        status: "evaluated",
        outcome: await reconstructSettled(db, ctx.organizationId, inbox),
      };
    }
    if (inbox.status === "processing" && !isClaimExpired(inbox)) {
      // Someone else owns it right now. Do not decide, do not create, and do
      // not pretend the answer is `not_admitted` — it is simply not settled.
      return inFlight(inbox);
    }
    // pending (the original died before claiming), an expired lease, or a
    // failed attempt: reclaimable.
    const reclaimed =
      inbox.status === "pending"
        ? await claimSourceEvent(db, {
            organizationId: ctx.organizationId,
            sourceEventId: inbox.id,
            claimedBy: workerId,
            leaseSeconds: request.leaseSeconds,
          })
        : await reclaimSourceEvent(db, {
            organizationId: ctx.organizationId,
            sourceEventId: inbox.id,
            claimedBy: workerId,
            leaseSeconds: request.leaseSeconds,
          });
    if (!reclaimed) {
      // Lost the reclaim race, or the row settled in the meantime.
      const current = await reloadInbox(db, ctx.organizationId, inbox.id);
      if (current?.status === "completed") {
        return {
          status: "evaluated",
          outcome: await reconstructSettled(db, ctx.organizationId, current),
        };
      }
      return inFlight(current ?? inbox);
    }
    inbox = reclaimed;
    recovering = true;
  }

  const sourceEventId = inbox.id;

  const settle = async (
    settled: AdmissionDecision,
    caseId: string | null
  ): Promise<AdmissionResult> => {
    await settleSourceEvent(db, {
      organizationId: ctx.organizationId,
      sourceEventId,
      decision: settled as unknown as Record<string, unknown>,
      admittedCaseId: caseId,
    });
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

  try {
    // ── 3b. Reconciliation, before anything is decided again.
    //
    // A reclaimed event may already have materialised a Case. Deciding afresh
    // could contradict what is durably written, and creating again would be a
    // second Opportunity for one admitted event (S1 §8.16). So converge first.
    if (recovering) {
      const existingCaseId =
        inbox.admitted_case_id ??
        (await findCaseMaterialisedBySourceEvent(db, {
          organizationId: ctx.organizationId,
          sourceEventId,
        }));
      if (existingCaseId) {
        const recovered = await recoverDecisionFromCase(db, {
          ownerUserId: request.ownerUserId,
          caseId: existingCaseId,
        });
        if (recovered) return settle(recovered, existingCaseId);
        // A Case exists but carries no disposition fact: the crash landed
        // between creation and the first fact. Finish that materialisation on
        // the SAME Case rather than creating another one.
        return finishMaterialisation({
          db,
          request,
          sourceEventId,
          caseId: existingCaseId,
          settled: null,
          settle,
        });
      }
    }

    // ── 4. Platform hard bounds, before policy and before the model (SA-2.5).
    const bound = await request.hardBounds.evaluate({
      organizationId: ctx.organizationId,
      externalLeadRef: event.externalLeadRef,
      payload: event.payload ?? {},
    });
    if (bound) {
      return await settle(
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
      return await settle(
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
    //
    // The model call runs inside a bound AI-usage context, which is what makes
    // its cost attributable (Technical Plan §7 (a), the correlation-coverage
    // check that applies from SL-2). Without this the meter finds no ambient
    // context and DROPS the event: the column would exist and stay empty.
    //
    // `organizationId` is the only correlation dimension available here — the
    // interpreter runs before any Case exists, so `operational_case_id` and
    // `work_item_id` are both genuinely null rather than merely unset.
    // Callback-scoped rather than `bindAiUsageContext`, so admission never
    // leaves its attribution behind in a caller's async context.
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
    const settled = applyPolicyToProposal({
      policy: effective.policy,
      attribution: effective.attribution,
      proposal,
      sourceLabel: event.sourceLabel ?? null,
    });

    if (settled.disposition !== "admitted") return await settle(settled, null);

    // ── 8. Materialisation. Only an admitted lead reaches this point.
    return await finishMaterialisation({
      db,
      request,
      sourceEventId,
      caseId: null,
      settled,
      settle,
    });
  } catch (error) {
    // The claim must not outlive the attempt. Marking the row `failed` releases
    // it for a later reclaim instead of leaving the dedup_key owned by a dead
    // worker until its lease runs out.
    await failSourceEvent(db, {
      organizationId: ctx.organizationId,
      sourceEventId,
      error: describeFailure(error),
    }).catch(() => undefined);
    throw error;
  }
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

function inFlight(event: SourceEvent): AdmissionResult {
  return {
    status: "in_flight",
    sourceEventId: event.id,
    claimedBy: event.claimed_by,
    claimExpiresAt: event.claim_expires_at,
  };
}

async function reloadInbox(
  db: DbClient,
  organizationId: string,
  sourceEventId: string
): Promise<SourceEvent | null> {
  return getSourceEventById(db, organizationId, sourceEventId);
}

/**
 * Creates (or completes) the Opportunity Case for an admitted event.
 *
 * Write order is the recovery contract:
 *
 *   1. the Case row — carrying `source_event_id` in its context, so it is
 *      findable even before step 2 lands;
 *   2. `source_events.admitted_case_id` — the durable pointer;
 *   3. the provenance-bearing facts, disposition first;
 *   4. the Case timeline event;
 *   5. settlement.
 *
 * A crash at any point leaves either no Case, or a Case a retry will find.
 * `caseId` non-null means this call is finishing a materialisation an earlier
 * attempt started, and `settled` null means the disposition must be re-derived
 * because the earlier attempt never recorded one.
 */
async function finishMaterialisation(params: {
  db: DbClient;
  request: AdmissionRequest;
  sourceEventId: string;
  caseId: string | null;
  settled: AdmissionDecision | null;
  settle: (
    settled: AdmissionDecision,
    caseId: string | null
  ) => Promise<AdmissionResult>;
}): Promise<AdmissionResult> {
  const { db, request, sourceEventId } = params;
  const { ctx, event } = request;

  // A disposition is required to finish. When recovery found a Case with no
  // disposition fact, the Case's existence is itself durable evidence that an
  // admission occurred — so converge on `admitted` rather than re-deciding and
  // risking a verdict that contradicts the Case already written.
  //
  // The attribution is re-resolved rather than invented, and the reason says
  // exactly what happened: the original attempt never recorded one. Claiming
  // `clear_objective` here would assert a judgment this call never made.
  let settled = params.settled;
  if (!settled) {
    const effective = await resolveEffectiveAdmissionPolicy(
      db,
      ctx.organizationId
    );
    settled = decision({
      disposition: "admitted",
      reason: "recovered_incomplete_materialisation",
      policy: {
        ...effective.attribution,
        matched_rule: "recovered_from_incomplete_materialisation",
      },
    });
  }

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

  let caseId = params.caseId;
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
        // The recovery anchor that exists from the Case's first instant.
        source_event_id: sourceEventId,
        admission_mode: "shadow",
      },
    });
    caseId = opportunity.id;

    // Immediately, before any fact: from here on a crash is recoverable
    // through the inbox row alone.
    await linkAdmittedCase(db, {
      organizationId: ctx.organizationId,
      sourceEventId,
      caseId,
    });
  }

  // Provenance-bearing facts (SA-2.2). `source_ref` carries the inbox row, so
  // every admitting fact is traceable to the event that produced it.
  //
  // `source_kind` is not uniform on purpose: what Traditional Gu reported is
  // `integration` evidence, while the disposition and the objective are Gu OS
  // conclusions drawn from it and are therefore `derived`. Collapsing the two
  // would make a Gu OS judgment look like a source fact.
  const factProvenance = {
    userId: request.ownerUserId,
    caseId,
    sourceRef: `source_events:${sourceEventId}`,
  };

  // Disposition first: it is what recovery reads to avoid re-deciding.
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

  return params.settle(settled, caseId);
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
