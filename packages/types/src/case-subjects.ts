/**
 * Case Subjects and subject-scoped facts (Technical Plan TD-14, approved with
 * the plan).
 *
 * A cross-domain kernel primitive, not a Relationship Operations table. Some
 * things a Case tracks have their own identity and their own evidence history
 * — a Commitment (R1 SL-4), a Visit (R1 SL-8), a Transaction document or a
 * Demand ad later. TD-14 gives each one a row whose only job is to *be* that
 * identity, and leaves everything that can change to `case_facts` rows scoped
 * to it.
 *
 * Two consequences worth stating, because they are what the design buys:
 *
 *  - **no entity id inside `fact_key`.** `commitment.<uuid>.due` was rejected
 *    as accidental schema in a string — per-item reads become prefix scans and
 *    enumeration becomes key parsing. Keys stay clean (`commitment.due`) and
 *    the identity lives in `subject_id`;
 *  - **no lifecycle columns on the subject row.** A mutable single-status
 *    record is exactly what S3 §12.1 forbids, and it would duplicate the
 *    provenance and supersession mechanics `case_facts` already has.
 *
 * Tenancy is derived, never supplied: these rows carry no `organization_id`,
 * because the parent Case owns it and the `case_id` FK makes that structural.
 */

/**
 * R1 subject kinds. Mirrors the CHECK constraint in the M-SUBJECTS migration.
 *
 * `commitment` is consumed by SL-4; `visit` by SL-8. Both are declared here
 * because TD-14 defines the R1 registry as one unit — the kind lives on the
 * subject row, never inside a `fact_key`.
 */
export type CaseSubjectKind = "visit" | "commitment";

export const CASE_SUBJECT_KINDS: readonly CaseSubjectKind[] = [
  "visit",
  "commitment",
] as const;

/** Who or what created the subject. Same vocabulary as `case_relationships`. */
export type CaseSubjectActorKind = "human" | "agent" | "system";

/**
 * An immutable identity anchor inside one Case.
 *
 * There is deliberately no `status`, no `due_at`, no `resolved_at`: a
 * Commitment's due date and status are subject-scoped facts, so a change
 * supersedes rather than overwrites and the history stays reconstructible.
 */
export interface CaseSubject {
  id: string;
  case_id: string;
  subject_kind: CaseSubjectKind;
  label: string | null;
  /**
   * Minimal identity attributes known AT CREATION — e.g. a Visit's property
   * external ref. Not state: anything that evolves is a fact.
   */
  attrs_jsonb: Record<string, unknown>;
  created_by_user_id: string | null;
  actor_kind: CaseSubjectActorKind;
  source_kind: string;
  source_ref: string | null;
  provenance_jsonb: Record<string, unknown>;
  created_at: string;
}

/**
 * External reference kinds a subject can accumulate. Append-only with per-row
 * provenance: a legacy reschedule that mutates the appointment id produces a
 * SECOND row on the same subject rather than editing the first, so continuity
 * is preserved and which reference currently binds stays a domain judgment
 * (S3) rather than a schema rule.
 *
 * Not consumed by SL-4.
 */
export type CaseSubjectExternalRefKind =
  | "legacy_appointment"
  | "calendar_event"
  | "provider_message";

export const CASE_SUBJECT_EXTERNAL_REF_KINDS: readonly CaseSubjectExternalRefKind[] = [
  "legacy_appointment",
  "calendar_event",
  "provider_message",
] as const;

export interface CaseSubjectExternalRef {
  id: string;
  subject_id: string;
  case_id: string;
  source_system: string;
  ref_kind: CaseSubjectExternalRefKind;
  /** Opaque. Never parsed to derive authorization or tenancy. */
  external_ref: string;
  source_kind: string;
  source_ref: string | null;
  recorded_by: string | null;
  recorded_at: string;
}
