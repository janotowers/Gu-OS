/**
 * Semantic Human Interactions — the TD-15 v1 typed contract (R1 SL-7).
 *
 * Cross-domain by construction: nothing here is Relationship-specific. The
 * Experience Architecture (§7) owns the semantic primitives; Technical Plan
 * TD-15 selects the minimum R1 actually emits and fixes three rules this module
 * exists to keep:
 *
 *  - **semantics, never rendering.** A payload says what is being asked of a
 *    human and why, with references to durable truth. How a surface draws it —
 *    a web chip, a Telegram keyboard — is the adapter's business, and the
 *    CURRENT `hitl-action-contract` is that adapter layer (TD-15 point 3);
 *  - **recommendation ≠ fact ≠ approval.** They are distinct types below and no
 *    field accepts one where another is meant (Experience Architecture §7.6);
 *  - **unknown and conflict survive rendering.** An effect whose outcome is
 *    unknown carries the literal `unknown_outcome`, never a best guess, and an
 *    authority that could not be resolved carries `unknown` or `conflicting`.
 *
 * Which variants have a producer in SL-7 is a separate, deliberate question.
 * The Work Portfolio projects `InformationRequest` and `HumanWorkRequest` from
 * live Work (blocked-on-human), `HumanWorkRequest` from due advisor
 * commitments, and `ExceptionReview` for stalled responsibility. The
 * `ApprovalRequest` and the other two `ExceptionReview` kinds are **types
 * only** until their producers exist — SL-9 (approval-gated sends, the effect
 * ledger) and SL-6 (the authority resolver) — and `DecisionRequest` /
 * `EvidenceRequest` until S3's reconciliation asks for them (SL-8). Slice Plan
 * SL-7, D4: no rows, no placeholder data.
 *
 * `Takeover` and `Return-to-Gu` are excluded from v1 on purpose (TD-15): R1
 * has no Gu OS-owned takeover control to render — authority appears in the
 * Portfolio as projection content, not as an interactive primitive.
 */

/**
 * A pointer at the durable row a claim rests on.
 *
 * Every semantic field of an interaction or an attention item cites these
 * instead of free text (Slice Plan SA-7.3; AC-9 §14.4 "the evidence it
 * reasons over must remain traceable"). The id is the row's primary key.
 */
export type DurableRef =
  | { kind: "case"; id: string }
  | { kind: "case_fact"; id: string; fact_key: string }
  | { kind: "case_subject"; id: string; subject_kind: string }
  | { kind: "case_event"; id: string; event_kind: string }
  | { kind: "work_item"; id: string }
  | { kind: "case_approval"; id: string }
  /** The durable request an ApprovalRequest projects. No producer before SL-9. */
  | { kind: "approval_request"; id: string }
  /** An external effect operation (TD-6). No producer before SL-9. */
  | { kind: "external_effect_operation"; id: string }
  /** An authority resolution (TD-3). No producer before SL-6. */
  | { kind: "authority_resolution"; id: string };

export type DurableRefKind = DurableRef["kind"];

/** Who asked. A Case or Work reference, never a display name. */
export interface InteractionRequester {
  kind: "agent" | "system" | "human";
  ref: DurableRef | null;
}

/**
 * A recommendation is a proposal, not a fact and not an approval.
 * Kept as its own type so it can never be passed where either is expected.
 */
export interface Recommendation {
  readonly recommendation: string;
  readonly basis_refs: readonly DurableRef[];
}

interface HumanInteractionBase {
  v: 1;
  /**
   * Stable identity of the interaction: the kind and id of the durable row it
   * projects (`work_item:<uuid>`). Two projections of the same need carry the
   * same id, which is what lets a second surface see that it was answered
   * (S4 §13: resolved in Telegram ⇒ the web must not ask again).
   */
  interaction_id: string;
  case_id: string;
  organization_id: string;
  requested_by: InteractionRequester;
  /** When the need began, from durable truth. */
  requested_at: string;
  /** What the need rests on. Never empty for an emitted interaction. */
  evidence_refs: readonly DurableRef[];
}

