-- 20260918141500_authority_resolution_lifecycle.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084) is never touched.
--
-- ============================================================
-- R1 Relationship Operations — SL-6 review repair.
--
-- Additive columns on authority_resolutions:
--   * provider_message_id — C2 logical request identity (Appendix D.3).
--     Unique per Organization when present, so a retry cannot insert a
--     second durable incident. No signature replay cache (ADR-111 §8).
--   * resolved_at / resolved_as — close an unresolved incident when a
--     later confident observation resolves it. Historical rows remain.
--     Portfolio surfaces only unresolved incidents.
--
-- This table still does not write operational_cases.runtime_authority.
-- ============================================================

alter table public.authority_resolutions
  add column provider_message_id text,
  add column resolved_at timestamptz,
  add column resolved_as text
    check (
      resolved_as is null
      or resolved_as in ('gu', 'human_active')
    );

alter table public.authority_resolutions
  add constraint authority_resolutions_provider_message_id_not_empty
    check (
      provider_message_id is null
      or btrim(provider_message_id) <> ''
    );

alter table public.authority_resolutions
  add constraint authority_resolutions_resolved_pair
    check (
      (resolved_at is null and resolved_as is null)
      or (resolved_at is not null and resolved_as is not null)
    );

create unique index authority_resolutions_org_provider_message_id_uidx
  on public.authority_resolutions (organization_id, provider_message_id)
  where provider_message_id is not null;

create index idx_authority_resolutions_org_case_unresolved
  on public.authority_resolutions (organization_id, case_id, detected_at desc)
  where resolved_at is null;

comment on column public.authority_resolutions.provider_message_id is
  'Opaque C2 logical request identity (provider message id after Traditional Gu dedup). Unique per Organization when present. Not a signature cache.';

comment on column public.authority_resolutions.resolved_at is
  'When a later confident observation closed this incident. Null = unresolved and eligible to surface.';

comment on column public.authority_resolutions.resolved_as is
  'Confident conversation verdict that closed the incident. Not an incident row and not a runtime_authority write.';
