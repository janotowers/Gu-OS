-- 20260918184500_resolve_or_create_contact_for_legacy_lead.sql
--
-- Forward-era migration (B'). Applied by the Supabase CLI against the
-- forward workdir and recorded in supabase_migrations.schema_migrations.
-- The frozen legacy chain (through 00084_bootstrap_organization_provenance.sql)
-- is applied separately by the ordered-apply bootstrap path and is never
-- touched by the CLI.
--
-- Keep migrations additive and reversible-by-flag where they carry behavior.
--
-- ============================================================
-- R1 Relationship Operations — SL-15 Contact / legacy-lead identity seam.
--
-- Technical Plan TD-8 / TD-1 · Slice Plan Q18 / SA-15.1–SA-15.7.
--
-- This is not `00085` in the frozen legacy directory. The legacy chain is
-- closed at 00084; new schema lands here.
--
-- Atomic resolve-or-create of one Organization-scoped provisional Contact
-- for one opaque Traditional Gu `legacy_lead` id. Modeled on
-- `bootstrap_organization` (00084): Contact + typed identity binding are
-- written in one invocation; a unique_violation rolls the whole block back
-- so a crash cannot leave an orphan Contact; concurrent and retried calls
-- converge on the existing typed identity.
--
-- The opaque lead id is stored and compared whole. Nothing here parses it.
-- Two different lead ids are never merged. An incompatible, ambiguous or
-- cross-Organization existing binding fails closed.
--
-- SECURITY INVOKER; EXECUTE restricted to service_role. A binding is never
-- an authority grant.
-- ============================================================

create or replace function public.resolve_or_create_contact_for_legacy_lead(
  p_organization_id uuid,
  p_legacy_lead_id  text,
  p_provenance      jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_legacy_lead_id text;
  v_contact_id     uuid;
  v_binding_org    uuid;
  v_binding_ref    uuid;
  v_contact_org    uuid;
  v_match_count    integer;
  v_provenance     jsonb;
begin
  if p_organization_id is null then
    raise exception
      'resolve_or_create_contact_for_legacy_lead: missing_organization'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1
      from public.organizations o
     where o.id = p_organization_id
  ) then
    raise exception
      'resolve_or_create_contact_for_legacy_lead: missing_organization'
      using errcode = 'P0001';
  end if;

  -- Trim only. The value is compared whole; no component is parsed out.
  v_legacy_lead_id := btrim(p_legacy_lead_id);
  if v_legacy_lead_id is null or v_legacy_lead_id = '' then
    raise exception
      'resolve_or_create_contact_for_legacy_lead: missing_legacy_lead_id'
      using errcode = 'P0001';
  end if;

  select count(*)
    into v_match_count
    from public.external_identity_bindings b
   where b.source_system = 'traditional_gu'
     and b.binding_kind  = 'legacy_lead'
     and b.external_id   = v_legacy_lead_id;

  if v_match_count > 1 then
    raise exception
      'resolve_or_create_contact_for_legacy_lead: ambiguous_binding'
      using errcode = 'P0001';
  end if;

  if v_match_count = 1 then
    select b.organization_id, b.ref_contact_id
      into v_binding_org, v_binding_ref
      from public.external_identity_bindings b
     where b.source_system = 'traditional_gu'
       and b.binding_kind  = 'legacy_lead'
       and b.external_id   = v_legacy_lead_id;

    if v_binding_org is distinct from p_organization_id then
      raise exception
        'resolve_or_create_contact_for_legacy_lead: cross_organization_binding'
        using errcode = 'P0001';
    end if;

    if v_binding_ref is null then
      raise exception
        'resolve_or_create_contact_for_legacy_lead: incompatible_binding'
        using errcode = 'P0001';
    end if;

    select c.organization_id
      into v_contact_org
      from public.contacts c
     where c.id = v_binding_ref;

    if v_contact_org is null or v_contact_org is distinct from p_organization_id then
      raise exception
        'resolve_or_create_contact_for_legacy_lead: incompatible_binding'
        using errcode = 'P0001';
    end if;

    return v_binding_ref;
  end if;

  v_provenance := jsonb_strip_nulls(
    coalesce(p_provenance, '{}'::jsonb)
    || jsonb_build_object(
      'source', 'resolve_or_create_contact_for_legacy_lead',
      'source_system', 'traditional_gu',
      'binding_kind', 'legacy_lead',
      'opaque_legacy_lead_ref', v_legacy_lead_id,
      'organization_id', p_organization_id
    )
  );

  insert into public.contacts (organization_id)
  values (p_organization_id)
  returning id into v_contact_id;

  insert into public.external_identity_bindings (
    organization_id,
    source_system,
    binding_kind,
    external_id,
    ref_contact_id,
    provenance_jsonb
  )
  values (
    p_organization_id,
    'traditional_gu',
    'legacy_lead',
    v_legacy_lead_id,
    v_contact_id,
    v_provenance
  );

  return v_contact_id;

exception
  when unique_violation then
    -- Concurrency/replay: the whole block rolls back, so no orphan Contact
    -- survives. Re-read and converge, or fail closed.
    select count(*)
      into v_match_count
      from public.external_identity_bindings b
     where b.source_system = 'traditional_gu'
       and b.binding_kind  = 'legacy_lead'
       and b.external_id   = v_legacy_lead_id;

    if v_match_count > 1 then
      raise exception
        'resolve_or_create_contact_for_legacy_lead: ambiguous_binding'
        using errcode = 'P0001';
    end if;

    if v_match_count = 0 then
      raise;
    end if;

    select b.organization_id, b.ref_contact_id
      into v_binding_org, v_binding_ref
      from public.external_identity_bindings b
     where b.source_system = 'traditional_gu'
       and b.binding_kind  = 'legacy_lead'
       and b.external_id   = v_legacy_lead_id;

    if v_binding_org is distinct from p_organization_id then
      raise exception
        'resolve_or_create_contact_for_legacy_lead: cross_organization_binding'
        using errcode = 'P0001';
    end if;

    if v_binding_ref is null then
      raise exception
        'resolve_or_create_contact_for_legacy_lead: incompatible_binding'
        using errcode = 'P0001';
    end if;

    select c.organization_id
      into v_contact_org
      from public.contacts c
     where c.id = v_binding_ref;

    if v_contact_org is null or v_contact_org is distinct from p_organization_id then
      raise exception
        'resolve_or_create_contact_for_legacy_lead: incompatible_binding'
        using errcode = 'P0001';
    end if;

    return v_binding_ref;
end;
$$;

comment on function public.resolve_or_create_contact_for_legacy_lead(uuid, text, jsonb) is
  'Idempotent resolve-or-create of one provisional Contact for one opaque Traditional Gu legacy_lead id inside one Organization. The lead id is compared whole and never parsed. Concurrent and retried calls converge on the existing typed binding; incompatible, ambiguous or cross-Organization bindings fail closed. Contact + binding are one transaction so a crash cannot leave an orphan Contact. SECURITY INVOKER; EXECUTE restricted to service_role.';

revoke execute on function public.resolve_or_create_contact_for_legacy_lead(uuid, text, jsonb) from public;
revoke execute on function public.resolve_or_create_contact_for_legacy_lead(uuid, text, jsonb) from anon;
revoke execute on function public.resolve_or_create_contact_for_legacy_lead(uuid, text, jsonb) from authenticated;
grant  execute on function public.resolve_or_create_contact_for_legacy_lead(uuid, text, jsonb) to service_role;