/**
 * A protected decision requires explicit human authorization under current
 * context (Experience Architecture §7.1). The evidence it is decided on is
 * pinned by hash, so a decision is always about a basis someone saw.
 *
 * Types only in SL-7: no Organization-Case producer exists before SL-9.
 */
export interface ApprovalRequest extends HumanInteractionBase {
  interaction: "approval_request";
  /** The CURRENT `case_approvals.approval_kind` the decision is recorded under. */
  approval_kind: string;
  /** What is being approved, as the producer stated it. */
  decision_subject: string;
  /** What approving or rejecting changes. */
  consequence: string | null;
  evidence_hash: string;
  evidence_snapshot: Record<string, unknown>;
  recommendation: Recommendation | null;
}

/** A choice between stated options. No producer in R1 before SL-8. */
export interface DecisionRequest extends HumanInteractionBase {
  interaction: "decision_request";
  question: string;
  options: ReadonlyArray<{ id: string; label: string; consequence: string | null }>;
  recommendation: Recommendation | null;
}

/**
 * Gu needs knowledge or judgment only a human has — the supervisor's targeted
 * human input (S2 §8.1 invariant 13). Answered through the Work Item that
 * carries it, which is why that Work Item is named.
 */
export interface InformationRequest extends HumanInteractionBase {
  interaction: "information_request";
  /** The question, as the requesting Work states its purpose. */
  question: string;
  work_item_id: string;
}

/**
 * Admissible evidence supporting a specific claim (S3). Kept distinct from
 * InformationRequest because claim-binding and admissibility must survive
 * rendering (TD-15). No producer before SL-8.
 */
export interface EvidenceRequest extends HumanInteractionBase {
  interaction: "evidence_request";
  claim: string;
  claim_ref: DurableRef;
}

/**
 * A human must perform or finish something. Either a Work Item handed to a
 * human (the CURRENT human executor leaves it in `review`), or a commitment a
 * human made that has come due.
 */
export interface HumanWorkRequest extends HumanInteractionBase {
  interaction: "human_work_request";
  /** What the human is expected to do, from durable truth. */
  expected: string;
  /** The Work Item that closes it, when one exists. */
  work_item_id: string | null;
  /** The commitment subject it fulfils, when that is what it is. */
  commitment_subject_id: string | null;
}

/**
 * Something Gu cannot resolve on its own and a human must review. The kind is
 * explicit and the uncertain state is carried literally, never coerced.
 */
export type ExceptionReview = HumanInteractionBase & {
  interaction: "exception_review";
} & (
    | {
        exception: "authority_conflict";
        /** TD-3's fail-safe states. Never rendered as a settled authority. */
        authority_state: "unknown" | "conflicting";
      }
    | {
        exception: "unknown_effect_outcome";
        capability: string;
        /** Literal: an uncertain effect is never rendered as success. */
        outcome: "unknown_outcome";
      }
    | {
        exception: "stalled_responsibility";
        /** The runtime authority under which the responsibility is Gu OS's. */
        runtime_authority: "gu_os";
      }
  );

export type HumanInteractionPayload =
  | ApprovalRequest
  | DecisionRequest
  | InformationRequest
  | EvidenceRequest
  | HumanWorkRequest
  | ExceptionReview;

export type HumanInteractionKind = HumanInteractionPayload["interaction"];

export const HUMAN_INTERACTION_KINDS: readonly HumanInteractionKind[] = [
  "approval_request",
  "decision_request",
  "information_request",
  "evidence_request",
  "human_work_request",
  "exception_review",
] as const;

/**
 * The versioned envelope a `structured_payload` writer carries the typed
 * payload in (TD-15 point 3): the brownfield seam stays, its content for new
 * flows becomes contract-typed. No SL-7 flow writes a notification, so nothing
 * emits this yet; it is declared so the first producer does not invent a shape.
 */
export interface HumanInteractionEnvelope {
  semantic: HumanInteractionPayload;
  v: 1;
}

/** `work_item:<id>` — the stable interaction identity of a durable row. */
export function interactionIdFor(ref: DurableRef): string {
  return `${ref.kind}:${ref.id}`;
}
