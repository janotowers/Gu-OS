# R1 Relationship Operations — Traditional Gu Legacy Source Audit

> **Version:** v0.5 — §24.3 gains the exact per-path store ordering (verified 2026-09-17), which [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) §7 depends on  
> **Status:** Complete for R1 architecture/Technical-Plan entry — v0.2 full audit (2026-08-28) plus targeted drift revalidation (2026-08-31); source-verified legacy contracts and risks; exact adapter/API/schema mechanics remain Technical Design  
> **Roadmap Increment:** R1 — Relationship Operations v1  
> **Audit date:** 2026-08-28 (original full audit)  
> **Targeted drift revalidation:** 2026-08-31 — targeted R1-relevant revalidation, **not** a full new audit; see §23  
> **Gu OS repository:** `janotowers/10x-builders-agent`, `main`  
> **Traditional Gu repositories audited (v0.2 baseline):** `UnggaMX/ungga-full`, `gcp/main` at `ae9f107a1d53c8bc25a327bece5701aac192ac49`; `UnggaMX/ungga-landing`, `main` at `77e3dc7fb562f9b249a5d5ec7f8f159e6f2ccdfa`  
> **Revalidated through (2026-08-31):** `UnggaMX/ungga-full`, `gcp/main` at `c88792530152c0c91a1e74c59e26a416103e68ff`; `UnggaMX/ungga-landing`, `main` at `82cab192bec2f23a0709c57ce06204d21007a179`  
> **Contract-precision revalidation (2026-09-17):** `UnggaMX/ungga-full`, `gcp/main` at `3fdb16ca3469b5f9c667613839af384ec1f4800e`; `UnggaMX/ungga-landing`, `main` at `ce60cb22e999d004990f7685e2a08d7512f73504` — scoped to the C1/C2/C6 emission, read and durability seams; see §24  
> **Companion Architecture Analysis:** `docs/product/roadmap-increments/r1-relationship-operations-v1/architecture-analysis.md`  
> **S1 behavioral contract:** `docs/product/operating-domains/relationship-operations/specs/lead-opportunity-lifecycle.md`  
> **Shared-kernel mapping:** `docs/product/roadmap-increments/r1-relationship-operations-v1/r1-concept-shared-kernel-mapping.md`  
> **Relevant ADRs:** ADR-106 Organization-Native Multi-seat Tenancy; ADR-107 Runtime / Conversation Authority; ADR-108 Versioned Organization Policy; ADR-109 Generic Case Relationships / Lineage; ADR-110 Resource Usage & Cost Attribution  
> **Artifact role:** Record source-verified Traditional Gu production contracts that R1 may depend on during brownfield migration, distinguish those contracts from Gu OS target semantics, and identify legacy risks that must not be inherited as Gu OS invariants.

---

## 1. Executive conclusion

The minimum Traditional Gu source audit needed to enter R1 Technical Planning is complete.

The audit does **not** reveal a need to reopen AC-1 through AC-10. Instead, the production code materially reinforces the architecture already accepted:

- legacy identity, organization, assignment and conversation authority are separate concerns even though historical fields sometimes blur them;
- `lead_id` is an operational context identifier, not canonical Prospect or Opportunity identity;
- Legacy Deal is property-interest / visit-context evidence, not the Transaction boundary;
- appointment persistence is brownfield and partially replicated rather than globally atomic;
- visit attendance requires explicit post-appointment evidence and cannot be inferred from appointment existence;
- Firestore property records are the original Traditional Gu property source while Mongo/Qdrant serve operational search/read needs;
- WhatsApp execution has usable provider correlation (`wamid`) and failure callbacks, but the current seams do not expose a complete Gu OS-grade idempotent command/effect contract;
- current human-takeover behavior already separates "Gu stops speaking" from "Gu stops observing/reasoning";
- current authorization shortcuts in legacy/new-owner-app paths must not be copied into organization-scoped Gu OS capabilities.

The appropriate R1 migration strategy remains:

> **Wrap and govern selected Traditional Gu capabilities behind a bounded operational gateway; preserve source-specific evidence and external identifiers; make Gu OS authoritative only for the responsibilities/facts it owns; and reconcile partial/unknown external effects instead of pretending the brownfield estate is one transactional database.**

**Revalidation outcome (2026-08-31):** a targeted drift revalidation at the new branch heads (§23) found **no audited contract invalidated**. One additive material change (conversation persistence is now multi-thread per Lead, §10), one new relevant seam (advisor-linked WhatsApp capture / `waProbe`, §9.1), a strengthened outbound delivery-failure evidence path (§15.7), and identity/permission clarifications (§4.5). The previously recorded authorization risks persist (§16). The drift does not contradict S1–S4 and does not reopen AC-1 through AC-10 or ADR-106 through ADR-110; it strengthens the case for the bounded operational gateway and adds useful evidence/identity/delivery seams for Technical Design.

---

## 2. Source-status discipline

This audit uses the following labels:

- **CURRENT — LEGACY SOURCE VERIFIED** — directly observed in the audited Traditional Gu production branches/files listed in this artifact.
- **CURRENT — LEGACY RISK** — source-verified behavior that is unsafe, ambiguous or too legacy-specific to promote into a Gu OS invariant.
- **TARGET — EXISTING ADR / SPEC** — already-approved Gu OS direction confirmed or clarified by the audit.
- **OPEN — TECHNICAL DESIGN** — exact adapter, schema, API, event, migration or reconciliation mechanics still to design.
- **OUT OF R1 AUDIT SCOPE** — source area not needed to unblock the current R1 architecture/Technical Plan.

v0.3 adds one label:

- **REVALIDATED — 2026-08-31** — re-verified (or newly verified) at the revalidation heads recorded in the header.

Source verification is scoped to the branches and commits recorded in the header. Statements not explicitly marked as revalidated remain pinned to the v0.2 audit commits; the 2026-08-31 pass was a **targeted R1-relevant drift revalidation** (diff-driven over the seams in §3 plus newly added code), not a re-execution of the full audit. A later Traditional Gu change may still require revalidation of the affected contract before implementation if the source has materially moved.

---

## 3. Audit scope and question set

The audit focused on the production boundaries that R1 must cross:

1. authentication and legacy user identity;
2. organization/principal/advisor semantics;
3. Legacy Lead creation and `lead_id` semantics;
4. assignment and sticky reassignment behavior;
5. WhatsApp inbound routing and provider identifiers;
6. human same-thread takeover and automatic resumption;
7. conversation persistence/read surfaces;
8. appointment creation, persistence and confirmation semantics;
9. post-appointment visit-attendance evidence;
10. Legacy Deal creation/meaning;
11. property source/search topology;
12. outbound WhatsApp transport, provider correlation and failure evidence;
13. current authorization boundaries relevant to R1;
14. billing caller contract only where it directly governs an R1 effect.

The audit intentionally did **not** attempt to catalog every Traditional Gu collection, cron, model graph, notification template or billing-internal implementation.

---

# 4. Authentication, user identity and legacy organization semantics

## 4.1 Firebase Auth is the current human authentication identity

**CURRENT — LEGACY SOURCE VERIFIED**

`ungga-landing` authenticates users through Firebase Auth using email/password and Google. Its server session endpoint verifies the Firebase ID token before resolving the effective application role.

Relevant source:

- `UnggaMX/ungga-landing/src/app/login/login-client.tsx`
- `UnggaMX/ungga-landing/src/app/api/auth/session/route.ts`

The Firebase UID therefore remains an important **external identity** during brownfield migration. It is not, by itself, the Gu OS Organization ID or Opportunity assignment identity.

## 4.2 `organization_id` is a legacy organization/principal bridge, not a clean canonical Organization entity

**CURRENT — LEGACY SOURCE VERIFIED**

The current multi-user model stores an advisor as `users/{advisorUid}` and links that user to the principal/owner through `organization_id`. The same advisor is also represented under:

```text
users/{ownerUid}/users_sellers/{advisorUid}
```

The production estate contains historical representation drift:

- `organization_id` may be a Firestore `DocumentReference`;
- older code/data may treat it as a string/path-like value;
- the owner can self-reference through the organization relation;
- `admin_id`, `organization_id`, role and assignment are not equivalent fields.

`ungga-landing` explicitly contains compatibility logic to normalize these variants rather than assuming one clean representation.

## 4.3 Legacy claims are not sufficient Gu OS authorization

**CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK**

The current session resolver documents that some legacy subusers inherited `super-admin` claims. It therefore inspects the Firestore organization relation to decide whether the account is actually an advisor.

Architectural implication:

> **Do not import Firebase custom claims or legacy role strings as direct Gu OS authorization grants.**

They are migration evidence that must be translated into canonical Gu OS Organization Membership / role/grant semantics under ADR-106.

## 4.4 R1 bridge consequence

**TARGET — EXISTING ADR-106**

Conceptually, Gu OS should resolve:

```text
Gu OS Organization
  └─ Traditional Gu external binding
       ├─ legacy organization key
       ├─ principal Firebase UID
       ├─ member/advisor Firebase UIDs
       ├─ Gu/WABA identifiers
       └─ other source-specific IDs
```

Do not make the canonical Gu OS Organization ID equal to `organization_id` or the principal Firebase UID merely because current Traditional Gu often anchors the organization there.

Exact external-identity schema remains **OPEN — TECHNICAL DESIGN**.

## 4.5 Acting context, staff impersonation and field-scoped org permission

**REVALIDATED — 2026-08-31**

