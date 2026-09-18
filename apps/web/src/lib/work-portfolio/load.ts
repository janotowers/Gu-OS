/**
 * Loading the Work Portfolio — R1 SL-7, Slice Plan SA-7.2 (AC-9 §14.2).
 *
 * The order is the guarantee:
 *
 *   1. the actor's ACTIVE membership in this Organization, re-checked now —
 *      identity is not authorization (ADR-106). None ⇒ nothing else is read;
 *   2. `relationship_ops` — off ⇒ inert: no Case, fact, Work or presentation
 *      read, and nothing written (shared baseline "flags off ⇒ inert");
 *   3. the candidate set, read with the actor's OWN JWT, so PostgreSQL's
 *      membership policies decide which Cases exist for this actor — an
 *      unauthorized Case is never returned, not even to be filtered later;
 *   4. the evidence of exactly those Cases — case-level truth again under the
 *      actor's JWT, Work Items with the service role keyed only by those ids;
 *   5. the pure projection: predicates, posture, and only then the actor's
 *      presentation preferences.
 *
 * Server-only: step 4 uses the service role.
 */
import {
  getActiveMembership,
  isRelationshipOpsEnabled,
  listPortfolioAuthorityResolutions,
  listPortfolioCaseApprovals,
  listPortfolioCases,
  listPortfolioCommitmentSubjects,
  listPortfolioCurrentFacts,
  listPortfolioPresentationState,
  listPortfolioSupervisorEvents,
  listPortfolioWorkItems,
  PORTFOLIO_CASE_LIMIT,
  type DbClient,
} from "@agents/db";
import type { OrganizationMembership } from "@agents/types";
import { buildWorkPortfolio, type WorkPortfolio } from "./projection";
import { buildCaseSnapshots, type PortfolioCaseSnapshot } from "./snapshot";

export type LoadWorkPortfolioResult =
  | { status: "no_membership" }
  | { status: "inert"; reason: "relationship_ops_disabled"; membership: OrganizationMembership }
  | {
      status: "ok";
      membership: OrganizationMembership;
      portfolio: WorkPortfolio;
      /**
       * The authorized snapshots the projection was built from — the only input
       * the SL-12 ranking pass may read (AC-9 §14.2).
       */
      snapshots: PortfolioCaseSnapshot[];
      /** True when the Organization has more Cases than one read projects. */
      truncated: boolean;
    };

export async function loadWorkPortfolio(params: {
  /** Service role: membership, flag and Work Items (keyed by authorized ids). */
  serviceDb: DbClient;
  /** The actor's own JWT: every read of case-level truth. */
  userDb: DbClient;
  actorUserId: string;
  organizationId: string;
  now: Date;
}): Promise<LoadWorkPortfolioResult> {
  const { serviceDb, userDb, actorUserId, organizationId, now } = params;

  // ── 1. Authorization first. Nothing about any Case is read before this.
  const membership = await getActiveMembership(serviceDb, organizationId, actorUserId);
  if (!membership) return { status: "no_membership" };

  // ── 2. Flags off ⇒ inert.
  if (!(await isRelationshipOpsEnabled(serviceDb, organizationId))) {
    return { status: "inert", reason: "relationship_ops_disabled", membership };
  }

  // ── 3. The candidate set, as PostgreSQL returns it to THIS actor. The
  // organization filter keeps the actor's own legacy Cases out; a row of
  // another Organization is dropped as defense in depth behind RLS.
  const cases = (await listPortfolioCases(userDb, organizationId)).filter(
    (row) => row.organization_id === organizationId
  );
  const ids = cases.map((row) => row.id);

  // ── 4. Evidence of exactly those Cases.
  const [facts, subjects, events, approvals, presentation, authorityResolutions] =
    await Promise.all([
      listPortfolioCurrentFacts(userDb, ids),
      listPortfolioCommitmentSubjects(userDb, ids),
      listPortfolioSupervisorEvents(userDb, ids),
      listPortfolioCaseApprovals(userDb, ids),
      listPortfolioPresentationState(userDb, { userId: actorUserId, organizationId }),
      listPortfolioAuthorityResolutions(userDb, { organizationId, caseIds: ids }),
    ]);
  const work = ids.length > 0 ? await listPortfolioWorkItems(serviceDb, ids) : [];

  // ── 5. The pure projection.
  const snapshots = buildCaseSnapshots({
    organizationId,
    cases,
    facts,
    subjects,
    events,
    approvals,
    work,
    authorityResolutions,
  });
  const portfolio = buildWorkPortfolio({
    actor: { userId: actorUserId, role: membership.role },
    snapshots,
    presentation,
    now,
  });
  return { status: "ok", membership, portfolio, snapshots, truncated: cases.length >= PORTFOLIO_CASE_LIMIT };
}
