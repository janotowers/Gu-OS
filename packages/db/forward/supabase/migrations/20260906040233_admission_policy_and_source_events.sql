-- 20260906040233_admission_policy_and_source_events.sql
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
-- R1 Relationship Operations — SL-2 Admission (shadow).
--
-- Technical Plan §2 TD-2 (versioned Organization policy), TD-8 (lead_opportunity
-- case type) and symbolic unit M-SOURCE-EVENTS · ADR-108 (policy) · ADR-106
-- (Organization-native tenancy).
--
-- Both new tables are Organization-owned from birth (organization_id NOT NULL),
-- so neither needs a legacy NULL-Organization path and neither needs the
-- restrictive guard composition 00081 required for operational_cases.
--
--   * organization_policies — typed, versioned, governed policy. Only a
--     `published` row is runtime authority (AC-5: the authoring plane is not the
--     runtime plane). Published rows are immutable and delete-protected,
--     following the workflow_definitions precedent (00065), so a disposition
--     that recorded "policy version n" keeps meaning what it meant.
--
--   * source_events — the inbound event inbox. A UNIQUE dedup_key is what makes
--     "the same event delivered twice yields one effective admission outcome"
--     (S1 AC-05, SA-2.4) a structural guarantee rather than application
--     discipline.
--
-- Neither table grants any prospect-facing capability. SL-2 is shadow: rows here
-- are audit data, and with `relationship_ops` off nothing writes them at all.
--
-- Additive only. Rollback is flag-off: rows become inert.
-- ============================================================

-- ============================================================
-- organization_policies — typed, versioned, governed (TD-2, ADR-108)
-- ============================================================

create table public.organization_policies (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,

  -- Typed registry mirrored in packages/types. R1 lands the first purpose.
  policy_type         text not null
                        check (policy_type in ('relationship_admission')),
  version             integer not null check (version >= 1),
  status              text not null default 'draft'
                        check (status in ('draft', 'validated', 'published', 'archived')),

  -- The structured policy the deterministic resolver reads. Never free text.
  policy_jsonb        jsonb not null default '{}'::jsonb,
  -- Provenance only: the natural language the Organization authored. Authoring
  -- is a later Slice; the column exists so NL intent is never lost when a
  -- structured policy is compiled from it.
  nl_intent_source    text,

  -- NO ACTION on delete, matching the workflow_definitions precedent (00065).
  -- `on delete set null` would let a profile deletion silently rewrite the
  -- publication provenance of a row ADR-108 declares immutable; deleting a
  -- profile that published a policy is refused instead.
  published_by        uuid references public.profiles(id),
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint organization_policies_version_unique
    unique (organization_id, policy_type, version),

  -- A published row records when it was published; a row that has never been
  -- published must not carry publication provenance it does not have. Archived
  -- rows keep whatever they had, since archival preserves history.
  constraint organization_policies_publication_provenance check (
    (status = 'published' and published_at is not null)
    or (status in ('draft', 'validated') and published_by is null and published_at is null)
    or status = 'archived'
  )
);

comment on table public.organization_policies is
  'TD-2 / ADR-108: typed, versioned Organization policy. Only status = published carries runtime authority; draft and validated rows are authoring state. A missing or invalid policy never widens authority - resolution falls back to the versioned platform Recommended baseline in packages/types, not to "no policy, so allow".';

comment on column public.organization_policies.policy_jsonb is
  'Structured policy read by the deterministic resolver. Model interpretation happens before publication, never at resolution time.';

comment on column public.organization_policies.nl_intent_source is
  'Provenance only: the natural language the Organization authored. Never runtime authority.';

-- At most one published row per (Organization, policy_type). This is what makes
-- "the effective policy" a single well-defined thing rather than a search.
create unique index uq_organization_policies_published
  on public.organization_policies (organization_id, policy_type)
  where status = 'published';

create index idx_organization_policies_lookup
  on public.organization_policies (organization_id, policy_type, version desc);

-- Published rows are immutable except for archival, and cannot be deleted.
-- Same shape as workflow_definitions (00065), with the hardened function
-- settings 00080 established.
create or replace function public.organization_policies_protect_published()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'published' then
    -- ADR-108 §4: published versions are immutable. The ONLY permitted change
    -- is the lifecycle transition to archived (plus its updated_at stamp).
    -- Every other column is pinned, publication provenance included: a
    -- disposition that attributed this version must be reconstructable from it
    -- later, which is false if nl_intent_source, published_by or published_at
    -- can be rewritten afterwards.
    if new.status = 'archived'
      and new.id = old.id
      and new.organization_id = old.organization_id
      and new.policy_type = old.policy_type
      and new.version = old.version
      and new.policy_jsonb = old.policy_jsonb
      and new.nl_intent_source is not distinct from old.nl_intent_source
      and new.published_by is not distinct from old.published_by
      and new.published_at is not distinct from old.published_at
      and new.created_at = old.created_at
    then
      return new;
    end if;
    raise exception 'organization_policies rows with status=published are immutable; only status may change, to archived (publish a new version instead)';
  end if;
  return new;
end;
$$;

