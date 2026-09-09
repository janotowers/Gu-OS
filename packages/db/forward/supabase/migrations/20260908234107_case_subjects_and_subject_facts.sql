-- 20260908234107_case_subjects_and_subject_facts.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084_bootstrap_organization_provenance.sql) is applied separately by
-- the ordered-apply bootstrap path and is never touched by the CLI.
--
-- Keep migrations additive and reversible-by-flag where they carry behavior.

-- ============================================================
-- R1 Relationship Operations — SL-4, symbolic unit M-SUBJECTS.
-- Technical Plan §3 · TD-14 (Case Subjects & subject-scoped Facts, approved
-- with the plan) · TD-8 · Slice Plan SA-4.4, SA-4.10, SA-4.12.
--
-- WHAT THIS SOLVES
--
-- Some things a Case tracks have their own identity and their own evidence
-- history: a Commitment (SL-4), a Visit (SL-8). The obvious encodings both
-- fail, and TD-14 rejected them explicitly:
--
--   * an entity id inside the key (`commitment.<uuid>.due`) is accidental
--     schema in a string — per-item reads become prefix scans and enumeration
--     becomes key parsing;
--   * a per-kind entity table with lifecycle columns reintroduces the mutable
--     single-status record S3 §12.1 forbids, and duplicates the provenance and
--     supersession mechanics `case_facts` already has.
--
-- So identity gets a row and lifecycle stays in facts. `case_subjects` is an
-- immutable identity anchor with ZERO lifecycle columns; everything that can
-- change about a subject is a subject-scoped `case_facts` row, using the
-- CURRENT append-only supersession mechanics unchanged.
--
-- TENANCY IS DERIVED, NEVER SUPPLIED (TD-14, Technical Plan §6)
--
-- Neither table carries `organization_id`. Tenancy is owned by the parent Case
-- (`operational_cases.organization_id`) and the `case_id` FK makes that link
-- structural, so a cross-tenant mismatch has no surface on which to occur —
-- there is no column that could disagree with the parent. This is the kernel's
-- existing `operational_case_events` shape, not a new tenancy mechanism. The
-- cost is a per-row subquery in the child policies, which is why
-- `operational_cases (id, organization_id)` is already indexed.
--
-- SAME-CASE CONTAINMENT IS STRUCTURAL
--
-- `case_facts.subject_id` carries a COMPOSITE foreign key on (subject_id,
-- case_id), not a plain one. A fact therefore cannot point at another Case's
-- subject: the pair has to exist together in `case_subjects`. The same applies
-- to `case_subject_external_refs`. MATCH SIMPLE semantics do the rest — when
-- `subject_id` is NULL the constraint is not checked, which is exactly what a
-- case-level fact is.
--
-- WHAT SL-4 ACTUALLY CONSUMES
--
-- Only `subject_kind = 'commitment'`. `visit` is in the registry because TD-14
-- defines the R1 kinds together and Technical Plan §3 lands M-SUBJECTS as one
-- unit here; SL-8 is what starts writing visits, and
-- `case_subject_external_refs` exists for that Slice's late-arriving
-- appointment / Calendar ids. Splitting the approved unit to defer two of its
-- objects would mean re-opening a design that is already approved, for no
-- structural gain — nothing reads them until a Slice does.
--
-- ROLLBACK: additive only. Two new tables and one nullable column; with
-- `relationship_ops` off nothing writes them and the rows are inert audit data.
-- Every existing `case_facts` caller passes no subject and keeps behaving
-- byte-identically, because `subject_id` defaults to NULL.
-- ============================================================

-- ============================================================
-- case_subjects — immutable identity anchors
-- ============================================================

create table public.case_subjects (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null references public.operational_cases(id) on delete cascade,

  subject_kind        text not null
                        check (subject_kind in ('visit', 'commitment')),

  label               text,
  attrs_jsonb         jsonb not null default '{}'::jsonb,

  created_by_user_id  uuid references public.profiles(id) on delete set null,
  actor_kind          text not null default 'agent'
                        check (actor_kind in ('human', 'agent', 'system')),
  source_kind         text not null
                        check (source_kind in
                          ('user', 'external_contact', 'document', 'integration', 'derived')),
  source_ref          text,
  provenance_jsonb    jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),

  -- Composite-FK target. Every same-case containment guarantee below is built
  -- on this pair, so it is a real constraint rather than a convenience index.
  constraint uq_case_subjects_id_case unique (id, case_id)
);

