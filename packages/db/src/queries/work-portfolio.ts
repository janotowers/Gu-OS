/**
 * Work Portfolio reads and the one write it owns (R1 SL-7, Technical Plan
 * TD-9 v1 — "org-authorized views/queries in packages/db").
 *
 * TWO CLIENTS, ON PURPOSE (AC-9 §14.2: authorization before any cross-Case
 * projection or ranking).
 *
 *   * Case-level truth — Cases, facts, subjects, the supervisor's timeline,
 *     approvals, presentation state — is read with the ACTOR'S OWN JWT. The
 *     membership policies (00081, M-SUBJECTS, M-PRESENTATION) then decide the
 *     candidate set inside PostgreSQL: a Case the actor may not see is never
 *     returned, so it never reaches this code to be filtered afterwards. The
 *     explicit `organization_id` filter is not the authorization — it keeps the
 *     actor's own legacy Cases out of an Organization's Portfolio.
 *   * Work Items are service-role only in R1 (TD-1 matrix: no user-JWT read
 *     path exists yet), so they are read with the service role, keyed ONLY by
 *     the Case ids the authorized read returned. That keying is the guarantee,
 *     and the Portfolio selftest asserts it on the query, not on the result.
 *
 * The DB-backed cross-tenant suite runs these same read shapes as a revoked
 * member, a non-member and another Organization's member (SA-7.11).
 */
import type { DbClient } from "../client";
import {
  COMMITMENT_FACT_KEY_LIST,
  OPPORTUNITY_CLOSURE_FACT_KEY,
  SUPERVISOR_RECONSIDERED_EVENT_KIND,
  SUPERVISOR_SETTLED_EVENT_KIND,
  type CaseApproval,
  type CaseFact,
  type CaseSubject,
  type OperationalCase,
  type OperationalCaseEvent,
  type PortfolioPresentationState,
  type WorkItem,
} from "@agents/types";

/**
 * How many Cases one Portfolio read projects. An ordinary engineering bound
 * (Methodology §14.1): the pilot Organization holds tens of Opportunities, and
 * the bound exists so the page cannot be made unbounded, not to rank anything.
 */
export const PORTFOLIO_CASE_LIMIT = 200;

/** PostgREST carries `in.(…)` filters in the URL; keep each list modest. */
const ID_CHUNK = 100;

/** The `opportunity.objective` fact key SL-2 settled (TD-8). Display only. */
export const OPPORTUNITY_OBJECTIVE_FACT_KEY = "opportunity.objective";

/** The only fact keys the Portfolio projects. */
export const PORTFOLIO_FACT_KEYS: readonly string[] = [
  OPPORTUNITY_CLOSURE_FACT_KEY,
  OPPORTUNITY_OBJECTIVE_FACT_KEY,
  ...COMMITMENT_FACT_KEY_LIST,
];

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) out.push(values.slice(i, i + ID_CHUNK));
  return out;
}