create trigger organization_policies_protect_published_trigger
  before update on public.organization_policies
  for each row execute function public.organization_policies_protect_published();

create or replace function public.organization_policies_reject_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status in ('published', 'archived') then
    raise exception 'published/archived organization_policies rows cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger organization_policies_reject_delete_trigger
  before delete on public.organization_policies
  for each row execute function public.organization_policies_reject_delete();

-- RLS: membership reads, service-role writes (TD-1 access matrix).
alter table public.organization_policies enable row level security;

create policy "Org members read organization policies"
  on public.organization_policies for select
  to authenticated
  using (public.is_active_org_member(organization_id));

create policy "Service role manages organization policies"
  on public.organization_policies for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- source_events — inbound event inbox (M-SOURCE-EVENTS)
--
-- Technical Plan §3 event ingestion. Legacy-side forwarding is cross-repo
-- contract C1; until it ships the interim polling adapter inside the gateway
-- writes the same inbox, so the ingestion contract does not change when C1
-- lands - only who writes the row.
--
-- Service-role only in BOTH directions per the TD-1 access matrix (operational
-- internals, never exposed to user JWTs), so this table gets no authenticated
-- read policy.
-- ============================================================

create table public.source_events (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,

  source_system       text not null
                        check (source_system in ('traditional_gu')),
  -- The four first-class kinds named in Technical Plan §3.
  event_kind          text not null
                        check (event_kind in (
                          'inbound_prospect_message',
                          'advisor_activity',
                          'appointment_change',
                          'assignment_change'
                        )),

  -- Opaque external references, stored and compared, never parsed.
  external_ref        text,
  external_lead_ref   text,

  -- THE idempotency guarantee (S1 AC-05 / SA-2.4). Same logical event, one row.
  dedup_key           text not null,

  -- Allowlisted normalized payload; the SL-1 gateway normalizes before anything
  -- lands here. Never a raw legacy record dump.
  payload_jsonb       jsonb not null default '{}'::jsonb,
  provenance_jsonb    jsonb not null default '{}'::jsonb,

  -- Claim/lease processing. Status + claimed_at + completed_at follow the
  -- CURRENT telegram_webhook_updates ledger (00052); claim_expires_at follows
  -- the work-plane lease convention (00069) because a polling adapter may run
  -- on more than one application instance.
  status              text not null default 'pending'
                        check (status in ('pending', 'processing', 'completed', 'failed')),
  claimed_at          timestamptz,
  claimed_by          text,
  claim_expires_at    timestamptz,
  completed_at        timestamptz,
  processing_error    text,

  -- The settled admission disposition for this event, with its effective policy
  -- attribution. It lives here rather than only on the Case because a lead that
  -- is NOT admitted has no Case to carry it (S1 EC-01), and because this is what
  -- lets a redelivery return the original outcome instead of deciding again -
  -- which is what "one effective admission outcome" (AC-05 / SA-2.4) means.
  -- For an admitted lead the Case facts remain the business truth; this column
  -- is the processing record.
  decision_jsonb      jsonb,

  -- The Opportunity Case this event admitted, written immediately after the
  -- Case row exists and BEFORE settlement. That ordering is the whole point: a
  -- process that dies between materialisation and settlement leaves a durable
  -- pointer, so the retry reconciles to the Case that already exists instead of
  -- creating a second one (S1 §8.16: duplicate/retry processing must not create
  -- multiple active Opportunities for the same admitted event).
  --
  -- Composite FK, matching case_relationships (00083): a cross-tenant pointer is
  -- structurally impossible rather than merely discouraged.
  admitted_case_id    uuid,

  received_at         timestamptz not null default now(),

  constraint source_events_dedup_key_not_empty
    check (btrim(dedup_key) <> ''),

  constraint source_events_completed_shape check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),

  constraint source_events_admitted_case_same_org
    foreign key (admitted_case_id, organization_id)
    references public.operational_cases (id, organization_id)
);

comment on table public.source_events is
  'M-SOURCE-EVENTS: inbound event inbox for Relationship Operations. UNIQUE (organization_id, dedup_key) is what makes duplicate delivery collapse structurally (S1 AC-05) rather than by application discipline. Shadow stage: rows are audit data and drive no prospect-facing effect. Service-role only in both directions (TD-1).';

comment on column public.source_events.dedup_key is
  'Stable identity of the logical source event. Unique per Organization: a redelivery collides here rather than producing a second admission outcome.';

comment on column public.source_events.payload_jsonb is
  'Allowlisted normalized payload produced by the SL-1 gateway. Never a raw legacy record dump.';

comment on column public.source_events.admitted_case_id is
  'The Opportunity Case this event admitted. Written before settlement so a crash between materialisation and settlement is recoverable: the retry reconciles to this Case instead of creating a second one. Organization-contained by composite FK.';

comment on column public.source_events.status is
  'pending -> processing -> completed | failed. A claim moves pending to processing and stamps claim_expires_at; a duplicate arriving while a live claim holds must NOT decide anything, and a duplicate arriving after the lease expired may reclaim. Only completed carries a settled decision_jsonb.';