`ungga-landing` now resolves an **acting context** distinct from the raw session: staff can impersonate a user ("ver como usuario"), so authorization gates must use the acting uid, not the session claims. A cached helper `ownerUidOf(uid)` (`src/lib/firebase/session.ts`) resolves the organization owner for **any** uid — an owner resolves to their own uid (owners self-reference or lack `organization_id`); an advisor resolves through `organization_id` to the principal. New org-observing gates (for example the WhatsApp-linking pilot) key on `ownerUidOf(actingUid)`.

`PATCH /api/users/me` no longer requires `organizacion.editar` for the whole body: the `users/{uid}` document mixes **person fields** (name, phone, photo, social) and **organization fields** (`type_user`, `org_name`, `web`, `org_location*`, `privacy_url`), and the permission gate is now applied only when organization fields are touched, so advisors can edit their own personal data.

**Status discipline:** these are legacy clarifications of the identity/permission bridge, **not** Gu OS authorization semantics. The existing rule stands unchanged: legacy Firebase claims and role strings must not become Gu OS grants (ADR-106); Gu OS resolves organization authorization explicitly.

---

# 5. Legacy Lead identity and persistence

## 5.1 `lead_id` is a composite operational-context key

**CURRENT — LEGACY SOURCE VERIFIED**

`guv3` constructs the historical Lead identifier as:

```text
lead_id = prospect_phone + bot_phone_number + owner_phone_number
```

for the ordinary WhatsApp path, with controlled exceptions such as playground/test flows.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/db/firebase/leads.py`
- `UnggaMX/ungga-full/src/guv3/gu/main_app.py`

This source verification confirms the prior architectural interpretation:

> **Legacy `lead_id` identifies a Traditional Gu operational relationship/conversation context. It is not canonical Prospect identity and is not Gu OS Lead Opportunity identity.**

## 5.2 Lead creation writes multiple legacy representations

**CURRENT — LEGACY SOURCE VERIFIED**

Normal creation writes at least:

```text
Firestore
  leads/{lead_id}
  users/{ownerUid}/user_leads/{lead_id}
  leads/{lead_id}/wsp_messeges/{botNumber}

Mongo runtime/context
  gu2.users / related runtime records
```

The Firestore Lead begins with fields such as `Asesor`, `client_type`, `assigned`, `assignment_type`, `new_assignment`, creation/edit timestamps and source context.

The copies are operational representations; R1 must not infer that every similarly named field has identical authority or freshness across stores.

## 5.3 R1 identity rule

**TARGET — EXISTING ARCHITECTURE / S1**

Persist legacy `lead_id` as an **opaque source-scoped external reference**. Do not derive target Gu OS identity by parsing fixed phone lengths from it.

A future operational gateway may expose normalized participants such as:

```text
legacy_lead_id
prospect/contact external identity
Gu channel identity
legacy organization/principal context
assigned advisor if known
```

while preserving the original opaque identifier for source readback/correlation.

## 5.4 Lead-origin classification

**REVALIDATED — 2026-08-31**

`guv3` lead-origin classification (`src/guv3/gu/api/lead_origins.py`, with `gu/core/message_links.py`) is now deterministic and richer: links are extracted from the raw message text (not the LLM tool argument), and origin is derived from real query-string parameters — `src` button marks (`portal-ficha`, `portal-listado`, `gu-compartido`, advisor-shared `wa`) with `utm_source` as fallback, including recognition of AI-assistant referrals (ChatGPT, Gemini, Perplexity, Claude, Copilot, etc., mirrored in the landing's `src/lib/analytics/fuentes.ts`). Gu-shared fichas now use the public portal link tagged `src=gu-compartido`.

**R1 relevance:** this taxonomy is useful **source evidence** for future S1 admission policy (trusted-source eligibility, campaign/listing context behind short inquiries). Legacy origin labels are evidence with provenance, **not** canonical Gu OS admission semantics.

---

# 6. Organization ownership and advisor assignment

## 6.1 Assignment is independent of organization ownership

**CURRENT — LEGACY SOURCE VERIFIED**

The production `/guard-lead-one` path resolves a seller for one Lead at a time and writes assignment across the global Lead, owner copy, seller copy and Mongo runtime projection.

It explicitly implements **sticky assignment**: an already assigned Lead is not automatically reassigned merely because another guard resolution occurs.

Relevant source:

- `UnggaMX/ungga-full/src/services/src/controllers/guardLeadOne.controller.ts`

## 6.2 Current guard assignment is on-demand; older batch path is deprecated

**CURRENT — LEGACY SOURCE VERIFIED**

`periodAssignationControllers.ts` is explicitly marked deprecated and states that it was replaced by `/guard-lead-one` for on-the-fly assignment.

Relevant source:

- `UnggaMX/ungga-full/src/services/src/controllers/periodAssignationControllers.ts`

## 6.3 R1 consequence

**TARGET — ADR-106**

Preserve the distinction:

```text
Organization owns Opportunity
        ≠
current advisor assignment
        ≠
DRI / approver / conversation actor
```

Legacy principal/owner fields and the principal phone embedded in `lead_id` must not silently become R1 assignment or approval authority.

---

# 7. WhatsApp inbound identity and event routing

## 7.1 Provider message ID is available at ingress

**CURRENT — LEGACY SOURCE VERIFIED**

`messageFilter` extracts the WhatsApp message ID, prospect sender number, display/bot number, provider `phone_number_id`, message type/content and context when available.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/lib/filterDataMessage.ts`
- `UnggaMX/ungga-full/src/messageFilter/src/services/webhook.service.ts`

This gives the future operational gateway usable source identifiers for event deduplication/provenance, subject to Technical Design of the event contract.

## 7.2 Incoming webhook routing is queue-based

**CURRENT — LEGACY SOURCE VERIFIED**

After filtering/coalescing, messageFilter publishes payloads to different topics/handlers according to the receiving Gu number. The webhook acknowledges receipt before downstream processing completes.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/lib/handleQueueMessage.ts`
- `UnggaMX/ungga-full/src/messageFilter/src/controllers/webhook.controller.ts`

Architectural implication:

> provider webhook receipt, queue acceptance, Gu processing and business action completion are different states and must remain distinct in R1 event/effect semantics.

---

# 8. Human same-thread takeover and resumption

## 8.1 Owner/advisor activity can transfer conversation authority without ending the Case

**CURRENT — LEGACY SOURCE VERIFIED**

WhatsApp `smb_message_echoes` are interpreted as owner/advisor messages. They enter the Gu runtime with `ownerWritingFromBot=true`.

For the affected Lead, Gu stores runtime state including:

```text
bypass_bot = true
last_owner_interaction_wba = <timestamp>
```

and suppresses automated Gu responses for that conversation.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/services/webhook.service.ts`
- `UnggaMX/ungga-full/src/guv3/gu/main_app.py`

This behavior source-verifies the ADR-107 distinction:

> **human takeover of speaking authority does not inherently erase durable responsibility or Gu's ability to observe/reason.**

## 8.2 Stale standby analysis is guarded against newer human activity

**CURRENT — LEGACY SOURCE VERIFIED**

Before standby analysis proceeds, Gu re-reads `last_owner_interaction_wba` and aborts the stale analysis if the stored value has changed since the candidate analysis was created.

That is a useful brownfield concurrency pattern, but exact implementation should not be promoted as the generic Gu OS mechanism.

## 8.3 Automatic resume is based on >5 minutes, not a six-minute architecture invariant

**CURRENT — LEGACY SOURCE VERIFIED**

The reminder job selects Lead runtime records where:

```text
bypass_bot = true
and last_owner_interaction_wba < now - 5 minutes
```

sets `bypass_bot=false`, and then emits a `chat_analysis=true` message so Gu can reconsider the conversation.

Relevant source:

- `UnggaMX/ungga-full/src/jobFilter/src/reminder/queries/findUsersWithBotFromWBA.ts`
- `UnggaMX/ungga-full/src/jobFilter/src/reminder/index.ts`
- `UnggaMX/ungga-full/src/jobFilter/src/services/MessageService.ts`

Any user-facing copy that says Gu will resume in roughly six minutes is therefore an implementation/UX approximation, not an R1 policy invariant.

## 8.4 Billing can affect the post-takeover analysis path

**CURRENT — LEGACY SOURCE VERIFIED**

The resume job clears `bypass_bot` for eligible records, then suppresses the generated Gu analysis/send for owners whose billing balance is unavailable under the active billing rules. Owners exempt/not-enabled for billing follow separate logic.

R1 should not conflate **conversation authority** with **commercial/billing eligibility**. They are separate gates even if the current job evaluates them in one flow.

---

# 9. Human response from the new owner app converges on the same takeover semantics

**CURRENT — LEGACY SOURCE VERIFIED**

`ungga-landing` `/api/whatsapp/send`:

