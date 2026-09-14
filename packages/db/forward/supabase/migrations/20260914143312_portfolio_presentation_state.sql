-- 20260914143312_portfolio_presentation_state.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084_bootstrap_organization_provenance.sql) is applied separately by
-- the ordered-apply bootstrap path and is never touched by the CLI.
--
-- Keep migrations additive and reversible-by-flag where they carry behavior.

-- ============================================================
-- R1 Relationship Operations — SL-7, symbolic unit M-PRESENTATION.
-- Technical Plan §3 · TD-9 (presentation state, hard guard) · TD-1 access
-- matrix · Slice Plan SA-7.5, SA-7.6, SA-7.11, SA-7.12.
--
-- WHAT THIS IS
--
-- A user's personal view of the Work Portfolio: when they last saw a Case,
-- whether they snoozed it, hid it or pinned it. Nothing else. It is the only
-- table in R1 an authenticated user writes directly (TD-1), and it is kept
-- deliberately separate from business truth:
--
--   * it never resolves, closes or delays a business need (S4 §6.8,
--     invariant 6). A snooze changes what one person sees, not what the
--     Organization owes;
--   * it is NOT `internal_user_notifications.status`, whose read / actioned /
--     dismissed values drive reminder and escalation cascades (TD-9);
--   * the must-surface predicates never read it. That half of TD-9's hard
--     guard lives in code and is proven by a selftest; the table's job is to
--     make sure a presentation write cannot reach anything else.
--
-- SHAPE — typed columns rather than TD-9's TENTATIVE `state_jsonb`
--
-- TD-9 sketched `state_jsonb {seen_at, snooze_until, pinned}` as a TENTATIVE
-- name set. Typed columns carry the same four facts with types the database
-- checks, and they let the snooze cap below be a constraint instead of a
-- convention. `hidden_at` is added because SA-7.5 and S4 §13 ("user hides
-- mandatory attention card") need a hide that TD-9's sketch did not name.
--
-- THE SUBJECT IS A CASE, AND IT CAN ONLY BE A CASE OF THIS ORGANIZATION
--
-- TD-9 keys presentation state by (user, subject_kind + subject_id). SL-7
-- presents Cases, so `case` is the only kind, and the composite foreign key
-- on (subject_id, organization_id) against `operational_cases (id,
-- organization_id)` — the composite-FK target M-CASE-ORG landed for exactly
-- this purpose — makes a mismatched row structurally impossible: a row cannot
-- name another Organization's Case, and a legacy Case (organization_id NULL)
-- can never be a subject. A later kind needs its own migration, which is the
-- moment to revisit this key.
--
-- THE 14-DAY SNOOZE CAP (human decision D6, 2026-09-13) IS A CONSTRAINT
--
-- `snooze_until` may be at most 14 days after the write that set it. The
-- write time is `updated_at`, which a trigger stamps from the database clock on
-- every insert and update — a value supplied by the caller is ignored — and
-- the same trigger CLAMPS a longer snooze to the cap rather than rejecting it,
-- so a direct user-JWT write cannot defer an item further than the application
-- could, and an application clock a few seconds ahead of the database cannot
-- turn a legitimate 14-day snooze into an error. The CHECK below then holds by
-- construction; it stays as the declarative statement of the rule. The cap is
-- an ordinary engineering threshold, not a safety boundary: must-surface items
-- are exempt from snooze entirely, so it can never gate a governed obligation
-- (Slice Plan SL-7, D6). The value is mirrored by `PORTFOLIO_SNOOZE_CAP_DAYS`
-- in packages/types, and a selftest compares them.
--
-- ACCESS (TD-1 matrix, strengthened for SA-7.11)
--
--   SELECT  own rows, while an ACTIVE member of the row's Organization
--   INSERT  own rows, while an ACTIVE member — `user_id = auth.uid()` alone is
--           insufficient (TD-1)
--   UPDATE  own rows, while an ACTIVE member, and the row stays own
--   DELETE  service role only — clearing presentation is an update to neutral
--
-- TD-1 states the read rule as `user_id = auth.uid()`. SA-7.11 requires that a
-- revoked member read NOTHING through the presentation state, and a revoked
-- member's own old rows still name the Organization's Cases, so the read rule
-- additionally requires active membership. Strictly stronger; nothing that
-- TD-1 allows an active member is taken away.
--
-- ROLLBACK: additive only. One new table, with no reader or writer outside
-- the Portfolio, which is inert while `relationship_ops` is off.
-- ============================================================

create table public.portfolio_presentation_state (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,

  subject_kind     text not null
                     check (subject_kind in ('case')),
  subject_id       uuid not null,

  seen_at          timestamptz,
  snooze_until     timestamptz,
  hidden_at        timestamptz,
  pinned           boolean not null default false,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One row per person per subject: presentation is personal, and two rows
  -- for the same subject would make "what does this user see" ambiguous.
  constraint uq_portfolio_presentation_state_subject
    unique (user_id, subject_kind, subject_id),

  -- A Case of THIS Organization, structurally (see header).
  constraint portfolio_presentation_state_case_same_org
    foreign key (subject_id, organization_id)
    references public.operational_cases (id, organization_id)
    on delete cascade,

  -- D6: at most 14 days past the write that set it (see header).
  constraint portfolio_presentation_state_snooze_cap
    check (snooze_until is null or snooze_until <= updated_at + interval '14 days')
);

comment on table public.portfolio_presentation_state is
  'Estado de presentacion PERSONAL del Work Portfolio (TD-9): visto, pospuesto, oculto, fijado. Nunca resuelve, cierra ni retrasa una necesidad de negocio (S4 §6.8) y los predicados must-surface nunca lo leen. No es internal_user_notifications.status. Unica tabla R1 que un usuario autenticado escribe directamente (TD-1).';

comment on column public.portfolio_presentation_state.subject_id is
  'Caso presentado. FK compuesta (subject_id, organization_id) contra operational_cases (id, organization_id): solo Casos de esta Organizacion, nunca un Caso legacy.';

comment on column public.portfolio_presentation_state.snooze_until is
  'Posponer en la vista de ESTA persona. Tope de 14 dias desde la escritura (decision D6) por constraint. Un elemento must-surface lo ignora por completo.';

comment on column public.portfolio_presentation_state.hidden_at is
  'Ocultar en la vista de ESTA persona. Un elemento must-surface sigue visible aunque este oculto (SA-7.5).';

create index idx_portfolio_presentation_state_user_org
  on public.portfolio_presentation_state (user_id, organization_id);

-- The write time is the database's, never the caller's. The snooze cap is
-- measured from `updated_at`, so a caller able to choose it could choose the
-- cap too. `created_at` is fixed at insert and immutable afterwards, and a row
-- keeps the person and the subject it was written for: presentation state is
-- re-pointed by writing a new row, never by moving an existing one.
create or replace function public.portfolio_presentation_state_stamp()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    if new.user_id is distinct from old.user_id
       or new.organization_id is distinct from old.organization_id
       or new.subject_kind is distinct from old.subject_kind
       or new.subject_id is distinct from old.subject_id then
      raise exception 'portfolio_presentation_state rows keep their person and subject (id=%)', old.id;
    end if;
    new.created_at := old.created_at;
  end if;
  -- D6 cap, clamped rather than rejected (see header).
  if new.snooze_until is not null
     and new.snooze_until > new.updated_at + interval '14 days' then
    new.snooze_until := new.updated_at + interval '14 days';
  end if;
  return new;
end;
$fn$;

create trigger trg_portfolio_presentation_state_stamp
  before insert or update on public.portfolio_presentation_state
  for each row execute function public.portfolio_presentation_state_stamp();

alter table public.portfolio_presentation_state enable row level security;

create policy "Service role manages portfolio presentation state"
  on public.portfolio_presentation_state for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Members read own portfolio presentation state"
  on public.portfolio_presentation_state for select
  to authenticated
  using (
    user_id = auth.uid()
    and public.is_active_org_member(organization_id)
  );

create policy "Members insert own portfolio presentation state"
  on public.portfolio_presentation_state for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.is_active_org_member(organization_id)
  );

create policy "Members update own portfolio presentation state"
  on public.portfolio_presentation_state for update
  to authenticated
  using (
    user_id = auth.uid()
    and public.is_active_org_member(organization_id)
  )
  with check (
    user_id = auth.uid()
    and public.is_active_org_member(organization_id)
  );