-- Organization-scoped uniqueness: two Organizations may legitimately produce the
-- same external key, and neither should collide with the other.
create unique index uq_source_events_dedup
  on public.source_events (organization_id, dedup_key);

create index idx_source_events_pending
  on public.source_events (organization_id, received_at)
  where status in ('pending', 'processing');

create index idx_source_events_lead
  on public.source_events (organization_id, external_lead_ref)
  where external_lead_ref is not null;

-- Stale-claim recovery, mirroring the work-plane lease index (00069): a
-- processing row whose claim_expires_at has passed is reclaimable.
create index idx_source_events_expired_claims
  on public.source_events (claim_expires_at)
  where status = 'processing';

alter table public.source_events enable row level security;

create policy "Service role manages source events"
  on public.source_events for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- Reconciliation lookup: the Case a source event already materialised
--
-- `admitted_case_id` closes the crash window after it is written, but there is
-- still a narrow one between `operational_cases` INSERT and that write. The
-- admission executor stamps the source event id into the Case context, so
-- recovery has a second, independent way to find an already-created Case
-- before deciding to create one. This index makes that lookup deterministic
-- rather than a scan.
-- ============================================================

create index idx_operational_cases_source_event
  on public.operational_cases ((context_jsonb ->> 'source_event_id'))
  where context_jsonb ? 'source_event_id';

-- ============================================================
-- ai_usage_events.organization_id — correlation completeness (TP §7 (a))
--
-- Additive and nullable: every existing row keeps its meaning, and the column
-- is populated from the ambient usage context when a caller bound one. The
-- baseline Definition of Done adds a correlation-coverage check from SL-2
-- onward, and the admission interpreter is the first Organization-scoped model
-- call - so without this column its cost could not be attributed to the
-- Organization that incurred it.
--
-- No FK on purpose, matching the other correlation columns on this table: the
-- ledger is append-only evidence and must survive the deletion of anything it
-- refers to.
-- ============================================================

alter table public.ai_usage_events
  add column if not exists organization_id uuid;

comment on column public.ai_usage_events.organization_id is
  'Owning Organization when the call ran under an Organization-scoped context (R1). Nullable: user-scoped legacy paths have none. Correlation dimension, not an allocation - one event may correlate to Organization, Case and Work Item at once.';

create index if not exists idx_ai_usage_events_organization
  on public.ai_usage_events (organization_id, occurred_at desc)
  where organization_id is not null;

-- ============================================================
-- lead_opportunity case type + published definition v1 (TD-8)
--
-- A single durable open state with a terminal close: Opportunity progression
-- lives in case_facts, not in a workflow stage. The definition exists because
-- 00066 pins every Case to a definition version, not because Relationship
-- Operations wants a stage machine.
-- ============================================================

insert into public.operational_case_types
  (case_type, display_name, default_skill_slug, default_reminder_policy_jsonb, description)
values (
  'lead_opportunity',
  'Oportunidad de prospecto',
  'lead-opportunity-supervisor',
  '{}'::jsonb,
  'Responsabilidad duradera de Gu OS sobre una oportunidad de prospecto (R1 Relationship Operations, S1). Estado durable unico: la progresion vive en case_facts, no en un stage de workflow. Los recordatorios los gobierna la postura del supervisor, no una politica del catalogo.'
)
-- `case_type` stopped being the primary key in 00022; global uniqueness is the
-- partial index `operational_case_types_global_slug_idx`, so the conflict
-- target must name its predicate or the statement has no arbiter to infer.
on conflict (case_type) where user_id is null do nothing;

insert into public.workflow_definitions (
  owner_scope, user_id, case_type, workflow_key, version, status,
  industry, domain_tags, graph_jsonb, definition_hash,
  visibility, published_at, provenance_jsonb
)
values (
  'global', null, 'lead_opportunity', 'lead_opportunity', 1, 'published',
  'real_estate', array['real_estate', 'relationship_operations'],
  '{"states":[{"key":"open","label":"Oportunidad abierta","kind":"operational"},{"key":"closed","label":"Oportunidad cerrada","kind":"terminal"}],"transitions":[{"from":"open","to":"closed","guards":[],"authorized_proposers":["decision_handler","runtime"],"approval_required":null}],"step_bindings":[],"work_templates":[],"postconditions":[],"approvals":[],"impact_dependencies":{},"completion":{"terminal_states":["closed"],"required_evidence":[]}}'::jsonb,
  -- Real canonical hash of the graph above, computed with the repository's own
  -- computeDefinitionHash (packages/workflows/src/hash.ts). Evidence records
  -- pin to this value, so a placeholder here would be a lie the whole
  -- evidence chain then repeats.
  'sha256:308a525155cb80559f3a8a04a17b75b04ac46578bf1af7e702f1093d569bb0d3',
  'shared_template', now(),
  '{"source": "R1 SL-2 admission", "migration": "20260906040233", "note": "Minimal durable-state definition. Business progression is fact-driven (TD-8); this graph exists only to satisfy definition pinning."}'::jsonb
)
on conflict (case_type, version)
  where user_id is null and owner_scope = 'global'
  do nothing;