1. authenticates the session and checks the UI/application permission;
2. loads the target Lead and owner Gu number;
3. sends directly to Meta;
4. captures the returned `wamid`;
5. persists the outbound human message in Firestore and Mongo;
6. synthesizes/forwards a webhook into `messageFilter` so the runtime sees the action as human intervention.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/whatsapp/send/route.ts`

Architectural implication:

> R1 can treat observable advisor activity from WhatsApp Business and the owner app as inputs into the same generic conversation-authority contract, while retaining source provenance.

The current mechanics are legacy-specific and need not be copied literally.

## 9.1 Advisor-linked WhatsApp capture (`waProbe`) — NEW RELEVANT SEAM

**REVALIDATED — 2026-08-31 (new since the v0.2 audit)**

Traditional Gu now contains an advisor-linked WhatsApp capability, currently pilot-grade:

- **`ungga-full/src/waProbe/`** maintains a **linked-device WhatsApp session per advisor** (the WhatsApp Web mechanism, hosted server-side), exposed through a minimal session API (`POST/GET/DELETE /sessions/:userId`) consumed by the landing onboarding.
- **`ungga-landing`** adds the onboarding/linking flow: QR/pairing from Perfil/onboarding, proxied through `POST/GET/DELETE /api/whatsapp/vinculacion`, which always forwards the **verified session uid** (never a client-supplied id) plus a service token.
- **Pilot / whitelist nature:** enabled **per inmobiliaria** via a hardcoded owner-uid whitelist (`hasWhatsAppPilot(ownerUid)` in `src/lib/beta-features.ts`), enforced at **both** the UI and the API route; advisors inherit access through `ownerUidOf`.
- **Consent-versioned:** the advisor accepts a permissions text tracked by `CONSENT_VERSION` (currently `2026-08-06`); widening capture scope requires re-consent.
- **Known-lead filtering before content capture:** the session resolves the counterpart phone and checks it against a lead index (`bot_phone_number`-scoped Firestore load or local file) **before** reading message content; non-lead traffic is dropped unread and unlogged.
- **Persistence, separate from Gu's LLM memory:** captured advisor↔prospect 1:1 messages (text, transcribed voice notes, described images) are written to Firestore `leads/{lead_id}/wsp_messeges/asesor_<phone>` documents and to Mongo `gu2.chats` per-advisor arrays (`messages_from_<phone>`). **Mongo `messagesv2` — the memory `guv3` feeds to Gu's LLM — is deliberately not touched**, so legacy Gu does not "see" advisor threads; connecting them to Gu reasoning is an explicit future decision requiring `guv3` changes.
- **Advisor endpoint identity:** the linked number is persisted as `users/{uid}.whatsapp_link.{status,phone}` — a source-verified external mapping for the **advisor human WhatsApp endpoint** identity dimension (ADR-106).
- **Operational grade:** the service is a spike — stateful in-process sockets, one per linked advisor, no scale-to-zero, unofficial client. **It is best-effort and MUST NOT become load-bearing for Gu OS correctness**; Gu OS may consume its output as evidence when present.

### 9.1.1 Conversation-authority rule for `advisor_wa` observations

**TARGET — EXISTING ADR-107, clarified by this revalidation**

`advisor_wa` captures are **evidence of off-thread human activity** (the advisor's own WhatsApp with the prospect), reducing the off-thread evidence gap recorded in ADR-107 and S2. They are **not** a conversation-authority transition:

- they do **not** set `bypass_bot` and do not touch the same-thread takeover/resume mechanics of §8 (which remain unchanged);
- they must **not** automatically suppress Gu speaking on the Gu-number conversation;
- any suppression or authority effect derived from observed advisor activity requires explicit, ADR-107-conformant policy plus current authority resolution in Gu OS.

---

# 10. Conversation persistence is deliberately multi-store

**CURRENT — LEGACY SOURCE VERIFIED**

Traditional Gu maintains conversation material in more than one representation:

- Mongo `chats/messagesv2` contains the richer Gu runtime/context history and source/provider identifiers used by several runtime paths;
- Firestore `leads/{lead_id}/wsp_messeges/{botNumber}.conversation` is also written/read by product surfaces;
- outbound worker/template paths write provider IDs and hidden routing metadata into Mongo and user-visible conversation material into Firestore where applicable.

Relevant source includes:

- `UnggaMX/ungga-full/src/guv3/gu/core/notification_functions.py`
- `UnggaMX/ungga-full/src/workers/src/notificator/saveChat.ts`
- `UnggaMX/ungga-landing/src/lib/firebase/leads.ts`

R1 must therefore avoid the statement "Firestore is the source of truth for all conversations" or "Mongo is the source of truth for all conversations." The operational gateway should expose **business-semantic reads with explicit source/evidence semantics** rather than leaking this replication topology into the Case Supervisor.

## 10.1 Multi-thread persistence per Lead

**REVALIDATED — 2026-08-31 (material additive change)**

The Firestore conversation store is now **multi-thread per Lead**. `leads/{lead_id}/wsp_messeges` holds:

- the Gu-number conversation document(s), as before; and
- one `asesor_<phone>` document per linked advisor who attended the prospect from their own WhatsApp (§9.1), whose items carry `source: "advisor_wa"` plus the advisor as author.

The platform (`ungga-landing/src/lib/firebase/leads.ts`) flattens all thread documents into the prospect timeline with typed threads (`gu` vs `advisor`) and enforces **server-side visibility rules**: the owner (and staff) sees every thread; an advisor sees the Gu thread and colleagues' threads but **not their own** (that conversation already lives in their WhatsApp). Mongo `gu2.chats` mirrors advisor threads as `messages_from_<phone>` arrays, while `messagesv2` remains Gu-only LLM memory.

Consequences for R1:

- conversation reads through the operational gateway must model the **thread dimension** (which thread, which participants, which source) and preserve per-item provenance (`source`, author, `wamid`, delivery fields — see §15.7);
- visibility of advisor threads is itself a legacy product semantic to preserve/replace deliberately, not accidentally;
- the v0.2 rule stands, reinforced: **no single legacy store may be promoted to the universal conversation source of truth.**

---

# 11. Appointment creation and persistence

## 11.1 A requested appointment is not yet a confirmed or attended visit

**CURRENT — LEGACY SOURCE VERIFIED**

The appointment assistant explicitly tells the prospect that the requested visit is not necessarily confirmed until the advisor confirms it.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/tools/appointment_assistant_tools.py`

## 11.2 Appointment creation can involve Google Calendar before replicated persistence finishes

**CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK**

The creation flow can:

1. reserve billing credits where enabled;
2. create a Google Calendar event;
3. create/update legacy property-interest context;
4. write the appointment to Firestore;
5. write the appointment to Mongo;
6. confirm the billing operation when the appointment is accepted as created.

The Firestore and Mongo writes are not one transaction.

## 11.3 One successful appointment store is enough for the current flow to continue

**CURRENT — LEGACY SOURCE VERIFIED**

The code treats these outcomes differently:

```text
Firestore success + Mongo success → continue
Firestore success + Mongo failure → continue with warning
Firestore failure + Mongo success → continue with warning
Firestore failure + Mongo failure → cancel billing reservation / return failure
```

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/tools/appointment_assistant_tools.py`

Consequences:

- appointment existence is not globally atomic across legacy stores;
- a downstream consumer must be tolerant of partial replication;
- a read from one store cannot automatically prove the other store is synchronized;
- exact recovery/reconciliation semantics need a Gu OS integration contract.

## 11.4 Potential orphan external effect

**CURRENT — LEGACY RISK**

Because Google Calendar creation can precede successful persistence in both operational stores, a failure after Calendar success can leave an external effect requiring reconciliation/cleanup.

R1 must therefore preserve the AC-2 distinction:

```text
external request accepted
confirmed business effect
confirmed failure
unknown/partial outcome
```

and should reconcile before blindly retrying consequential effects.

---

# 12. Visit confirmation and attendance evidence

## 12.1 Appointment status and visit attendance are separate evidence dimensions

**CURRENT — LEGACY SOURCE VERIFIED**

Traditional Gu tracks appointment status/confirmation separately from later satisfaction/visit evidence.

A current tool can update an appointment to values including a confirmed/cancelled/reschedule path and notify the owner/prospect accordingly.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/agents/prospect/visit_tracker_assistant/nodes/tools.py`

## 12.2 Explicit post-visit evidence exists

**CURRENT — LEGACY SOURCE VERIFIED**

The post-appointment survey persists:

```text
property_was_visited = "Afirmativo" | "Negativo"
```

If negative, the flow also sets:

```text
appointment_qualification = "No hubo visita"
```

and can capture additional fields such as `want_to_acquire` and appointment qualification/comments.

This evidence is written to Mongo `appointments` and used in owner notification/follow-up.

## 12.3 R1 evidence mapping

**TARGET — S3 APPROVED / S1 / AC-7**

S3 (`specs/visit-progression-outcome-evidence-reconciliation.md`) is the governing target semantic contract for Visit progression, occurrence, no-show attribution and reconciliation. The table below maps source-verified legacy evidence into those target semantics; it does not promote legacy appointment statuses into canonical Gu OS Visit states.

| R1 concept / claim | Legacy evidence candidate | Required caution |
|---|---|---|
| `visit_requested` | appointment successfully created in an accepted operational source | partial-replication awareness required; target Gu OS may recognize a sufficiently concrete Visit request earlier than legacy persistence |
| `visit_scheduled` | date/time plus source-specific scheduling/confirmation evidence | do not equate mere request or Calendar-event existence with a sufficiently reliable arrangement |
| scheduling/readiness confirmation evidence | explicit advisor/prospect confirmation and related source evidence | confirmation is claim-specific evidence supporting scheduling/readiness; S3 does **not** define a mandatory canonical `visit_confirmed` progression milestone |
| `visit_attended` | explicit `property_was_visited = Afirmativo` or future equivalent admissible occurrence evidence | appointment existence/confirmation alone is insufficient; assigned-advisor physical presence is not required |
| Visit non-occurrence | explicit `property_was_visited = Negativo` / `appointment_qualification = "No hubo visita"` or future equivalent admissible evidence | establishes/supports non-occurrence, not automatically its cause or an actor-specific no-show |
| actor-specific no-show | additional admissible evidence that a particular expected actor failed to participate without sufficient prior cancellation/reschedule evidence | silence, missing survey fields and generic `Negativo` evidence are insufficient by themselves |
| unresolved Visit occurrence | no defensible occurrence/non-occurrence conclusion yet, or unresolved material conflict | preserve `unknown`/conflict; reconcile only when materially worthwhile and use durable Work only when the reconciliation needs durable execution semantics |