async function readChunked<T>(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  for (const chunk of chunks([...new Set(ids)])) {
    const { data, error } = await read(chunk);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

// ============================================================
// Case-level truth — the ACTOR'S JWT
// ============================================================

/**
 * The candidate set: the Organization's Cases this actor's own membership
 * lets PostgreSQL return. Most recently touched first.
 */
export async function listPortfolioCases(
  userDb: DbClient,
  organizationId: string,
  limit = PORTFOLIO_CASE_LIMIT
): Promise<OperationalCase[]> {
  const { data, error } = await userDb
    .from("operational_cases")
    .select("*")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OperationalCase[];
}

/** Current facts of the projected keys, case-level and subject-scoped alike. */
export async function listPortfolioCurrentFacts(
  userDb: DbClient,
  caseIds: readonly string[]
): Promise<CaseFact[]> {
  return readChunked<CaseFact>(caseIds, (chunk) =>
    userDb
      .from("case_facts")
      .select("*")
      .in("case_id", chunk)
      .in("fact_key", [...PORTFOLIO_FACT_KEYS])
      .is("superseded_by", null)
      .order("recorded_at", { ascending: false })
  );
}

/** Commitment subjects (TD-14). Visits join at SL-8. */
export async function listPortfolioCommitmentSubjects(
  userDb: DbClient,
  caseIds: readonly string[]
): Promise<CaseSubject[]> {
  return readChunked<CaseSubject>(caseIds, (chunk) =>
    userDb
      .from("case_subjects")
      .select("*")
      .in("case_id", chunk)
      .eq("subject_kind", "commitment")
      .order("created_at", { ascending: true })
  );
}

/** Both halves of every supervisor reconsideration: claims and settlements. */
export async function listPortfolioSupervisorEvents(
  userDb: DbClient,
  caseIds: readonly string[]
): Promise<OperationalCaseEvent[]> {
  return readChunked<OperationalCaseEvent>(caseIds, (chunk) =>
    userDb
      .from("operational_case_events")
      .select("*")
      .in("case_id", chunk)
      .in("payload_jsonb->>kind", [
        SUPERVISOR_RECONSIDERED_EVENT_KIND,
        SUPERVISOR_SETTLED_EVENT_KIND,
      ])
      .order("created_at", { ascending: true })
  );
}

/**
 * Recorded approval decisions. Read because a pending request exits when it is
 * decided from ANY surface (S4 §13); the CURRENT table is where every surface
 * records the decision.
 */
export async function listPortfolioCaseApprovals(
  userDb: DbClient,
  caseIds: readonly string[]
): Promise<CaseApproval[]> {
  return readChunked<CaseApproval>(caseIds, (chunk) =>
    userDb.from("case_approvals").select("*").in("case_id", chunk)
  );
}

// ============================================================
// Work Items — SERVICE ROLE, keyed by the authorized ids only
// ============================================================

/**
 * Work of the authorized Cases. `caseIds` must be exactly the ids an
 * authorized read returned: this is the one place a service-role query meets
 * the Portfolio, and what it may reach is decided by the argument.
 */
export async function listPortfolioWorkItems(
  serviceDb: DbClient,
  caseIds: readonly string[]
): Promise<WorkItem[]> {
  return readChunked<WorkItem>(caseIds, (chunk) =>
    serviceDb
      .from("work_items")
      .select("*")
      .in("case_id", chunk)
      .order("created_at", { ascending: true })
  );
}

// ============================================================
// Presentation state — the ACTOR'S JWT, and the only Portfolio write
// ============================================================

const PRESENTATION_TABLE = "portfolio_presentation_state";

/** This person's rows for this Organization. RLS makes "own" structural. */
export async function listPortfolioPresentationState(
  userDb: DbClient,
  params: { userId: string; organizationId: string }
): Promise<PortfolioPresentationState[]> {
  const { data, error } = await userDb
    .from(PRESENTATION_TABLE)
    .select("*")
    .eq("user_id", params.userId)
    .eq("organization_id", params.organizationId);
  if (error) throw error;
  return (data ?? []) as PortfolioPresentationState[];
}

/** The presentation columns a write may set. Nothing else is writable here. */
export type PortfolioPresentationPatch = Partial<
  Pick<PortfolioPresentationState, "seen_at" | "snooze_until" | "hidden_at" | "pinned">
>;

const PRESENTATION_COLUMNS = new Set(["seen_at", "snooze_until", "hidden_at", "pinned"]);

/** Postgres unique-violation: the row appeared between our update and insert. */
const UNIQUE_VIOLATION = "23505";

/**
 * Sets this person's presentation of one Case. One row per person per Case;
 * a second write updates it. Written with the actor's JWT, so the membership
 * check and "own rows only" are the database's, not this function's.
 *
 * Update-then-insert rather than an upsert: it needs only the policies the
 * table grants, and a concurrent first write from another tab resolves by
 * updating the row that won.
 */
export async function writePortfolioPresentationState(
  userDb: DbClient,
  params: {
    userId: string;
    organizationId: string;
    caseId: string;
    patch: PortfolioPresentationPatch;
  }
): Promise<PortfolioPresentationState> {
  for (const key of Object.keys(params.patch)) {
    if (!PRESENTATION_COLUMNS.has(key)) {
      throw new Error(`writePortfolioPresentationState: ${key} is not a presentation column`);
    }
  }

  const update = () =>
    userDb
      .from(PRESENTATION_TABLE)
      .update(params.patch)
      .eq("user_id", params.userId)
      .eq("subject_kind", "case")
      .eq("subject_id", params.caseId)
      .select("*");

  const first = await update();
  if (first.error) throw first.error;
  const updated = (first.data ?? []) as PortfolioPresentationState[];
  if (updated.length === 1) return updated[0];

  const { data, error } = await userDb
    .from(PRESENTATION_TABLE)
    .insert({
      user_id: params.userId,
      organization_id: params.organizationId,
      subject_kind: "case",
      subject_id: params.caseId,
      seen_at: null,
      snooze_until: null,
      hidden_at: null,
      pinned: false,
      ...params.patch,
    })
    .select("*")
    .single();
  if (!error) return data as PortfolioPresentationState;
  if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;

  const retry = await update();
  if (retry.error) throw retry.error;
  const raced = (retry.data ?? []) as PortfolioPresentationState[];
  if (raced.length !== 1) throw error;
  return raced[0];
}
