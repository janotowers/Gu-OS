/**
 * Building the ranking input — R1 SL-12 (SA-12.1, SA-12.9).
 *
 * The ONLY source is SL-7's Portfolio for this actor and the snapshots it was
 * built from: the authorized candidate set, read under the actor's own JWT,
 * with the must-surface predicates already evaluated (AC-9 §14.2). Nothing is
 * read here, so nothing unauthorized can enter.
 *
 * What leaves this module for the model is content and short aliases. Row ids
 * stay in the frame, which the merge uses to resolve a cited alias back to the
 * durable row it names; a UUID that happens to sit inside a copied text is
 * scrubbed, so no identifier reaches the model even through a fact's value.
 */
import type { AttentionProjection, DurableRef } from "@agents/types";
import { renderClause } from "../copy";
import { compareEntries, type PortfolioEntry, type WorkPortfolio } from "../projection";
import type { PortfolioCaseSnapshot } from "../snapshot";
import {
  RANKING_MAX_CASES,
  RANKING_MAX_COMMITMENTS_PER_CASE,
  RANKING_MAX_FACTS_PER_CASE,
  RANKING_MAX_RECONSIDERATIONS_PER_CASE,
  RANKING_MAX_TEXT_CHARS,
  RANKING_MAX_WORK_PER_CASE,
  type RankingCaseInput,
  type RankingFrame,
  type RankingFrameCase,
} from "./contract";

const DAY_MS = 86_400_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Bounded, id-free text. A cut string says so rather than ending mid-thought. */
export function cut(text: string, max = RANKING_MAX_TEXT_CHARS): string {
  const scrubbed = text.replace(UUID, "[id]");
  return scrubbed.length <= max ? scrubbed : `${scrubbed.slice(0, max)}… (truncated)`;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function field(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : null;
}

/** Instants as the model reads them: explicit, zoned, minute precision. */
function formatInstant(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "—";
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function governedRef(attention: AttentionProjection, caseId: string): DurableRef {
  return attention.why.refs[0] ?? { kind: "case", id: caseId };
}

/**
 * The candidates, in the order the frame lists them: governed entries first in
 * SL-7's own order (which is also where an unranked governed item lands), then
 * open entries by recency. An Outcome is not attention, so closed Cases never
 * enter. Entries the person hid are still candidates — their presentation is
 * applied afterwards, so aliases never depend on it (SA-12.4).
 */
function candidatesOf(portfolio: WorkPortfolio): PortfolioEntry[] {
  const all = [...portfolio.organizationWork.entries, ...portfolio.organizationWork.suppressed];
  const governed = all.filter((e) => e.attention.length > 0).sort(compareEntries);
  const open = all
    .filter((e) => e.attention.length === 0 && e.section !== "outcomes" && !e.closure)
    .sort(
      (a, b) =>
        Date.parse(b.case.updated_at) - Date.parse(a.case.updated_at) || a.case.id.localeCompare(b.case.id)
    );
  return [...governed, ...open].slice(0, RANKING_MAX_CASES);
}

function caseInput(
  entry: PortfolioEntry,
  snapshot: PortfolioCaseSnapshot | undefined,
  ref: string,
  now: Date
): { input: RankingCaseInput; refs: Record<string, DurableRef> } {
  const caseId = entry.case.id;
  const refs: Record<string, DurableRef> = { [ref]: { kind: "case", id: caseId } };

  const governed = entry.attention.map((attention, i) => {
    const alias = `${ref}.a${i + 1}`;
    refs[alias] = governedRef(attention, caseId);
    return {
      ref: alias,
      predicate: attention.predicate,
      why: cut(renderClause(attention.why, formatInstant)),
      what_gu_needs: cut(renderClause(attention.what_gu_needs, formatInstant)),
      why_now: cut(renderClause(attention.why_now, formatInstant)),
    };
  });

  const facts = [...(snapshot?.case_facts ?? [])]
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .slice(0, RANKING_MAX_FACTS_PER_CASE)
    .map((fact, i) => {
      const alias = `${ref}.f${i + 1}`;
      refs[alias] = { kind: "case_fact", id: fact.id, fact_key: fact.fact_key };
      return { ref: alias, key: fact.fact_key, value: cut(textOf(fact.value)), recorded_at: fact.recorded_at };
    });

  const commitments = (snapshot?.commitments ?? [])
    .slice(0, RANKING_MAX_COMMITMENTS_PER_CASE)
    .map((commitment, i) => {
      const alias = `${ref}.k${i + 1}`;
      refs[alias] = { kind: "case_subject", id: commitment.subject_id, subject_kind: "commitment" };
      const due = commitment.due?.value;
      return {
        ref: alias,
        expected: cut(field(commitment.expected_outcome?.value, "expected_outcome") ?? commitment.label ?? "") || null,
        actor: field(commitment.actor?.value, "actor"),
        status: field(commitment.status?.value, "status"),
        due: field(due, "due_at") ?? field(due, "due_expression"),
      };
    });

  const work = entry.openWork.slice(0, RANKING_MAX_WORK_PER_CASE).map((item, i) => {
    const alias = `${ref}.w${i + 1}`;
    refs[alias] = { kind: "work_item", id: item.id };
    return {
      ref: alias,
      work_type: item.work_type,
      status: item.status,
      purpose: item.purpose === null ? null : cut(item.purpose),
      blocked_reason: item.blocked_reason,
    };
  });

  const reconsiderations = (snapshot?.reconsiderations ?? [])
    .slice(-RANKING_MAX_RECONSIDERATIONS_PER_CASE)
    .map((r, i) => {
      const alias = `${ref}.r${i + 1}`;
      refs[alias] = { kind: "case_event", id: r.claim_event_id, event_kind: "supervisor_reconsidered" };
      return {
        ref: alias,
        at: r.claimed_at,
        posture: r.posture,
        diagnosis: r.diagnosis === null ? null : cut(r.diagnosis),
        rationale: cut(r.rationale),
        outcome: r.settlement?.yield_posture ?? null,
      };
    });

  const updated = Date.parse(entry.case.updated_at);
  return {
    refs,
    input: {
      ref,
      objective: entry.objective === null ? null : cut(entry.objective),
      runtime_authority: entry.case.runtime_authority ?? "unset",
      section: entry.section === "outcomes" ? "not_reconsidered" : entry.section,
      governed,
      facts,
      commitments,
      work,
      reconsiderations,
      days_since_update: Number.isNaN(updated) ? 0 : Math.max(0, Math.floor((now.getTime() - updated) / DAY_MS)),
    },
  };
}

export function buildRankingFrame(params: {
  portfolio: WorkPortfolio;
  snapshots: readonly PortfolioCaseSnapshot[];
  actorRole: string;
  now: Date;
}): RankingFrame {
  const byId = new Map(params.snapshots.map((s) => [s.case.id, s]));
  const cases: RankingFrameCase[] = [];
  const inputs: RankingCaseInput[] = [];
  candidatesOf(params.portfolio).forEach((entry, i) => {
    const ref = `c${i + 1}`;
    const built = caseInput(entry, byId.get(entry.case.id), ref, params.now);
    inputs.push(built.input);
    cases.push({ ref, case_id: entry.case.id, governed: entry.attention.length > 0, refs: built.refs });
  });
  return {
    input: { now: params.now.toISOString(), actor_role: params.actorRole, cases: inputs },
    cases,
  };
}
