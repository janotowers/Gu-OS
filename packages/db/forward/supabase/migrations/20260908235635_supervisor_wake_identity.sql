-- 20260908235635_supervisor_wake_identity.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084_bootstrap_organization_provenance.sql) is applied separately by
-- the ordered-apply bootstrap path and is never touched by the CLI.
--
-- Keep migrations additive and reversible-by-flag where they carry behavior.

-- ============================================================
-- R1 Relationship Operations — SL-4, symbolic unit M-WAKE-IDENTITY.
-- Technical Plan §3 · §8 ("duplicate wake coalescing") · TD-8 · TD-13
-- (M-SOURCE-EVENTS `dedup_key`) · Slice Plan SA-4.6.
--
-- One index. No table, no column, no behavior.
--
-- WHY IT IS NEEDED, GIVEN WHAT ALREADY EXISTS
--
-- SA-4.6 requires that repeated delivery of the same logical wake be DURABLY
-- coalesced, so the supervisor creates no duplicate logical durable work
-- attributable to that same event. Two layers already do part of this, and
-- neither finishes the job:
--
--   * `source_events` UNIQUE (organization_id, dedup_key) — SL-2 — collapses a
--     redelivered SOURCE event before the supervisor ever sees it. It says
--     nothing about a scheduled reconsideration, which has no inbox row;
--   * `markCaseProcessing` — CURRENT — serializes reconsiderations per Case
--     with a version CAS plus a `next_action_at` lease, and TD-8 relies on it
--     for exactly that. It fences a stale worker out of the CASE ROW, because
--     the version moved. It does not fence that worker out of the append-only
--     timeline, so a run whose lease expired mid-flight can still narrate.
--
-- That residue is the gap. A read-then-write guard ("has this wake already been
-- reconsidered?") would close nothing under concurrency — both workers can
-- observe "no" before either writes — which is the lesson SL-2 paid for and
-- SL-3 recorded when it made its own two resolution artifacts structural.
--
-- So the identity is structural, and the executor is ordered around it: the
-- reconsideration record is written FIRST and claims the wake; durable Work
-- Items and commitment subjects are created only after that insert succeeds. A
-- duplicate wake therefore conflicts here, before it can create anything, and
-- converges by reading back the reconsideration that already exists.
--
-- ROLLBACK: an index. Dropping it restores the prior schema exactly and no row
-- changes meaning.
-- ============================================================

-- One reconsideration per (Case, logical wake).
--
-- `event_type` is unconstrained here on purpose, for the reason SL-3 recorded:
-- the CURRENT closed CHECK on `operational_case_events.event_type` has no
-- supervisor member, and extending it is TD-11 evidence-gated work this Slice
-- has no mandate to do. SL-4 therefore narrates through the existing
-- `state_changed` member and carries its own kind in the payload — the shape
-- SL-2 and SL-3 both used.
create unique index uq_operational_case_events_supervisor_wake
  on public.operational_case_events
     (case_id, (payload_jsonb ->> 'wake_key'))
  where payload_jsonb ->> 'kind' = 'supervisor_reconsidered';

comment on index public.uq_operational_case_events_supervisor_wake is
  'SL-4 / SA-4.6: una reconsideracion por (Caso, wake logico). Un despertar repetido choca aqui ANTES de crear Work o compromisos, y converge leyendo la reconsideracion existente. Alcance limitado por el predicado kind: ningun otro escritor del timeline queda restringido.';
