/**
 * Ingestion: turning a Traditional Gu lead into an admission evaluation
 * (R1 SL-2, Technical Plan §3 · AC-1 §6.7).
 *
 * The shadow-stage path is a **narrowly scoped poll**, which AC-1 §6.7
 * explicitly permits when a source lacks events, on the condition that it stays
 * encapsulated inside the integration boundary and emits the same normalized
 * wake-up semantics as the eventual push. That is what this module is: it reads
 * through the SL-1 capabilities, normalizes, derives a stable `dedup_key`, and
 * hands `runAdmission` exactly the shape cross-repo contract C1 will hand it
 * later. When C1 ships, only the producer changes.
 *
 * **What this module deliberately does not do: discover leads.** Finding lead
 * ids Gu OS has never seen would need a listing read, and SL-1's capability
 * vocabulary is closed — `legacy_lead_get_context`,
 * `legacy_lead_get_recent_messages`, `appointment_get`, `property_get_details`
 * — with widening it declared a capability-surface change that belongs to a
 * Slice rather than a call site. So the caller supplies which leads to evaluate.
 * Continuous discovery arrives with C1 event forwarding (SL-5) or with a
 * separately decided bounded discovery capability; it is named here rather than
 * smuggled in as a generic read.
 */
import type {
  LegacyConversationItem,
  LegacyLeadContext,
  LegacyReadResult,
  LegacyRecentMessages,
} from "@agents/types";
import { buildSourceEventDedupKey } from "@agents/types";
import {
  readLegacyLeadContext,
  readLegacyLeadRecentMessages,
} from "../legacy-gateway";
import type { GatewayCallerContext } from "../legacy-gateway/authorization";
import { runAdmission, type AdmissionResult } from "./admit";
import type { AdmissionInterpreter } from "./interpreter";
import type { PlatformHardBoundProbe } from "./hard-bounds";

/** How many recent messages the admission read asks the gateway for. */
const RECENT_MESSAGE_LIMIT = 20;

/**
 * The newest inbound prospect message across every thread.
 *
 * "Inbound" matters: an advisor's own outbound message is not a prospect
 * signal, and admitting on one would create responsibility from Gu's own
 * activity rather than from the prospect's.
 */
export function latestInboundMessage(
  messages: LegacyRecentMessages
): LegacyConversationItem | null {
  const inbound = messages.items.filter(
    (item) => item.direction === "inbound" && (item.text ?? "").trim() !== ""
  );
  return inbound.length > 0 ? inbound[inbound.length - 1] : null;
}

/**
 * Derives the stable identity of this delivery.
 *
 * Prefers the provider message id, which is the source's own stable identity
 * for the event. Falls back to the message timestamp, then — when the source
 * carried neither — to the lead's own `updatedAt`.
 *
 * The fallback matters for a *poll* specifically: without a discriminator every
 * poll of the same lead would produce a different key and admit repeatedly, so
 * the absence of a provider id must degrade to something stable rather than to
 * something unique-per-call.
 */
export function deriveDedupKey(params: {
  legacyLeadId: string;
  message: LegacyConversationItem | null;
  leadUpdatedAt: string | null;
}): string {
  const discriminator =
    params.message?.wamid ??
    params.message?.timestamp ??
    params.leadUpdatedAt ??
    "no_discriminator";
  return buildSourceEventDedupKey({
    sourceSystem: "traditional_gu",
    eventKind: "inbound_prospect_message",
    externalRef: params.legacyLeadId,
    discriminator,
  });
}

export interface IngestLegacyLeadParams {
  ctx: GatewayCallerContext;
  legacyLeadId: string;
  ownerUserId: string;
  interpreter: AdmissionInterpreter;
  hardBounds: PlatformHardBoundProbe;
  env?: Record<string, string | undefined>;
}