comment on table public.case_subjects is
  'Identidad duradera de un sujeto dentro de un Caso (TD-14): commitment (SL-4), visit (SL-8). Filas estructuralmente inmutables y SIN columnas de ciclo de vida: todo lo que cambia vive en case_facts con subject_id. No lleva organization_id: la tenencia se deriva del Caso padre, igual que operational_case_events.';

comment on column public.case_subjects.subject_kind is
  'Registro tipado espejado en packages/types. R1: visit, commitment. Vive en la fila del sujeto, nunca dentro del fact_key.';

comment on column public.case_subjects.attrs_jsonb is
  'Atributos de identidad minimos conocidos EN LA CREACION (p. ej. la referencia externa de la propiedad de una Visita). No es estado: cualquier cosa que evolucione es un hecho con subject_id.';

comment on column public.case_subjects.source_kind is
  'Procedencia, mismo vocabulario que case_facts. Un sujeto creado por juicio del Supervisor es derived; uno declarado por una persona es user.';

-- Enumeration and per-kind projection (TD-14 point 6).
create index idx_case_subjects_case_kind
  on public.case_subjects (case_id, subject_kind, created_at desc);

-- Structural immutability — the evidence_records / operational_case_events
-- pattern. There is no surgical exception here, unlike case_facts: a subject
-- row has nothing that can legitimately change.
create or replace function public.case_subjects_reject_mutation()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'case_subjects is append-only (id=%, case_id=%)', old.id, old.case_id;
  end if;
  raise exception 'case_subjects rows are immutable - lifecycle belongs in subject-scoped case_facts (id=%, case_id=%)', old.id, old.case_id;
end;
$fn$;

create trigger case_subjects_no_update
  before update on public.case_subjects
  for each row execute function public.case_subjects_reject_mutation();

create trigger case_subjects_no_delete
  before delete on public.case_subjects
  for each row execute function public.case_subjects_reject_mutation();

alter table public.case_subjects enable row level security;

create policy "Service role manages case subjects"
  on public.case_subjects for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Case-child read pattern, resolved through the parent Case (TD-1 matrix,
-- 00081). Permissive membership SELECT plus the restrictive org tenancy guard.
create policy "Org members read organization case subjects"
  on public.case_subjects for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_subjects.case_id
         and c.organization_id is not null
         and public.is_active_org_member(c.organization_id)
    )
  );

create policy "Org tenancy guard on case subjects"
  on public.case_subjects as restrictive for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_subjects.case_id
         and (
           c.organization_id is null
           or public.is_active_org_member(c.organization_id)
         )
    )
  );

-- ============================================================
-- case_facts.subject_id — additive, nullable, composite-FK constrained
--
-- NULL means "case-level fact", which is every row that exists today and every
-- row every current caller writes. TD-14 point 1: fact identity becomes
-- (case_id, fact_key, subject_id), and two `commitment.due` facts under
-- different Commitments therefore never supersede or collapse into each other.
--
-- The append-only trigger needs no change: its
-- `to_jsonb(old) - 'superseded_by' = to_jsonb(new) - 'superseded_by'`
-- comparison already makes every other column immutable post-insert, so
-- subject_id inherits immutability for free (TD-14 point 7).
-- ============================================================

alter table public.case_facts
  add column if not exists subject_id uuid;

alter table public.case_facts
  add constraint case_facts_subject_same_case
  foreign key (subject_id, case_id)
  references public.case_subjects (id, case_id);

comment on column public.case_facts.subject_id is
  'NULL = hecho a nivel de Caso (todo lo existente). No NULL = hecho con alcance de sujeto (TD-14). La identidad del hecho pasa a ser (case_id, fact_key, subject_id), asi que dos commitment.due de compromisos distintos nunca se reemplazan entre si. FK COMPUESTA con case_id: un hecho no puede apuntar al sujeto de otro Caso.';

