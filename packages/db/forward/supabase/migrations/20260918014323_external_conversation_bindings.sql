-- 20260918014323_external_conversation_bindings.sql
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
-- R1 Relationship Operations — SL-6 Bindings + authority (advisory).
--
-- Technical Plan §2 TD-4 / TD-3 · Architecture AC-4 §9.7 · ADR-107.
-- Symbolic unit M-EXT-BINDINGS. Slice Plan SA-6.1, SA-6.2, SA-6.13.
--
-- New table `external_conversation_bindings`. This is NOT a widening of
-- `operational_case_conversation_bindings` (00044): that table is the internal
-- web/telegram routing binding (`chat_id bigint`, user-scoped RLS) and TD-4
-- forbids mutating it. The two tables have different semantics, different
-- tenancy and different identity types.
--
-- This is also not `00085` in the frozen legacy directory. The legacy chain
-- is closed at 00084; new schema lands here.
--
-- Rules this table exists to make structural:
--   * an external conversation ref is OPAQUE — stored and compared, never
--     parsed. Legacy `lead_id` is a reference, never the Gu OS conversation
--     identity (AC-4 §9.7);
--   * at most one ACTIVE binding per (case, provider, ref) (TD-4 / SA-6.1);
--   * conversation-authority columns are NULL by CHECK on every
--     `thread_kind='advisor_wa'` row (TD-4 / SA-6.2 / audit §9.1.1). An
--     advisor-thread observation cannot mint authority through this table;
--   * Case, contact and optional Gu-channel identity are same-Organization
--     by composite FK, so a cross-tenant pointer cannot be inserted;
--   * service-role only in both directions (TD-1 access matrix). This table
--     is an operational/security internal and has no authenticated read path.
--
-- Conversation-authority fields live here because they belong to the
-- conversation, not the Case. Runtime decision authority stays on
-- `operational_cases.runtime_authority` (TD-3) and is not written by SL-6.
--
-- Additive only. Rollback is flag-off: rows become inert. Nothing here
-- grants a prospect-facing effect.
-- ============================================================

-- Composite-FK target so a Gu-channel identity binding can be same-Organization
-- by construction. `id` is already the primary key, so (id, organization_id)
-- is uniquely determined; this unique exists only as the FK target.
alter table public.external_identity_bindings
  add constraint external_identity_bindings_id_org
    unique (id, organization_id);

create table public.external_conversation_bindings (
  id                              uuid primary key default gen_random_uuid(),
  organization_id                 uuid not null
                                    references public.organizations(id) on delete cascade,

  case_id                         uuid not null,
  contact_id                      uuid not null,

  provider                        text not null
                                    check (provider in ('whatsapp_business')),
  -- Opaque. Legacy lead_id and/or a provider thread id, stored whole.
  external_conversation_ref       text not null,

  -- Optional ref to the Gu/WABA number identity binding (TD-4). Same
  -- Organization by composite FK. Kind is not CHECKed here: the application
  -- attaches a `gu_whatsapp_number` binding; the FK only prevents a
  -- cross-tenant pointer.
  gu_channel_identity_binding_id  uuid,

  thread_kind                     text not null
                                    check (thread_kind in ('gu', 'advisor_wa')),

  -- Conversation-authority fields (TD-3). Valid only on thread_kind='gu'.
  conversation_authority          text
                                    check (
                                      conversation_authority is null
                                      or conversation_authority in ('gu', 'human_active')
                                    ),
  last_human_activity_at          timestamptz,
  authority_source                text,

  status                          text not null default 'active'
                                    check (status in ('active', 'ended')),
  ended_at                        timestamptz,

  provenance_jsonb                jsonb not null default '{}'::jsonb,

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),

  constraint external_conversation_bindings_ref_not_empty
    check (btrim(external_conversation_ref) <> ''),

  constraint external_conversation_bindings_ended_shape
    check (
      (status = 'ended' and ended_at is not null)
      or (status <> 'ended' and ended_at is null)
    ),

  -- SA-6.2 / TD-4: advisor threads are evidence-only. Authority columns are
  -- null by construction; the resolver also ignores these rows.
  constraint external_conversation_bindings_advisor_wa_null_authority
    check (
      thread_kind <> 'advisor_wa'
      or (
        conversation_authority is null
        and last_human_activity_at is null
        and authority_source is null
      )
    ),

  constraint external_conversation_bindings_case_same_org
    foreign key (case_id, organization_id)
    references public.operational_cases (id, organization_id),

  constraint external_conversation_bindings_contact_same_org
    foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id),

  constraint external_conversation_bindings_channel_same_org
    foreign key (gu_channel_identity_binding_id, organization_id)
    references public.external_identity_bindings (id, organization_id)
);

comment on table public.external_conversation_bindings is
  'TD-4 / SL-6: Organization-scoped binding between a Case/contact and an opaque external conversation. Conversation-authority fields are valid only on thread_kind=gu; advisor_wa rows are evidence-only (CHECK). Service-role only. Distinct from operational_case_conversation_bindings (00044).';

comment on column public.external_conversation_bindings.external_conversation_ref is
  'Opaque external conversation identifier. Legacy lead_id is stored and compared whole; it is a reference, never the Gu OS conversation identity.';

comment on column public.external_conversation_bindings.thread_kind is
  'gu = the Gu-owned prospect thread (may carry conversation authority). advisor_wa = captured off-thread advisor evidence; authority columns must be null.';

comment on column public.external_conversation_bindings.conversation_authority is
  'TD-3 conversation authority: gu | human_active. Null until resolved. Forced null on advisor_wa. Not runtime decision authority — that stays on operational_cases.runtime_authority.';

comment on column public.external_conversation_bindings.authority_source is
  'Provenance of the conversation-authority fields (which evidence path last wrote them). Forced null on advisor_wa. Not a last-write-wins reconciler.';

comment on column public.external_conversation_bindings.gu_channel_identity_binding_id is
  'Optional same-Organization ref to the Gu/WABA number identity binding. Never a raw phone number.';

-- SA-6.1 / TD-4: at most one active binding per (case, provider, ref).
create unique index uq_external_conversation_bindings_active
  on public.external_conversation_bindings
     (case_id, provider, external_conversation_ref)
  where status = 'active';

create index idx_external_conversation_bindings_org_ref
  on public.external_conversation_bindings
     (organization_id, provider, external_conversation_ref, status);

create index idx_external_conversation_bindings_case
  on public.external_conversation_bindings (case_id, status);

alter table public.external_conversation_bindings enable row level security;

create policy "Service role manages external conversation bindings"
  on public.external_conversation_bindings for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