This mapping does not lock exact Case Fact keys, evidence enums, source-priority rules or persistence mechanics; those remain Technical Design concerns under the approved S3 behavior.

---

# 13. Legacy Deal semantics

## 13.1 Deal is created as property-specific context

**CURRENT — LEGACY SOURCE VERIFIED**

Traditional Gu creates Deal records around a Lead's relationship to a specific property. The Mongo representation is minimal and can include:

```text
lead_id
property_uid
asesor
origin
portal
```

and the Firestore representation is likewise tied to Lead + property context.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/db/mongo/deals.py`
- `UnggaMX/ungga-full/src/guv3/gu/tools/appointment_assistant_tools.py`
- related Firestore Deal helpers in `guv3`

## 13.2 Appointment creation can create/update Deal context

**CURRENT — LEGACY SOURCE VERIFIED**

A prospect asking to visit a specific property may cause a Legacy Deal to exist before any concrete Transaction Operations responsibility exists.

Therefore source verification closes the prior ambiguity:

```text
Legacy Deal
≠ Transaction Case
≠ "transaction started"
```

## 13.3 R1 rule

**TARGET — S1 / ADR-109 boundary**

Treat Legacy Deal as property-interest/commercial-context evidence. A Transaction Case should be created/associated only when the separate Transaction boundary predicate is satisfied by the appropriate domain/source evidence.

The resulting Opportunity↔Transaction Case association does not automatically close the Opportunity.

---

# 14. Property authority and search-serving topology

## 14.1 Firestore is the original Traditional Gu property record

**CURRENT — LEGACY SOURCE VERIFIED**

`guv3` documents that Mongo `property_data` is a copy maintained from Firestore and that Gu normally reads that Mongo representation for serving/search.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/db/firebase/properties.py`

## 14.2 Mongo property copy can be incomplete

**CURRENT — LEGACY SOURCE VERIFIED**

The source explicitly handles properties that exist/publish in Firestore but are absent from `property_data` because historical bulk imports did not always trigger the normal sync path. Gu therefore falls back to Firestore and maps the record into the serving shape expected by the rest of the runtime.

Consequences:

```text
Firestore properties = original/current Ungga property record
Mongo property_data = operational serving/search copy
Qdrant / embeddings = semantic retrieval/index layer
```

Do not make Mongo/Qdrant the canonical authority merely because Gu searches them first.

Upstream CRM authority may still be field/source-specific for imported inventory; AC-2's fact/source-aware model remains the governing target.

---

# 15. Outbound WhatsApp effect contract

## 15.1 Queue/API acceptance is not delivery evidence

**CURRENT — LEGACY SOURCE VERIFIED**

The Traditional Gu outbound notification seam can accept/enqueue a request before the provider call has completed. A successful caller response therefore cannot be interpreted as proof that the prospect received the message.

## 15.2 Worker obtains provider `wamid`

**CURRENT — LEGACY SOURCE VERIFIED**

The worker eventually calls Meta and extracts:

```text
r.data.messages[0].id
```

as the WhatsApp message ID (`waId` / `wamid`) and can persist it with the associated chat/template record.

Relevant source:

- `UnggaMX/ungga-full/src/workers/src/notificator/notificator.app.ts`
- `UnggaMX/ungga-full/src/workers/src/notificator/whatsapp/whatsapp.ts`
- `UnggaMX/ungga-full/src/workers/src/notificator/saveChat.ts`

## 15.3 Failure status is correlated later by provider ID

**CURRENT — LEGACY SOURCE VERIFIED**

`messageFilter` inspects Meta status webhooks for `failed` and forwards/persists failed-template information including provider message ID and error data.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/controllers/webhook.controller.ts`

The audited path does not establish a single end-to-end contract that returns provider outcome to the original enqueue caller.

## 15.4 Direct human-send route demonstrates why HTTP 200 is not enough

**CURRENT — LEGACY SOURCE VERIFIED**

The owner app documents a production behavior where Meta may accept a free-text POST with HTTP 200 + `wamid` while the 24-hour service window is closed and later report failure/discard via webhook. The route therefore calculates the window before send and persists the `wamid` so later failure callbacks can be correlated.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/whatsapp/send/route.ts`

This is strong evidence for AC-2's `unknown outcome` semantics.

## 15.5 Legacy retries are not sufficient Gu OS idempotency

**CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK**

The direct Gu sender has bounded retries with backoff, but the audited function does not expose a Gu OS-style logical idempotency key across attempts.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/core/notification_functions.py`

## 15.6 R1 target wrapper

**TARGET — AC-2 / ADR-107**

The preferred initial transport is still reuse/wrapping of a Traditional Gu send capability, but the Gu OS-facing contract must conceptually preserve:

```text
Case / Work Item / Attempt correlation
logical operation / idempotency identity
current authority + engagement-policy revalidation
request accepted vs provider accepted vs later failed/unknown
wamid/provider correlation
reconciliation before dangerous repeat
result/evidence persisted on Work Attempt
```

Exact transport endpoint and whether the wrapper calls queue/service/direct provider paths are **OPEN — TECHNICAL DESIGN**.

## 15.7 Delivery-status writeback into the conversation store

**REVALIDATED — 2026-08-31 (strengthened evidence path)**

`saveFailedTemplates.controller.ts` now propagates late provider failure callbacks into the **user-visible conversation store**: the conversation item matching the provider `wamid` in `leads/{lead_id}/wsp_messeges` is updated with `delivery_status: "failed"` and, when reported, `delivery_error_code`. Previously a Meta-rejected message could keep its "sent" appearance in the platform chat forever. The platform chat renders these delivery fields per item.

Retry semantics are now explicit and **asymmetric**:

- only **template** messages enter the `unsent_templates` retry queue (retry re-enqueues from `template_payload`);
- **free-text** messages (for example advisor sends from the platform) are marked failed but are **never queued for retry**.

The v0.2 contract stands unchanged and is reinforced: **HTTP/queue acceptance ≠ provider acceptance ≠ delivery ≠ final outcome.** For Gu OS, the Firestore `delivery_status`/`delivery_error_code` fields are an additional **delivery-evidence read source** for the future `send_prospect_message` reconciliation design; they do not replace the Work-attempt/idempotency wrapper required by §15.6.

---

# 16. Current authorization risks that Gu OS must not inherit

These findings are recorded because they affect the safety of R1 capability reuse. They are not a requirement to refactor all Traditional Gu authorization inside R1.

## 16.1 Appointment mutation helper can over-authorize `super-admin`

**CURRENT — LEGACY RISK**

In `ungga-landing`, appointment confirm/reschedule routes require a session and an activity permission. They then call `canActOnAppointment()`.

The helper returns allowed for a session role of `staff` **or `super-admin`** before checking the appointment's organization/Lead ownership.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/appointments/[id]/confirm/route.ts`
- `UnggaMX/ungga-landing/src/lib/appointments-access.ts`
- `UnggaMX/ungga-landing/src/lib/firebase/require-permission.ts`

Given the audited code path, a brokerage owner with a known foreign appointment `_id` may pass the ownership helper even when the appointment belongs to another organization.

R1 implication:

> **Gu OS capabilities must resolve organization authorization explicitly; `super-admin` must not mean cross-tenant authority.**

## 16.2 Human WhatsApp-send route needs organization ownership revalidation in the Gu OS wrapper

**CURRENT — LEGACY RISK**

The audited `/api/whatsapp/send` route reads a global `leads/{leadId}` and resolves the sending Gu number from the current session. In the inspected route, no explicit `ownerHasLead()`/organization ownership check is performed before the provider send.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/whatsapp/send/route.ts`

This is another reason to treat current owner-app permissions as a product-layer legacy gate, not a reusable Gu OS authority contract.

## 16.3 Scope response

R1 should:

- deny cross-organization reads/effects at the operational gateway/capability boundary;
- revalidate organization + actor/grant + Case/runtime/conversation authority before material effects;
- add cross-tenant negative tests;
- avoid requiring a broad legacy security cleanup unless a selected adapter cannot be safely bounded without one.

## 16.4 Revalidation status of these risks

**REVALIDATED — 2026-08-31**

The audited routes behind §16.1 (`appointments-access.ts` `super-admin` over-authorization) and §16.2 (`/api/whatsapp/send` without explicit organization-ownership revalidation) are **unchanged at the revalidation heads — both risks persist**.

**CURRENT — LEGACY RISK (new observation):** `ungga-landing/src/lib/beta-features.ts` currently ships `REDESIGN_REVIEW_OPEN_ACCESS = true` — a temporary switch, explicitly marked for removal, that makes **all routes and nav items visible regardless of role/beta/multi-user gating** while the platform redesign lasts. Route-level permission gates still apply where present, but module/nav gating is bypassed. This is additional evidence for the standing rule: **legacy product-layer visibility/access must not be inherited as Gu OS authority**; Gu OS capabilities resolve organization/actor authorization explicitly regardless of what the legacy UI exposes.

---

# 17. Billing caller contract relevant to R1

**CURRENT — LEGACY SOURCE VERIFIED**

The appointment flow uses the billing service through a reserve/confirm/cancel pattern:

```text
reserve operation
    ↓
