/**
 * Case Subjects — the identity half of TD-14 (R1 SL-4, symbolic unit
 * M-SUBJECTS).
 *
 * A subject row is an **identity anchor and nothing else**. It has no status,
 * no due date, no resolved-at: everything that can change about a Commitment or
 * a Visit is a subject-scoped `case_facts` row, so a change supersedes rather
 * than overwrites and the history stays reconstructible. The database enforces
 * that rather than trusting it — the row rejects UPDATE and DELETE outright.
 *
 * Tenancy is **derived, never supplied**. These tables carry no
 * `organization_id`: the parent Case owns it, the `case_id` foreign key makes
 * the link structural, and a cross-tenant mismatch therefore has no column on
 * which to occur. Every helper here still takes an explicit `userId`, as the
 * TD-1 convention requires of service-role helpers.
 */
import type { DbClient } from "../client";
import type {
  CaseSubject,
  CaseSubjectActorKind,
  CaseSubjectExternalRef,
  CaseSubjectExternalRefKind,
  CaseSubjectKind,
  CaseFact,
  CaseFactSourceKind,
} from "@agents/types";
import { listCaseFacts } from "./case-facts";

export interface CreateCaseSubjectInput {
  userId: string;
  caseId: string;
  kind: CaseSubjectKind;
  label?: string | null;
  /** Identity attributes known AT CREATION only. Never lifecycle state. */
  attrs?: Record<string, unknown>;
  sourceKind: CaseFactSourceKind;
  sourceRef?: string | null;
  actorKind?: CaseSubjectActorKind;
  createdByUserId?: string | null;
  provenance?: Record<string, unknown>;
}

/**
 * Creates a subject.
 *
 * Deliberately NOT idempotent on content, and that is a design position rather
 * than an omission: two Commitments can legitimately look identical — the same
 * advisor promising the same thing twice — and collapsing them on a content
 * hash would silently lose one promise. Callers that need at-most-once
 * semantics for a *specific* origin carry their own durable key; SL-4's
 * supervisor gets it from the reconsideration's wake key, so a retried
 * reconsideration re-reads rather than re-creates.
 */