export interface IngestLegacyLeadResult {
  result: AdmissionResult;
  /** Provenance of both gateway reads, so evidence can state what was read. */
  provenance: {
    context: LegacyReadResult<LegacyLeadContext>["provenance"];
    messages: LegacyReadResult<LegacyRecentMessages>["provenance"];
  };
  /** Whether any inbound prospect message was found at all. */
  hadInboundMessage: boolean;
}

/**
 * Reads one lead through the SL-1 gateway and evaluates it for admission.
 *
 * Both reads pass the gateway's Organization gate independently — this module
 * adds no authorization of its own and removes none, so a lead outside the
 * calling Organization is refused by the gateway before any data is returned.
 */
export async function ingestLegacyLead(
  params: IngestLegacyLeadParams
): Promise<IngestLegacyLeadResult> {
  const context = await readLegacyLeadContext(params.ctx, params.legacyLeadId);
  const messages = await readLegacyLeadRecentMessages(
    params.ctx,
    params.legacyLeadId,
    RECENT_MESSAGE_LIMIT
  );

  const latest = latestInboundMessage(messages.value);
  const priorInbound = messages.value.items
    .filter((item) => item.direction === "inbound" && item.text)
    .map((item) => item.text as string);

  const result = await runAdmission({
    ctx: params.ctx,
    ownerUserId: params.ownerUserId,
    interpreter: params.interpreter,
    hardBounds: params.hardBounds,
    env: params.env,
    event: {
      kind: "inbound_prospect_message",
      externalLeadRef: params.legacyLeadId,
      dedupKey: deriveDedupKey({
        legacyLeadId: params.legacyLeadId,
        message: latest,
        leadUpdatedAt: context.value.updatedAt,
      }),
      message: latest?.text ?? null,
      // The newest message is the subject; everything before it is context.
      priorMessages: priorInbound.slice(0, -1),
      sourceLabel: latest?.source ?? null,
      originLabel: context.value.originLabel,
      propertyContext: null,
      // Allowlisted, non-content metadata only. Message text is passed to the
      // interpreter for judgment but never persisted on the inbox row: the
      // event record does not need to be a second copy of the conversation.
      payload: {
        legacy_status: context.value.status,
        client_type: context.value.clientType,
        assignment_type: context.value.assignmentType,
        thread_count: messages.value.threads.length,
        inbound_message_count: priorInbound.length,
        truncated: messages.value.truncated,
      },
      provenance: {
        context: context.provenance,
        messages: messages.provenance,
      },
    },
  });

  return {
    result,
    provenance: {
      context: context.provenance,
      messages: messages.provenance,
    },
    hadInboundMessage: latest !== null,
  };
}

/**
 * Evaluates a bounded list of leads, one at a time.
 *
 * Sequential rather than concurrent: AC-1 §6.6 requires that multiple wake
 * signals for one Opportunity never produce concurrent conflicting Case
 * decisions, and a shadow-stage poll has no throughput problem worth trading
 * that for.
 *
 * A refusal or fault on one lead does not stop the batch — it is recorded and
 * the poll continues, because one unreadable lead must not silently halt
 * ingestion for every other one.
 */
export async function pollLegacyLeads(params: {
  ctx: GatewayCallerContext;
  legacyLeadIds: readonly string[];
  ownerUserId: string;
  interpreter: AdmissionInterpreter;
  hardBounds: PlatformHardBoundProbe;
  env?: Record<string, string | undefined>;
}): Promise<
  Array<
    | { legacyLeadId: string; ok: true; ingested: IngestLegacyLeadResult }
    | { legacyLeadId: string; ok: false; error: string }
  >
> {
  const results: Array<
    | { legacyLeadId: string; ok: true; ingested: IngestLegacyLeadResult }
    | { legacyLeadId: string; ok: false; error: string }
  > = [];
  for (const legacyLeadId of params.legacyLeadIds) {
    try {
      results.push({
        legacyLeadId,
        ok: true,
        ingested: await ingestLegacyLead({ ...params, legacyLeadId }),
      });
    } catch (error) {
      results.push({
        legacyLeadId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