perform appointment work
    ↓
confirm charge on accepted creation
or
cancel reservation on failure
```

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/services/billing_service.py`
- appointment assistant caller

This is enough for the current R1 source boundary. The billing backend's internal ledger/schema is **OUT OF R1 AUDIT SCOPE** because ADR-110 and later pricing/credits work own the broader economic/billing design.

Internal cost-to-serve remains separate from customer credits/billing.

---

# 18. Source-of-record / operational-role matrix after audit

R1 should use a fact/source-aware matrix rather than the statement "Traditional Gu's database is the source of truth."

| Concept / responsibility | Current source-verified legacy role | R1 target interpretation |
|---|---|---|
| Human authentication identity | Firebase Auth | external user identity mapped to Gu OS User/Membership |
| Principal/account user | Firestore `users/{uid}` | legacy principal external identity; not canonical Organization by itself |
| Legacy organization/membership | Firestore `users` + `users_sellers`, mixed `organization_id` representations | explicit Gu OS Organization + Membership + external bindings |
| Advisor assignment | Firestore Lead/user-lead representations + Mongo runtime mirror | organization-owned Opportunity with separate assignment/DRI |
| Legacy Lead | Firestore Lead record plus Mongo runtime context | operational source record; opaque external reference |
| Conversation runtime/context | richer Mongo `chats/messagesv2` plus Firestore conversation representation | bounded semantic conversation/event capability with provenance |
| Human conversation authority | Mongo Lead runtime `bypass_bot` + `last_owner_interaction_wba`, driven by observable human activity | generic ADR-107 conversation-authority state/policy |
| Appointment | replicated Firestore + Mongo operational record; partial success tolerated | source-aware external record + Gu OS evidence/reconciliation |
| Visit attendance | explicit post-visit survey fields in Mongo appointment | evidence-backed Gu OS progression fact/projection |
| Legacy Deal | Firestore/Mongo property-specific interest context | evidence only until Transaction boundary is satisfied |
| Property original/current Ungga record | Firestore `properties` | source-aware authoritative property read |
| Property serving/search | Mongo `property_data` + semantic index | search/read optimization, not authority by itself |
| WhatsApp provider effect | Meta request + `wamid` + later status webhooks | Work-backed correlated effect with unknown-outcome reconciliation |
| Advisor↔prospect off-thread conversation (revalidated 2026-08-31) | `waProbe` capture → Firestore `asesor_<phone>` threads + Mongo per-advisor arrays; excluded from `messagesv2` | best-effort evidence source with provenance; never load-bearing for Gu OS correctness; no authority effect without ADR-107-conformant policy |
| BigQuery mirrors | delayed analytical copies | analytics/evaluation only, not live operational authority |
| Customer credits/billing | current billing service/backend | separate contract from internal economic telemetry |

---

# 19. Consequences for the temporary Traditional Gu binding

The current manually configured legacy organization binding can remain for the lab/pilot, but its architectural meaning is now explicit.

Treat it as:

> **bootstrap external identity used to locate Traditional Gu/warehouse context, not authoritative Gu OS tenancy.**

Target evolution:

```text
Gu OS Organization
  └─ verified Traditional Gu binding
       ├─ source system
       ├─ legacy organization key
       ├─ principal Firebase UID
       ├─ Gu/WABA identity
       ├─ verification/provenance
       └─ migration status
```

The runtime should eventually derive source access from the **current authorized Gu OS Organization** plus its verified binding rather than trusting an arbitrary organization identifier supplied by a user/model.

Exact schema and verification workflow remain **OPEN — TECHNICAL DESIGN**.

---

# 20. Technical-Plan entry conclusions

The audit resolves the minimum source questions required by AC-1 through AC-4 and S1 sufficiently to enter Technical Planning.

The Technical Plan may now assume, subject to normal implementation-time revalidation of changed source code:

1. Firebase UID is the current Traditional Gu human external identity.
2. `organization_id` is a transitional principal/organization bridge with mixed representation; it is not canonical Gu OS Organization identity.
3. Legacy `lead_id` is an opaque operational-context external ID.
4. Organization ownership and advisor assignment are distinct.
5. Observable human activity can drive conversation takeover; current timeout/resume numbers are implementation policy, not architecture.
6. Mongo/Firestore conversation representations are brownfield sources/projections, not one universal truth.
7. appointment creation is replicated and can partially succeed; reconciliation is required for strong Gu OS semantics.
8. visit attendance requires explicit evidence; missing evidence remains unknown.
9. Legacy Deal does not establish Transaction start.
10. Firestore is the original/current Traditional Gu property record while Mongo/Qdrant are serving/search layers.
11. Traditional Gu outbound transport exposes useful provider IDs and later failure evidence but needs a Gu OS command/effect wrapper.
12. selected legacy authorization paths are insufficient as organization-scoped Gu OS authority checks.
13. BigQuery remains analytical and must not govern live R1 decisions.

Added by the 2026-08-31 revalidation:

14. The Firestore conversation store is multi-thread per Lead (Gu thread(s) + `asesor_<phone>` advisor threads with `source: "advisor_wa"` and server-side visibility rules); gateway conversation reads must model the thread dimension.
15. `advisor_wa` captures are evidence of off-thread human activity, not a conversation-authority signal; they do not set `bypass_bot` and must not automatically suppress Gu.
16. Provider failure callbacks write `delivery_status`/`delivery_error_code` onto the Firestore conversation item by `wamid` — an additional delivery-evidence read source for send reconciliation; only template messages are retried by the legacy queue.
17. `waProbe` is pilot/spike-grade (stateful per-advisor sockets, whitelist-gated, consent-versioned); Gu OS may consume its output as evidence but must not depend on it for correctness.

Remaining work is no longer an **architecture source-audit blocker**. It is downstream **Technical Design / adapter implementation / verification work**.

---

# 21. Open Technical Design questions

This audit deliberately leaves the following unresolved for the Technical Plan/implementation specs:

- exact operational-gateway service/process boundary;
- exact external-identity mapping schema and migration/backfill strategy;
- event envelope, source-event deduplication key and inbox/outbox mechanics;
- how Gu OS correlates legacy `wamid`/appointment IDs/provider IDs to Work Item Attempts;
- whether a selected Traditional Gu outbound seam is wrapped as-is or narrowed behind a new internal endpoint;
- exact organization authorization lookup before each legacy capability;
- appointment read precedence/reconciliation when Firestore and Mongo disagree;
- write compensation/reconciliation for Google Calendar or other partial external effects;
- exact visit Fact keys and source-admissibility rules;
- exact source/event freshness SLAs;
- exact lab bootstrap-binding migration into canonical Organization external bindings;
- observability/alerting for authorization conflicts, source drift and reconciliation failures.

Added by the 2026-08-31 revalidation:

- admissibility rules for `advisor_wa` evidence (which claims advisor-thread messages may support in S2/S3 semantics, and with what confirmation requirements);
- whether/how the operational gateway exposes advisor threads (thread dimension, visibility semantics, freshness) versus Gu-thread-only reads for the first slices;
- how the Firestore `delivery_status`/`delivery_error_code` writeback participates in the `send_prospect_message` reconciliation contract alongside `wamid` correlation and failure webhooks.

These questions should not reopen the accepted product/architecture semantics unless implementation evidence exposes a genuine contradiction.

---

# 22. Audit completion statement

> **R1's minimum Traditional Gu production-source audit is complete for Architecture Analysis and Technical-Plan entry. The audit source-verifies identity/organization bridging, Legacy Lead composition, assignment, WhatsApp event/takeover/resume behavior, appointment persistence, visit evidence, Legacy Deal semantics, property source/search roles, outbound provider correlation and relevant authorization risks. These findings refine source status and brownfield adapter requirements; they do not reopen AC-1 through AC-10 or change the approved S1 behavioral contract. The approved S3 Visit Spec now governs target Visit progression, occurrence, no-show attribution and reconciliation semantics while this audit remains the source-verified record of legacy behavior.**

v0.3 extends this statement with the targeted drift revalidation of 2026-08-31 (§23): the revalidation confirms the audited contracts at the new branch heads, records the additive changes described in §4.5, §5.4, §9.1, §10.1, §15.7 and §16.4, and does not alter the completion status above.

---

# 23. Targeted drift revalidation — 2026-08-31

## 23.1 Method and scope

Performed from the Gu OS side as a **targeted R1-relevant drift revalidation**, not a full new audit:

1. current remote heads resolved independently (`git ls-remote`);
2. both repositories partial-cloned; the v0.2 audit pins verified as **ancestors** of the current heads (fast-forward history, no rewrites);
3. full `diff --stat` between pin and head for each repo;
4. targeted diffs/reads on every changed file relevant to the §3 question set plus all newly added code;
5. audited files with no diff were classified STILL VALID without re-reading their v0.2 content.

## 23.2 Pins and heads

| Repo / branch | v0.2 audit pin (2026-08-28) | Revalidation head (2026-08-31) | Commits |
|---|---|---|---|
| `UnggaMX/ungga-full` @ `gcp/main` | `ae9f107a1d53c8bc25a327bece5701aac192ac49` | `c88792530152c0c91a1e74c59e26a416103e68ff` | 6 |
| `UnggaMX/ungga-landing` @ `main` | `77e3dc7fb562f9b249a5d5ec7f8f159e6f2ccdfa` | `82cab192bec2f23a0709c57ce06204d21007a179` | 24 |

## 23.3 Contract classification

