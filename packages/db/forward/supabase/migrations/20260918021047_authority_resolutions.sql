-- 20260918021047_authority_resolutions.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084) is never touched.
--
-- ============================================================
-- R1 Relationship Operations — SL-6 Bindings + authority (advisory).
--
-- Technical Plan TD-3 / SL-7 hand-off. Slice Plan SA-6.7, SA-6.8, SA-6.13.
--
-- Durable `authority_resolutions` rows. Logging is not this table.
-- Only fail-safe answers are stored: `unknown` and `conflicting`.
-- Confident `gu` / `human_active` answers are not incidents and do not
-- land here.
--
-- This table does not write `operational_cases.runtime_authority`.
-- SL-6 answers; it does not transfer decision authority.
--
-- Members of the Organization may SELECT (the Portfolio reads with the
-- actor JWT). Writes are service-role only.
-- ============================================================

create table public.authority_resolutions (
  id                            uuid primary key default gen_random_uuid(),
  organization_id               uuid not null
                                  references public.organizations(id) on delete cascade,
  case_id                       uuid,
  -- Opaque. Compared whole; never parsed.
  external_conversation_ref     text,
  state                         text not null
                                  check (state in ('unknown', 'conflicting')),
  detected_at                   timestamptz not null,
  fail_safe_reason              text,
  provenance_jsonb              jsonb not null default '{}'::jsonb,
  runtime_authority_observed    text
                                  check (
                                    runtime_authority_observed is null
                                    or runtime_authority_observed in ('legacy', 'gu_os')
                                  ),
  created_at                    timestamptz not null default now(),

  constraint authority_resolutions_ref_not_empty
    check (
      external_conversation_ref is null
      or btrim(external_conversation_ref) <> ''
    ),

  constraint authority_resolutions_case_same_org
    foreign key (case_id, organization_id)
    references public.operational_cases (id, organization_id)
);

comment on table public.authority_resolutions is
  'TD-3 / SL-6: durable fail-safe authority resolution (unknown | conflicting). Not a runtime_authority writer. Org members may read; service_role writes.';

comment on column public.authority_resolutions.external_conversation_ref is
  'Opaque conversation reference (legacy lead_id stored whole). Never the Gu OS conversation identity.';

comment on column public.authority_resolutions.state is
  'Fail-safe verdict only. Confident gu / human_active answers are not stored here.';

comment on column public.authority_resolutions.runtime_authority_observed is
  'What the Case column read as at resolve time. Observed, never written back.';

create index idx_authority_resolutions_org_case_detected
  on public.authority_resolutions (organization_id, case_id, detected_at desc);

alter table public.authority_resolutions enable row level security;

create policy "Org members read organization authority resolutions"
  on public.authority_resolutions for select
  to authenticated
  using (public.is_active_org_member(organization_id));

create policy "Org tenancy guard on authority resolutions"
  on public.authority_resolutions as restrictive for select
  to authenticated
  using (public.is_active_org_member(organization_id));

create policy "Service role manages authority resolutions"
  on public.authority_resolutions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