export async function createCaseSubject(
  db: DbClient,
  input: CreateCaseSubjectInput
): Promise<CaseSubject> {
  const { data, error } = await db
    .from("case_subjects")
    .insert({
      case_id: input.caseId,
      subject_kind: input.kind,
      label: input.label ?? null,
      attrs_jsonb: input.attrs ?? {},
      created_by_user_id: input.createdByUserId ?? null,
      actor_kind: input.actorKind ?? "agent",
      source_kind: input.sourceKind,
      source_ref: input.sourceRef ?? null,
      provenance_jsonb: input.provenance ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as CaseSubject;
}

export async function getCaseSubject(
  db: DbClient,
  caseId: string,
  subjectId: string
): Promise<CaseSubject | null> {
  const { data, error } = await db
    .from("case_subjects")
    .select("*")
    .eq("case_id", caseId)
    .eq("id", subjectId)
    .maybeSingle();
  if (error) throw error;
  return (data as CaseSubject | null) ?? null;
}

/** Subjects of a Case, newest first, optionally narrowed to one kind. */
export async function listCaseSubjects(
  db: DbClient,
  userId: string,
  caseId: string,
  kind?: CaseSubjectKind
): Promise<CaseSubject[]> {
  let query = db
    .from("case_subjects")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (kind) query = query.eq("subject_kind", kind);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CaseSubject[];
}

/** One subject plus its current facts. */
export interface SubjectWithFacts {
  subject: CaseSubject;
  /** Current fact per key, within this subject. Collision-free by construction. */
  facts: Map<string, CaseFact>;
}

/**
 * Every subject of one kind with its current facts, in one pass.
 *
 * The projection shape the Supervisor and, later, the Work Portfolio need: a
 * per-Case commitment list is `listCurrentSubjectFactsByKind(..., "commitment")`,
 * not a prefix scan over parsed keys — which is the whole reason TD-14 rejected
 * putting the entity id inside `fact_key`.
 */
export async function listCurrentSubjectFactsByKind(
  db: DbClient,
  userId: string,
  caseId: string,
  kind: CaseSubjectKind
): Promise<SubjectWithFacts[]> {
  const subjects = await listCaseSubjects(db, userId, caseId, kind);
  if (subjects.length === 0) return [];

  // One read for every subject of the kind, then grouped in memory. A query
  // per subject would be N+1 against a list that is unbounded in principle.
  const ids = subjects.map((s) => s.id);
  const { data, error } = await db
    .from("case_facts")
    .select("*")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .is("superseded_by", null)
    .in("subject_id", ids)
    .order("recorded_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as CaseFact[];

  const bySubject = new Map<string, Map<string, CaseFact>>();
  for (const id of ids) bySubject.set(id, new Map());
  for (const row of rows) {
    const subjectId = row.subject_id;
    if (!subjectId) continue;
    const facts = bySubject.get(subjectId);
    // recorded_at desc: the first row seen for a key is the current one, which
    // matters when an interrupted run left two rows unsuperseded.
    if (facts && !facts.has(row.fact_key)) facts.set(row.fact_key, row);
  }

  return subjects.map((subject) => ({
    subject,
    facts: bySubject.get(subject.id) ?? new Map(),
  }));
}

/** Full history of one subject's facts, including superseded rows. */
export async function listSubjectFactHistory(
  db: DbClient,
  userId: string,
  caseId: string,
  subjectId: string
): Promise<CaseFact[]> {
  return listCaseFacts(db, userId, caseId, {
    subjectScope: "subject",
    subjectId,
    includeSuperseded: true,
  });
}

// ============================================================
// External references — not consumed by SL-4
// ============================================================

export interface AttachSubjectExternalRefInput {
  subjectId: string;
  caseId: string;
  sourceSystem: string;
  refKind: CaseSubjectExternalRefKind;
  externalRef: string;
  sourceKind: CaseFactSourceKind;
  sourceRef?: string | null;
  recordedBy?: string | null;
}

/** Postgres unique-violation: this reference is already attached. */
const UNIQUE_VIOLATION = "23505";

export interface AttachSubjectExternalRefResult {
  ref: CaseSubjectExternalRef;
  /** False when the reference was already attached — re-discovery is a no-op. */
  attached: boolean;
}

/**
 * Attaches an external reference to a subject, idempotently.
 *
 * Identity is structural — `unique (subject_id, source_system, ref_kind,
 * external_ref)` — so re-discovering the same reference conflicts rather than
 * duplicating, and a read-then-insert guard (which proves nothing under
 * concurrency) is not needed.
 *
 * Landed with M-SUBJECTS and unused until SL-8, where a rescheduled legacy
 * appointment produces a *second* row on the same subject rather than an edit.
 */
export async function attachSubjectExternalRef(
  db: DbClient,
  input: AttachSubjectExternalRefInput
): Promise<AttachSubjectExternalRefResult> {
  const row = {
    subject_id: input.subjectId,
    case_id: input.caseId,
    source_system: input.sourceSystem,
    ref_kind: input.refKind,
    external_ref: input.externalRef,
    source_kind: input.sourceKind,
    source_ref: input.sourceRef ?? null,
    recorded_by: input.recordedBy ?? null,
  };

  const { data, error } = await db
    .from("case_subject_external_refs")
    .insert(row)
    .select("*")
    .single();

  if (!error) return { ref: data as CaseSubjectExternalRef, attached: true };
  if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;

  const { data: existing, error: readError } = await db
    .from("case_subject_external_refs")
    .select("*")
    .eq("subject_id", input.subjectId)
    .eq("source_system", input.sourceSystem)
    .eq("ref_kind", input.refKind)
    .eq("external_ref", input.externalRef)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing) throw error;
  return { ref: existing as CaseSubjectExternalRef, attached: false };
}

export async function listSubjectExternalRefs(
  db: DbClient,
  subjectId: string
): Promise<CaseSubjectExternalRef[]> {
  const { data, error } = await db
    .from("case_subject_external_refs")
    .select("*")
    .eq("subject_id", subjectId)
    .order("recorded_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as CaseSubjectExternalRef[];
}