| Audited contract (v0.2) | Classification |
|---|---|
| §4 Firebase Auth identity; `organization_id` principal bridge; claims unreliable | STILL VALID (reinforced by `ownerUidOf` / acting-context — §4.5) |
| §5 `lead_id` composition; multi-representation Lead creation | STILL VALID (untouched); lead-origin taxonomy clarified — §5.4 |
| §6 organization ownership vs sticky assignment (`guard-lead-one`) | STILL VALID (untouched) |
| §7 WhatsApp inbound identity, provider IDs, queue-based webhook | STILL VALID (untouched) |
| §8 same-thread takeover (`bypass_bot` + `last_owner_interaction_wba`), >5-min resume, billing gate | STILL VALID (untouched) |
| §9 owner-app send convergence (`/api/whatsapp/send`, `wamid`, webhook synthesis) | STILL VALID (route untouched) |
| §10 conversation persistence multi-store | MATERIAL CHANGE (additive) — multi-thread per Lead; §10.1 |
| §11 appointment creation partial persistence / Calendar orphan risk | STILL VALID (untouched) |
| §12 visit confirmation and attendance evidence | STILL VALID (untouched) |
| §13 Legacy Deal semantics | STILL VALID (untouched) |
| §14 property Firestore-original / Mongo-serving / Qdrant topology | STILL VALID; Gu now shares the public-portal ficha tagged `src=gu-compartido` (link behavior refined) |
| §15 outbound provider correlation; acceptance ≠ delivery; legacy retries insufficient | VALID WITH CLARIFICATION (strengthened) — delivery-status writeback and template-only retry; §15.7 |
| §16 authorization risks | STILL VALID — risks persist; new temporary open-access observation; §16.4 |
| §17 billing caller contract | STILL VALID (untouched) |
| — Advisor-linked WhatsApp capture (`waProbe`) | NEW RELEVANT SEAM — §9.1 |
| — Acting context / staff impersonation / field-scoped org permission | VALID WITH CLARIFICATION — §4.5 |

## 23.4 Architectural conclusion

> **The observed drift does NOT contradict S1–S4, does NOT reopen AC-1 through AC-10, and does NOT reopen ADR-106 through ADR-110.** The advisor-linked WhatsApp pilot in fact supports accepted direction: it begins to reduce the off-thread evidence gap ADR-107 already anticipates, and it supplies a source-verified mapping for the advisor human-WhatsApp endpoint identity dimension of ADR-106. The multi-thread conversation store and delivery-status writeback **strengthen the need for the bounded operational gateway** (business-semantic, thread-aware, provenance-preserving reads rather than raw store access) and add useful **evidence, identity and delivery seams** for Technical Design. `advisor_wa` capture remains evidence, never authority; `waProbe` remains best-effort and must not become load-bearing for Gu OS correctness.

---

# 24. Contract-precision revalidation — 2026-09-17

## 24.1 Method, scope and why this section exists

This is the third pass over the Traditional Gu sources, and it has a narrower purpose than either predecessor. §1–§22 established **what the legacy system is**; §23 confirmed those contracts had not drifted. §24 establishes **the specific mechanics C1, C2 and C6 must be implemented against**, because a cross-repo contract that names the wrong writer, the wrong identifier or a durability guarantee the source cannot provide fails at integration rather than at review.

Method:

1. current heads resolved through the GitHub API; the §23 revalidation heads confirmed as **ancestors** of the current heads for both repositories (`compare` reports `ahead` with no rewrite), so history is fast-forward and §23's classifications stand;
2. read-only inspection through the authorized API path — recursive trees plus per-file reads pinned to the named branches — and code search used only as a pointer, then confirmed on the pinned branch;
3. scope limited to four question sets: every writer that mutates lead assignment, every writer that mutates appointments, the message-ingress and authority seams, and the existing durability/transaction primitives;
4. `UnggaMX/ungga-full` `gcp/stage` and `gcp/main` verified **identical** at inspection time (`compare` returns zero commits and zero files in both directions), which is why search results indexed on the default branch are exact for `gcp/main`.

| Repo / branch | §23 head (2026-08-31) | This head (2026-09-17) | Commits since | History |
|---|---|---|---|---|
| `UnggaMX/ungga-full` @ `gcp/main` | `c8879253` | `3fdb16ca` | 48 | fast-forward |
| `UnggaMX/ungga-landing` @ `main` | `82cab192` | `ce60cb22` | 99 | fast-forward |

**Everything in §24 is observed current-state legacy reality, and the precedence statements are explicitly transitional.** None of it is a Gu OS architecture invariant, and none of it licenses preserving duplicated legacy persistence permanently. Gu OS may eventually own some of these capabilities; when it does, the precedence recorded here is retired, not reinterpreted.

## 24.2 Transitional source precedence

**Traditional Gu appointment authority (current): Mongo `appointments` (the `gu2` runtime database) is the primary operational representation. The Firestore `deals/{deal}/appointments` representation is a secondary/replicated representation. Divergence between them remains observable and is never silently reconciled. This precedence is transitional and may change when appointment ownership migrates to Gu OS.**

§24.3 gives the evidence, and it is stronger than "primary": the majority of appointment writers never touch Firestore at all.

**Legacy Lead: for substantive lead information Mongo is currently the more complete and preferred representation where equivalent information exists in both stores. Mongo is NOT a superset of Firestore.** Firestore remains necessary for legacy operational semantics that have no Mongo equivalent — organization containment, advisor relationships, assignment state and conversation structures. The real source model is **asymmetric and capability-specific**, and the tempting simplification — *lead → Mongo, appointment → Mongo, everything else → Firestore* — is wrong in both directions. §24.4 quantifies the asymmetry.