-- Current subject-scoped facts. Partial and disjoint from
-- idx_case_facts_current, which keeps serving the case-level reads unchanged
-- (TD-14 point 6).
create index idx_case_facts_current_subject
  on public.case_facts (case_id, subject_id, fact_key)
  where superseded_by is null and subject_id is not null;

-- ============================================================
-- case_subject_external_refs — late-arriving external identity
--
-- A Visit exists before its appointment / Calendar / provider ids are known,
-- and those ids can change (a legacy reschedule mutates the appointment id).
-- So references are an append-only SET with per-row provenance, not a fact: a
-- growing set of references fits the one-current-value-per-key supersession
-- model poorly. Conflicting or superseded references simply coexist as rows;
-- deciding which currently binds is S3 domain reconciliation, not schema.
--
-- Not consumed by SL-4. Landed with its unit (Technical Plan §3).
-- ============================================================

create table public.case_subject_external_refs (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null,
  case_id       uuid not null,

  source_system text not null,
  ref_kind      text not null
                  check (ref_kind in
                    ('legacy_appointment', 'calendar_event', 'provider_message')),
  external_ref  text not null,

  source_kind   text not null
                  check (source_kind in
                    ('user', 'external_contact', 'document', 'integration', 'derived')),
  source_ref    text,
  recorded_by   uuid references public.profiles(id) on delete set null,
  recorded_at   timestamptz not null default now(),

  constraint case_subject_external_refs_not_empty
    check (btrim(source_system) <> '' and btrim(external_ref) <> ''),

  -- Same-case structural containment; the Organization is derived through
  -- Subject -> Case, so this table carries no organization_id either.
  constraint case_subject_external_refs_same_case
    foreign key (subject_id, case_id)
    references public.case_subjects (id, case_id),

  -- Attachment is idempotent: re-discovering the same reference is a no-op
  -- insert conflict rather than a duplicate row.
  constraint uq_case_subject_external_ref
    unique (subject_id, source_system, ref_kind, external_ref)
);

comment on table public.case_subject_external_refs is
  'Referencias externas de un sujeto, append-only y con procedencia por fila (TD-14). Una referencia en conflicto o reemplazada coexiste como otra fila; cual vincula hoy lo interpreta la reconciliacion de dominio (S3), no el esquema. Sin organization_id: la tenencia se deriva por Sujeto -> Caso.';

comment on column public.case_subject_external_refs.external_ref is
  'Identificador externo opaco. Nunca se parsea para derivar autorizacion ni tenencia.';

create index idx_case_subject_external_refs_subject
  on public.case_subject_external_refs (subject_id, ref_kind, recorded_at desc);

-- Reverse lookup from an external id. Organization-scoped reads join
-- operational_cases, which is the authorization order §6 requires anyway.
create index idx_case_subject_external_refs_lookup
  on public.case_subject_external_refs (source_system, ref_kind, external_ref);

create or replace function public.case_subject_external_refs_reject_mutation()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'case_subject_external_refs is append-only (subject_id=%)', old.subject_id;
  end if;
  raise exception 'case_subject_external_refs rows are immutable (subject_id=%)', old.subject_id;
end;
$fn$;

create trigger case_subject_external_refs_no_update
  before update on public.case_subject_external_refs
  for each row execute function public.case_subject_external_refs_reject_mutation();

create trigger case_subject_external_refs_no_delete
  before delete on public.case_subject_external_refs
  for each row execute function public.case_subject_external_refs_reject_mutation();

alter table public.case_subject_external_refs enable row level security;

create policy "Service role manages case subject external refs"
  on public.case_subject_external_refs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Org members read organization case subject external refs"
  on public.case_subject_external_refs for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_subject_external_refs.case_id
         and c.organization_id is not null
         and public.is_active_org_member(c.organization_id)
    )
  );

create policy "Org tenancy guard on case subject external refs"
  on public.case_subject_external_refs as restrictive for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_subject_external_refs.case_id
         and (
           c.organization_id is null
           or public.is_active_org_member(c.organization_id)
         )
    )
  );
