-- 20260907024941_resolution_artifact_identity.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084_bootstrap_organization_provenance.sql) is applied separately by
-- the ordered-apply bootstrap path and is never touched by the CLI.
--
-- Keep migrations additive and reversible-by-flag where they carry behavior.
--
-- ============================================================
-- R1 Relationship Operations — SL-3, symbolic unit M-RESOLUTION-IDENTITY.
-- Technical Plan §3 · TD-7 / TD-8 · ADR-109 · Slice Plan SA-3.5, SA-3.12.
--
-- Indexes only. No table, no column, no behavior — SL-3 builds its flows on
-- primitives that already exist: `case_relationships` (SL-0, M-RELATIONSHIPS)
-- and the CURRENT `case_facts` supersession/provenance mechanics.
--
-- WHY THIS EXISTS AT ALL
--
-- A duplicate or supersession resolution is TWO governed operations that must
-- both be durably evidenced (SA-3.12): the lineage edge, and the business
-- closure. SA-3.12 explicitly permits an implementation to satisfy it by
-- leaving an explicitly unresolved, RETRYABLE state rather than rolling back —
-- so a retried resolution is a normal, expected event, not a fault.
--
-- The edge half is already idempotent: SL-0's `uq_case_relationships_active_edge`
-- keeps one active edge per (from, to, type), which is SA-3.7. The two OTHER
-- artifacts a resolution writes have no identity of their own:
--
--   * the `opportunity.closure` fact, and
--   * the relationship narration on BOTH Cases' timelines (SA-3.5).
--
-- A read-then-write guard ("has this closure already been recorded?") proves
-- nothing under concurrency, because two workers can both observe "missing"
-- before either writes — the lesson SL-2 already paid for. Identity therefore
-- has to be structural, which is what these indexes are.
--
-- ROLLBACK: indexes only, so "flag off" leaves nothing behaving differently.
-- Dropping them restores the prior schema exactly; no row changes meaning.
-- ============================================================

-- ============================================================
-- Closure-fact identity: one closure per (Case, edge)
--
-- `source_ref` names the lineage edge this closure belongs to
-- (`case_relationships:<id>`), so the identity asserted is "has THIS
-- resolution's closure been recorded for this Case?" — not "does this Case
-- have any closure fact?".
--
-- That distinction is deliberate and mirrors SL-2's admission-evidence index.
-- A Case may legitimately carry more than one closure row over its life: a
-- correction supersedes an earlier closure through the CURRENT append-only
-- `case_facts` mechanics, and the history stays reconstructible (S1 §8.6 —
-- history is never silently discarded). What must never happen is ONE
-- resolution producing two closure rows because it was retried.
--
-- Scoped by the `case_relationships:` prefix so it constrains only closures
-- written by a resolution, leaving every other `case_facts` writer untouched.
-- ============================================================
create unique index uq_case_facts_resolution_closure
  on public.case_facts (case_id, fact_key, source_ref)
  where source_ref like 'case_relationships:%';

comment on index public.uq_case_facts_resolution_closure is
  'SL-3 / SA-3.12: one closure fact per (Case, fact_key, lineage edge). Makes a retried resolution converge instead of writing a second closure row. Does not prevent a later corrective closure, which carries a different source_ref and supersedes through the normal case_facts mechanics.';

-- ============================================================
-- Relationship narration identity: one event per (Case, edge)
--
-- SA-3.5 requires a relationship event on BOTH Cases' timelines.
-- `operational_case_events` is append-only with no identity of its own, so
-- without this a retried resolution narrates the same edge twice on each side
-- and the timeline stops being a faithful account of what happened.
--
-- The index is per Case, not per edge, which is exactly right: the SAME edge
-- must produce exactly one event on the `from` Case and exactly one on the
-- `to` Case. Two rows, two distinct `case_id` values, one logical narration
-- each.
--
-- `event_type` is unconstrained here on purpose. The CURRENT closed CHECK on
-- `operational_case_events.event_type` has no relationship member, and
-- extending it is TD-11 evidence-gated work this Slice has no mandate to do,
-- so SL-3 narrates through the existing `state_changed` member and carries its
-- own kind in the payload — the same shape SL-2 used for admission.
-- ============================================================
create unique index uq_operational_case_events_relationship
  on public.operational_case_events
     (case_id, (payload_jsonb ->> 'relationship_id'))
  where payload_jsonb ->> 'kind' = 'case_relationship';

comment on index public.uq_operational_case_events_relationship is
  'SL-3 / SA-3.5: one relationship narration per (Case, edge). Both endpoints are narrated — two rows, one per Case — and a retried resolution cannot double-narrate either side.';