**Analytical mirrors.** The BigQuery mirror deliberately draws from seven source datasets — Firestore `users`, Gu numbers, `properties`, `deals` and `messages`; Mongo `leads` and `appointments`. This is **evidence of current practical source preference and nothing more.** §18 and §20 item 13 already bind it: BigQuery mirrors are delayed analytical copies, for analytics and evaluation only, never live operational authority. **The analytical selection must not become a platform invariant** — it is a reporting convenience, it lags, and it was chosen for query shape rather than for authority. (Within `ungga-landing`, BigQuery is used only against Google's own `billing_export` dataset for GCP cost reporting; the business-data mirror is configured outside both application repositories. `architecture-analysis.md` §4.8 enumerates the mirrored tables and defers operational truth to this audit.)

## 24.3 Appointments: fourteen writers, nine of them Mongo-only

**Mongo is the only defensible source of appointment state, because the advisor-facing lifecycle never reaches Firestore.** Confirmation, advisor-side reschedule, reminder outcomes and the post-visit survey are all Mongo-only writers. Nine of the fourteen writers found touch Mongo alone; **none touches Firestore alone** for the appointment document itself.

| Writer family | Stores | Logical operation |
|---|---|---|
| Prospect-conversation appointment generator | Calendar + Firestore + Mongo | creation |
| Standby-graph generator (after advisor takeover) | Calendar + Firestore + Mongo | creation |
| Prospect-side update | Calendar + Mongo, Firestore **best-effort** | reschedule |
| Prospect-side cancel | Firestore **delete** + Mongo tombstone | cancellation |
| Advisor confirm (agent tool, and the `ts-services` route) | Mongo only | confirmation |
| Advisor reschedule | Mongo only | reschedule |
| Visit-tracker status / survey writers | Mongo only | status transition, post-visit outcome |
| Owner-phone sync (TS and Python twins) | Mongo only | backfill |
| `jobFilter` reminder writers | Mongo only | reminder bookkeeping |

Four mechanics matter for the contracts:

**Persistence is not atomic, and the code does not try to make it so.** No writer in either language opens a transaction, session or batch for appointment data; every dual-store write is sequential best-effort. The creation path performs Calendar, then Firestore, then Mongo, and checks the two failure flags **after both writes** — so a Firestore failure still leaves the Mongo insert committed and the Calendar event created. The reschedule path is more asymmetric still: its Firestore update sits inside a swallowed `try/except` and a missing Firestore document is a logged warning, not an error, while Mongo is always attempted. This confirms §11.2 and §11.3 and sharpens them: **Firestore is genuinely optional on the update paths, not merely occasionally unlucky.**

**The exact store ordering per path — verified 2026-09-17 against `src/guv3/gu/agents/prospect/appointment_assistant/nodes/tools.py` @ `gcp/main`, because the C1 event contract turns out to depend on it.** Whether Mongo is written *last* decides whether the secondary outcomes are already known when the canonical mutation commits:

| Path | Ordering | Mongo last? |
|---|---|---|
| `appointment_generator` (creation) | Calendar → Firestore → Mongo | **yes** |
| `cancel_appointment` | Firestore appointment delete → Firestore `propertiesShown` delete → Calendar delete → Mongo tombstone | **yes** |
| `update_appointment` (prospect reschedule) | Firestore → **Mongo** → Calendar → **Mongo again** | **no** |
| The nine Mongo-only writers | Mongo alone | trivially |

So **thirteen of the fourteen writers put the canonical Mongo write last or write nothing else**, and exactly one — the prospect-side reschedule — commits Mongo while its Calendar outcome is still unknown. That path then issues a *second* `update_one` on the appointment after the Calendar call, to set `rescheduled`, `owner_notified` and the status resets. **The logical reschedule is therefore not one Mongo write but two, with a Calendar effect between them**, which is why [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) §7 cannot treat "the canonical mutation committed" as "the event is complete", and why that second write is where it lands finalization.

**A related latent defect on that same path, recorded as observation rather than repaired here.** `update_appointment` refreshes `args["google_event_id"]` from the Calendar response *after* both Mongo updates have been composed, and neither update writes that field. If the Calendar API ever returned a different event id on update, nothing would persist it and Mongo would silently keep the stale one. Today the call patches the existing event in place and normally returns the same id, so this is a latent rather than active fault — but it is the same orphan-Calendar family as §11.4 and belongs to Traditional Gu, not to a Gu OS contract.

**Cancellation makes the two stores describe different sets of appointments.** The Firestore document is deleted; Mongo retains a tombstone. Any read contract must therefore treat presence/absence per store as information, not as an error to be smoothed over.

**`google_event_id` is written to BOTH stores, not to Firestore alone.** The Mongo insert carries it in the same field set as the Firestore write. This **corrects a Gu OS-side error rather than the audit**: the C6 appointment type asserted the field was "present only in the Firestore replica" and the Mongo normalizer hard-coded it to null, which meant the orphan-Calendar signal of §11.4 was invisible on exactly the store that survives when Firestore persistence fails. Repaired 2026-09-17 with fixture and selftest coverage. Firestore's genuine exclusives are different and narrower: the `propertiesShown.cita` back-pointer, and the owner-level Calendar connection state on the user document, which has no Mongo counterpart.

**The appointment business key is stable across reschedule, but is not present on all historical Firestore records.** Every writer queries on a client-minted `appointment_id` UUID and updates in place — a reschedule never creates a new record, which is why a `rescheduled` flag exists at all. The Mongo `_id` and the Firestore auto-id are incidental. The nuance for C6: the SL-1 recording found `appointment_id` on only 63 of 126 sampled Firestore appointment documents, which is why the Gu OS gateway pairs the two stores on property + date + hour rather than on the business key. **So the business key is reliable for events emitted going forward (C1) but not for pairing historical records (C6).**

## 24.4 Assignment: thirteen writers, no common seam, and a partial Mongo mirror

§6.1 recorded `/guard-lead-one` as the current on-demand assignment path and §6.2 recorded the batch path as deprecated. Both stand. What §24 adds is that **`/guard-lead-one` is not the sole assignment writer** — it is one of thirteen, spread across two runtimes.

The writer families, by the policy they implement: guardia/time-based (on-demand, plus the deprecated batch path); carrusel; manual carrusel; property-driven and property-carrusel; explicit/manual; a backfill that parks unassigned leads on the principal; an offboarding cascade that reassigns an advisor's leads when they are removed; lead creation, which initializes assignment state; a lead re-keying job that carries assignment across new documents; and a Python tool path that writes the Mongo owner fields directly.

**The Firestore/Mongo asymmetry is real, and it is writer-dependent rather than uniform.** Firestore carries the operational assignment metadata: `assigned`, `assignedTo`, `assigned_at`, `assignment_type`, `assignation_type`, `new_assignment`. Writers update one or more of the global `leads/{lead}` document, the principal's `users/{owner}/user_leads/{lead}`, and the advisor's copied `user_leads` representation. The corresponding Mongo `users` projection carries `owner_phone_number`, `owner_name`, `owner_last_name` — and **some writers also mirror `assigned`/`assignedTo` there while others do not.** So Mongo's assignment mirror is partial and stale by construction, in ways that are specific rather than incidental:

- several writers update only `owner_phone_number` in Mongo, leaving the name and assignment fields stale;
- three writers read a source field for the advisor's surname that **no writer in the repository produces**, so that Mongo field is always empty on those paths;
- the offboarding cascade changes the Firestore `assignedTo` of every affected lead and **touches no Mongo at all**, leaving the removed advisor's contact details in the Mongo projection;
- a brand-new lead has **no** `assigned`/`assignedTo` keys in Mongo until an assignment writer runs.

**Consequences for the contracts, all of which follow from the above rather than from preference:** C6 lead context may **compose** Mongo substantive lead data with Firestore operational assignment and ownership metadata, and no read contract may discard Firestore assignment state merely because Mongo is the preferred substantive source. (Today the Gu OS `legacy_lead_get_context` capability reads Firestore only, so this composition is an **addition** to the C6 contract, not a preservation of current behavior.) And C1 `assignment_change` **must originate from actual assignment mutation semantics at the writers**, never be inferred from Mongo `users` changes, from the Mongo owner name or phone, or from a single role literal.

**The previous assignee is usually not reconstructable at mutation time.** Only three writers read the prior value: the on-demand guard path reads it as a sticky gate, the property-by-assignment path refuses when the lead is already assigned, and the offboarding cascade uses the previous assignee **as its query key**. The remaining writers either filter on `assigned == false` — so "no previous assignee" is true by construction — or overwrite without looking. **There is no assignment history anywhere**: no history collection, no per-lead subcollection, and the only per-mutation timestamps are three differently-named fields, each overwritten in place. This is why [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) preserves absence instead of fabricating a previous assignee, and why it needs a fourth operation value for "an assignee was set without the prior state being established".

**"Carrusel" is round-robin with legacy eligibility behavior, and there are two incompatible implementations of it.** One is round-robin over an explicit per-advisor `order` integer with a persisted counter on the principal document, wrap-around, an owner-level kill switch, and skipping of advisors whose root status is not active. The other, under the *same* configured strategy label, ranks by workload and cycles advisors through a `cold` flag until the cohort is exhausted and resets. They share no state. Neither is pure mathematical round-robin, and a contract that assumed a generic algorithm would be wrong about both.

**Two vocabularies exist for the configured strategy field, written by two different repositories.** The `ungga-full` selector writes one set of values; `ungga-landing`'s assignment-type endpoint allows a different, overlapping set, including a value the `ungga-full` selector can never produce but one writer requires. **C1 must therefore carry the legacy policy value as provenance rather than as a closed enumeration**, which is what ADR-112 does.

**There is no shared emission seam today.** Each writer open-codes its own Firestore write set and its own Mongo call with a different field list. There is no shared assignment service, no Firestore trigger on leads, no Mongo change stream, and no Pub/Sub publish on the assignment path. Notably, a helper that would have propagated advisor changes to appointments exists in both runtimes with **every call site commented out**, and an internal design note documents that propagation as implemented — that note is stale, and it also lists only four of the thirteen writers.

## 24.5 Organization, advisor and role semantics

§4.2 recorded the organization/principal bridge and §4.3 recorded that legacy claims are not sufficient authorization. Both stand. §24 adds the role vocabulary in full, because C1 and C2 must not propagate it.

Treat assignment as **three separate concerns**, never collapsed: organization membership and advisor eligibility; the legacy policy that chooses an advisor; and the resulting durable lead→advisor assignment. Traditional Gu owns the first two in this phase; Gu OS consumes only the third, as a semantic event.

Organizations contain sub-users/advisors linked to an owning principal through root `users` documents, an `organization_id` reference, a `users_sellers` projection under the principal, and related advisor projections. `organization_id` is inconsistently typed across writers — a document reference on most paths, a plain string on at least one — which §4.2 already flagged as drift.

**The role vocabulary is internally inconsistent, and no single literal may become a Gu OS invariant.** The literals present in the code are at least `seller`, `vendedor`, `admin`, `super-admin` and `staff`, plus a **second, independent** role axis with its own values. The invitation path — the normal way an advisor is added — writes one literal; the CRM import paths write another for the same concept. The only eligibility predicate that actually reads roles compares against `admin` and `super-admin`, and **no writer ever produces `admin`**, while **nothing anywhere reads the two advisor literals as a gate**. The sharpest counterexample to keying anything on a literal: the offboarding cascade sets a *removed* advisor's role to `super-admin` with an inactive status and a self-referencing organization, so **`super-admin` does not reliably identify the organization principal** even though that is its usual meaning.

**Role must therefore be normalized semantically at the integration boundary**, and `role_user == vendedor` is not the criterion for advisor eligibility. The actual predicates, where they exist, combine membership in the principal's advisor projection, a valid ordering ordinal, an active root-document status, an owner-level enable switch and — on one path — a role-plus-preference exclusion. Status itself is written with inconsistent capitalization and works only because consumers lowercase before comparing. Several paths apply **no** eligibility predicate at all and assign to whatever user the caller names. Two structural traps worth recording: an invited advisor starts in a pending status and is invisible to every automatic policy until something activates them, and an advisor added through the admin path gets no ordering ordinal and is permanently invisible to the ordinal-based policies.

## 24.6 Message ingress, authority seam and delivery status

§7.1 recorded that the provider message ID is available at ingress and §7.2 that routing is queue-based with early acknowledgement. Both stand, with three additions.

**The provider id is available at ingress but not persisted there.** The ingress component extracts, filters and publishes; it writes to no datastore. Persistence happens downstream, and the id appears under **four different field names** across the stores, plus one place it is absent entirely: the Firestore conversation entries written by Gu itself carry no provider id. This has two direct consequences. For C6, per-message `wamid` is null for Gu-written messages and present mainly on entries written by the owner-app and off-thread capture paths — and the failure-writeback path that matches on it can therefore only mark the entries that carry it. For C1, it is why [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) §2 records a poll-versus-webhook duplication hazard for the overlap window of the SL-5 cutover.

**Inbound webhook authenticity is effectively unverified today.** Only the one-time subscription handshake is enforced. An HMAC verifier exists in the ingress component but **the line that installs it is commented out**; as written it implements SHA-1 against the legacy provider header, and it returns silently when the header is absent, so an unsigned request would pass. The body parser is plain JSON with no verify callback, and **no raw-body-preserving middleware exists anywhere in the repository.** The Python ingress has the same gap. This is recorded for two reasons: [ADR-111](../../../adr/ADR-111-legacy-service-auth-v1.md)'s body-hash-over-raw-bytes rule requires new middleware rather than an existing facility, and the gap is a standing finding in its own right that TD-13 does not fix (TD-13 governs the Gu OS boundary, not Meta's webhook).

**Same-thread takeover and off-thread capture remain sharply distinct**, confirming §8 and §9.1.1. Same-thread advisor activity arrives as a provider echo, sets `bypass_bot` with the interaction timestamp, and suppresses Gu for a **five-minute** window cleared by a scheduled sweep — which also confirms §8.3's point that any user-facing "about six minutes" is an approximation. The off-thread capture writes to its own thread document and its own Mongo array and **contains no occurrence of the bypass field at all**: it is an observation channel with zero control-flow effect. There is additionally a second, coarser `bypass_bot` on the Gu-number record, a per-number kill switch distinct from the per-lead takeover flag; conflating the two would produce a contract that pauses an entire number when it meant to yield one conversation.

**The seam where Gu decides whether to act** is the per-lead branch immediately before the agent is invoked, after a provider-id dedup guard. Available in scope at that point: the full Mongo lead runtime document, the Gu-number record, the ingress envelope with the provider id and the synthetic-flag set, and the composite lead identity. **There is no organization entity in scope** — the tenant boundary is reachable only as the principal's uid via the lead, or via the bot number. This is the C2 insertion point, and that missing organization entity is why C2's request must carry refs the resolver maps rather than an organization claim.

**Per-message delivery status is thinner than the C6 type implies.** Message records carry no delivery-status field. Failures are written back into the Firestore conversation entry as a status and an error code, per §15.7. But `sent`/`delivered`/`read` transitions exist **only** in a separate Mongo billing-observation collection keyed by provider id, which no conversational logic reads. So of the C6 delivery-status vocabulary, `failed` is available from the allowlisted conversation path and `delivered`/`read` are **not obtainable from it at all** — a C6 endpoint that must expose them has to read the billing collection, and that is a deliberate scope decision rather than a detail.

## 24.7 Existing durability and transaction primitives

**There is no durable integration-event, outbox or event-log mechanism anywhere in `ungga-full`.** No collection of pending events with delivery state and attempts. This is a genuinely new primitive for C1, not an adaptation of an existing one.

The closest patterns the codebase already trusts, in descending order of durability: **Pub/Sub with dead-letter topics**, which is the load-bearing retry mechanism; a narrow **template-retry queue** in Mongo, upserted by provider id, which is the one real application-level retry queue and the idiom a new outbox should feel like; and a **processed-message ledger** keyed by provider id, which is the existing precedent for at-ingress idempotency.

Two caveats make Pub/Sub insufficient on its own, and both are load-bearing for [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) §6: the two main consumers **acknowledge the message before performing the work** (they spawn a thread and return), so redelivery does not cover application failure after the ack; and one of the two dead-letter topics has **no subscription**, so messages exhausting delivery there are lost without trace. **Pub/Sub alone therefore does not eliminate the mutation-to-publish window** — it is a delivery leg, usable after a durable record exists.

**Transaction capability differs by store, and this is the constraint that shapes C1's atomicity.**

| Store | Multi-document transaction | Evidence |
|---|---|---|
| Firestore | **Available and demonstrated** | a working `runTransaction` read-then-conditional-write lease pattern exists in the repository |
| Mongo (TypeScript) | **Not possible** | all TS access goes through the Atlas **Data API** over HTTP, which is stateless and cannot join a session |
| Mongo (Python) | **Not demonstrated** | PyMongo could open a session, but no session or transaction usage exists anywhere in the repository |

So a business-write-plus-event-write **can** be made atomic on the Firestore-oriented assignment paths and **cannot** be, today, on the Mongo-oriented appointment paths. ADR-112 §7 states that asymmetry rather than averaging it into a single claim.

## 24.8 `ungga-landing` is a privileged writer, not a front end

**This is the finding that most changes the shape of the cross-repo work, and it corrects an assumption rather than the audit.** §9 already recorded that `ungga-landing` sends WhatsApp messages and synthesizes a webhook, and §4.1/§16 recorded it as the authentication and authorization surface. §24 establishes the wider scope: it is a server-rendered application with roughly 127 API route handlers and **privileged direct access to both systems of record** — the Firestore Admin SDK, so security rules do not apply to it, and a direct Mongo client.

It directly mutates state all three contracts care about:

- **the organization's lead-assignment policy** — the configured strategy, the guardia roster and the carrusel ordering, written straight to the principal's Firestore documents;
- **property→advisor assignment**, which *is* lead routing under the property-driven strategy;
- **appointments** — confirmation and reschedule, written directly to the canonical Mongo collection;
- **bot-reply authority** — the pause flags on the Gu-number record in both stores, per-lead blacklisting, and `bypass_bot` stamped onto the conversation turn it writes;
- **manual lead assignment**, by permission-gated proxy to the `ungga-full` assignment endpoint.

It does **not** create leads; lead origination from the public portal is a WhatsApp deep link, and the backend creates the lead. It has **no** event-emission infrastructure of any kind.

Two incidental observations, recorded because they bear on §16's standing authorization risks rather than on the contracts: several internal admin routes mutate business state, and staff impersonation permits writes to everything except billing paths, despite an in-code comment asserting it is read-only. **Neither is in scope for C1/C2/C6 and neither is repaired by them**; they belong to the §16 risk set.

## 24.9 Deployment and secret topology

Ten separately deployed runtimes in `ungga-full` (nine Cloud Run services plus one Cloud Function), each with its own build and workflow; `ungga-landing` deploys separately on Firebase App Hosting. The ingress component runs in a different region from everything else.

Secrets reach the three estates by **three different mechanisms**: `ungga-full` resolves them at build time from a secrets manager into an environment file and ships them as Cloud Run environment variables, with service-account JSON written into the build context — so **secrets are baked into revisions and rotation requires a redeploy**; `ungga-landing` maps environment variables to Secret Manager references; Gu OS uses CI environment secrets plus encrypted database rows for the legacy read credentials. This is recorded for one reason only: [ADR-111](../../../adr/ADR-111-legacy-service-auth-v1.md) requires two key ids to be valid concurrently, and build-time baking is why overlapping validity is a necessity rather than a convenience.

**No secret values were read or recorded.** Only mechanisms and variable names.

## 24.10 Classification and conclusion

| Audited contract | Classification after §24 |
|---|---|
| §6 organization ownership vs sticky assignment | **VALID WITH MATERIAL EXTENSION** — `/guard-lead-one` is current and sticky, but is one of thirteen writers; no common emission seam; no assignment history; previous assignee usually unreconstructable (§24.4) |
| §7 inbound identity, provider IDs, queue routing | **VALID WITH CLARIFICATION** — the provider id is available at ingress but not persisted there, and appears under four field names, absent from Gu-written Firestore conversation entries (§24.6) |
| §8 / §9.1.1 same-thread takeover vs off-thread evidence | **STILL VALID (reinforced)** — five-minute window confirmed; off-thread capture contains no bypass write at all; a second per-number kill switch distinguished (§24.6) |
| §10.1 multi-thread conversation persistence | **STILL VALID** — thread distinction confirmed; delivery-status availability narrowed (§24.6) |
| §11.2 / §11.3 appointment partial persistence, Calendar orphan risk | **STILL VALID (sharpened)** — Mongo primary, nine of fourteen writers Mongo-only, Firestore optional on update paths, cancellation asymmetric; `google_event_id` in **both** stores (§24.3) |
| §14 property Firestore-original / Mongo-serving | **STILL VALID** — untouched by this pass |
| §15.7 delivery-status writeback | **VALID WITH CLARIFICATION** — failure writeback confirmed; `delivered`/`read` exist only in a billing-observation collection (§24.6) |
| §16 authorization risks | **STILL VALID; risk set extended** — admin-surface mutations and write-capable staff impersonation (§24.8) |
| §18 source-of-record matrix | **VALID WITH TRANSITIONAL PRECEDENCE ADDED** — appointment and lead precedence stated explicitly; BigQuery reaffirmed analytical-only (§24.2) |
| §21 open question: appointment read precedence when stores disagree | **STILL OPEN** — narrowed by §24.3 but not answered; C1/C6 keep divergence visible rather than resolving it |
| — Durable publication primitives | **NEW FINDING** — no outbox exists; Pub/Sub acks before work; atomicity available in Firestore, not in Mongo (§24.7) |
| — `ungga-landing` scope | **NEW FINDING** — a privileged writer of assignment policy, appointments and bot authority (§24.8) |

> **§24 does not contradict S1–S4, does not reopen AC-1 through AC-10, and does not reopen ADR-106 through ADR-110.** It contradicts exactly one thing, and that thing is on the Gu OS side: the C6 appointment contract's claim that Calendar effect evidence is Firestore-only, now repaired. Everything else is additive precision. Three findings change what the cross-repo contracts can promise rather than what they mean — the absence of any durable publication primitive, the store-dependent limit on atomicity, and the absence of a common assignment emission seam — and all three are carried into [ADR-111](../../../adr/ADR-111-legacy-service-auth-v1.md) and [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) as stated constraints rather than smoothed over. **The precedence recorded in §24.2 is transitional throughout: it describes where truth currently lives in a system Gu OS is migrating from, and it must not be read as a durable Gu OS invariant.**
