# ADR-112 — Cross-repo integration events: stable event identity and durable publication

**Status:** **Accepted direction** — **ratified as rev 4 by the Accountable on 2026-09-17**. This is now the governing C1 cross-repo integration-event contract. Implementation has not started. **rev 5 (2026-09-19) is a repair made under this record's own reopening clause**, on concrete contradictions that a read-only reconnaissance of `ungga-full` @ `gcp/main` `3fdb16ca` and `ungga-landing` @ `main` `bbcb58c6` exposed between the ratified text and current source, plus the Accountable's accepted repair decisions **D1–D4**. The architecture direction is unchanged and was preserved deliberately (§12 below). **One part of rev 5 is not self-standing: the top-level `legacy_owner_ref` of §3 depends on [ADR-111](ADR-111-legacy-service-auth-v1.md) §6.3b, which is PROPOSED and awaits a separate security review and explicit re-ratification.** Until that lands, the envelope field is specified but **not authorized for implementation**, and no C1 receiver may be built against it.
**Date:** 2026-09-17
**Ratification:** Ratified as written at rev 4, R1 [`slice-plan.md`](../product/roadmap-increments/r1-relationship-operations-v1/slice-plan.md) §8 **Q15**. Accepted in scope: entity identity separated from event identity, provider message ids reused where they exist, stable minted `event_id`s for internal mutations, durable producer-side publication, the bounded `integration_events` outbox, Firestore-transaction durability for assignment, appointment-document durability for appointments, **the §7A durability boundary separated from the §7B delivery-readiness boundary**, §7C recovery that records unresolved outcomes as `unknown` with `finalized_by` provenance, the §7C-bis single-winner finalization transition, **§7E's removal of any sequence counter**, **§7F's explicit absence of any delivery-order guarantee**, at-least-once delivery, coverage treated separately from durability, and the normalized `assignment_change` / `appointment_change` semantics. **Two obligations this places on Gu OS consumers** (SL-5, SL-8, SL-10): treat `unknown` as a third outcome state rather than flattening it into *no effect* or *failed*, and assume **no delivery order** — stay idempotent on `event_id`, compare `occurred_at` for staleness, and leave store disagreement to S2 EC-09. **Not to be reopened unless implementation exposes a concrete contradiction with the ratified contract.**
**Revision history:** **rev 5 (2026-09-19)** — **five statements in the ratified text were false against the very source revision the record was written from, and one scope was never stated at all.** This is the trigger the ratification clause names, so the record is repaired rather than worked around; the architecture direction, the guarantee and every mechanism in §7B–§7F survive unchanged (§12). **(1) §7A's durability premise was universal and is not.** *"Every canonical appointment mutation is a write to exactly one appointment document"* is false for the five `jobFilter` reminder writers, which mutate with `updateMany({_id: {$in: […]}})` — an unbounded multi-document write that cannot carry one `event_id`. Repaired by scoping the premise to the **emitting operation** (§7A) and by the emitting set of new §5A, under which three of those writes are excluded as bookkeeping and the fourth, `finished`, must **fan out per appointment**. **(2) §5's identity premise was false for seven writers.** *"Every writer queries on that business key"* does not hold for the five reminder writes or for `ungga-landing`'s two appointment routes, all of which key on Mongo `_id`; `ungga-landing`'s own row type does not even model `appointment_id`. Repaired in §5 with a fail-closed rule, and with the reason mixed identity is not survivable: it splits one appointment into two Gu OS entities. **(3) §7's assignment mechanism was available at two writers out of thirteen.** *"Inside the same Firestore transaction … at an organization-scoped path"* describes `manualcarrusel` and `autoLeadOnProperty`; three writers use a `WriteBatch`, six use plain independent `.set()`/`.update()` calls under `Promise.all`, and the two clauses additionally conflict — the document the sticky gate reads is the top-level `leads/{lead}`, which is not org-scoped by path, while the org-scoped copy is not what the decision reads. Repaired in §7 with a per-writer invariant and an enumerated table; **the invariant `legacy_scope` is producer-derived and never caller-supplied is preserved and was explicitly confirmed by the Accountable**, which is why this is a mechanism repair and not a tenancy change. **(4) The writer inventory was incomplete.** `ungga-landing`'s two lifecycle writers sat outside the fourteen, and `guv3/gu/main_app.py:2514` is an unnamed twin of a named `ts-services` route. Both are now enumerated. **(5) Dead paths were counted as live.** `sync_owner_phone` / `syncOwnerPhone` are among the "nine Mongo-only writers" with every real call site commented out in both runtimes, and `bots/main`'s two appointment-creation functions have **no callers repository-wide**. They are excluded from the emission denominator and given drift guards, because a coverage test that asserts emission from an unreachable path proves nothing. **(6) `bots/main` scope was never decided.** Its only live appointment capability is the `mkt` visit tracker; `gga`, `info` and `franchises` register no appointment tool, and an unrecognised number is classified `"gu"`, whose dispatch branch is an explicit `pass`. Whether the Alebrixe pilot can reach the one `mkt`-selecting number is **not provable from read-only repository evidence**, so it is excluded from the first pilot emitting set with a drift guard and a hard hosted-evidence prerequisite (§5A). **§3 additionally gains a top-level `legacy_owner_ref`** for [ADR-111](ADR-111-legacy-service-auth-v1.md) §6.3b — **specified here, authorized only by that record's re-ratification.** Guard extended: `npm run test:c1-appointment-finalization`. **rev 4 (2026-09-17)** — **two concurrency/ordering semantics made implementation-unambiguous**, on the Accountable's third pre-ratification review, with the architecture direction approved and unchanged. **First, rev 3's delivery-order claim was false.** It said the drain "preserves array order", but §7B defines drainability as *finalized and unclaimed*, so a later entry that finalized in one write is claimable while an earlier `pending` entry is not — precisely the reschedule-then-confirmation case. New **§7F** resolves it by **removing the per-appointment delivery-order guarantee** rather than enforcing head-of-line delivery, which would let one `pending` entry stall every later event for that appointment until the sweep aged it out. The choice rests on evidence, not preference: no Gu OS consumer of these events exists, `source_events` copies a per-row insert-or-claim ledger that was never ordered, and S1 §8.9 and S2 treat appointment and assignment changes as reconsideration triggers rather than an ordered stream. Append order still *records* canonical mutation order. The consumer guidance is also tightened — `occurred_at` orders mutations of one appointment and does **not** resolve store disagreement, which S2 **EC-09** governs by requiring preserved uncertainty and provenance and rejecting generic last-write truth. **Second, the writer and the recovery sweep could both finalize the same entry.** Finalization is now a **conditional atomic transition** in both §7B and new **§7C-bis**, filtered on `$elemMatch: { event_id, state: "pending" }`, so MongoDB decides the winner and at most one succeeds. If the writer wins, recovery's no-match is a **no-op and a success**, never an error or a retry. If recovery wins, the writer **must not overwrite** — the event may already be delivered, and Gu OS's `event_id` dedup would silently drop a corrected redelivery, so overwriting would manufacture invisible divergence. The late real outcome is kept in a separate `late_outcome_observations` array as diagnostics, chiefly because a rising count means the sweep's threshold is mistuned; delivering corrections would be a new event kind and a new decision. Guard grew to **`npm run test:c1-appointment-finalization` (100 checks)**, and both new semantics were mutation-tested in both directions: removing the conditional transition produces 17 failures, and *adding* head-of-line delivery fails the §7F case, so neither the race protection nor the deliberate absence of ordering can regress silently. **rev 3 (2026-09-17)** — **the durability boundary and the delivery-readiness boundary are separated**, on the Accountable's pre-ratification review of rev 2, with the architecture direction approved and unchanged. Rev 2 correctly established that the canonical Mongo mutation and its event obligation are single-document atomic, and then **overstated it**: a logical appointment operation also produces Calendar and Firestore effects, and the normalized payload reports both, so an event is not delivery-ready merely because the canonical mutation committed. Sending at that instant would fabricate outcomes that were still unknown. Rev 3 adds **§7A** (obligation becomes durable — atomic, and the only thing that is), **§7B** (event becomes finalized and delivery-ready — the drain touches nothing else), **§7C** (recovery after a crash between the two, finalizing unresolved outcomes as `unknown` and never as a claim about what happened, with `finalized_by` preserving provenance) and **§7D** (the guarantee stated exactly). The per-writer ordering was re-verified against `ungga-full` @ `gcp/main` and is tabulated in §7B: **thirteen of the fourteen writers have no gap** because Mongo is last or alone, and the one that does — prospect-side reschedule — already performs a second Mongo update after its Calendar call, so finalization costs no extra request. §5 gains `unknown` in both outcome vocabularies and a `finalization` block. **§7E removes `integration_seq`**: the client-side read-increment-push it required cannot be made race-free, and neither job it did was needed — drain liveness is answered by the pending array itself, and per-appointment ordering comes free and unracheably from the atomic `$push` append order. Drain exclusivity is specified through a single-document claim so that removal opens no double-delivery hole, and C1's lack of cross-entity ordering is stated as an explicit non-claim. Guarded by `npm run test:c1-appointment-finalization`. **rev 2 (2026-09-17)** — the **appointment durability guarantee was unsupported by its own mechanism** and is corrected, with the architecture direction unchanged. Rev 1 concluded that the Atlas Data API's lack of multi-document transactions forced a sequential business-write-then-record, named the resulting process-death window, and then still called the result *at-least-once with a reconciliation backstop* — which that mechanism cannot provide, since a mutation lost in that window leaves no record anywhere that an event was owed. It had asked for the wrong atomicity: every appointment mutation is a write to **exactly one document**, and Mongo is atomic at the single document even through the Data API, so the obligation is now recorded **inside the appointment document** atomically with the business write. At-least-once is therefore earned rather than asserted; the residual risk is reclassified from durability to **coverage**; the reconciliation sweep is retained with its purpose corrected to **drain liveness** and its comparands named (`pending_integration_events` age, `integration_seq` against `last_emitted_seq`) instead of an unspecified last-modified field; and the native-driver migration is **no longer a prerequisite** (§7, Consequences). A stale `§4` cross-reference in §2 was repaired to `§5`.
**Related:** [ADR-111](ADR-111-legacy-service-auth-v1.md) (the authentication this rides on), [ADR-109](ADR-109-generic-case-relationships-lineage.md), R1 [`technical-plan.md`](../product/roadmap-increments/r1-relationship-operations-v1/technical-plan.md) TD-5 and §4 row C1, [`legacy-source-audit.md`](../product/roadmap-increments/r1-relationship-operations-v1/legacy-source-audit.md) §7, §8, §11, §24

## Context

C1 asks Traditional Gu to forward four classes of business event to Gu OS. The receiving side is already built: `source_events` exists with `unique (organization_id, dedup_key)`, the four event kinds are a database `CHECK` constraint rather than a convention, and the interim polling adapter writes those same rows today. C1 changes the writer, not the table.

Two things about the producer side turned out to be materially different from what the C1 request assumed, and both are established by direct inspection of `UnggaMX/ungga-full@gcp/main` on 2026-09-17 (recorded in [`legacy-source-audit.md`](../product/roadmap-increments/r1-relationship-operations-v1/legacy-source-audit.md) §24):

- **There is no durable integration-event mechanism of any kind.** No outbox, no event log, no pending-delivery record with attempts. Pub/Sub with dead-letter topics is the retryable pattern the codebase trusts, but both the `bot` and `worker` consumers **acknowledge before doing the work** (they spawn a thread and return), so Pub/Sub's redelivery guarantee does not cover application failure after the ack. And `bot-dlq` has no subscription, so messages that exhaust delivery there are simply gone.
- **The mutations that must emit events have no common seam, and they are far more numerous than assumed.** Thirteen distinct writers mutate lead assignment across two runtimes and four collections; fourteen distinct writers mutate appointments, of which nine touch Mongo only. A helper that would have propagated advisor changes (`AppointmentsService.syncOwnerPhone` and its Python twin) exists with **every call site commented out**.

The consequence is that C1 cannot be specified as "the existing writers POST to Gu OS". Two things need deciding first: what identifies an event, and what makes its publication survive a process death. This record decides both, and — because the answer differs by store — it states where atomicity is achievable and where it is not, rather than claiming a uniform guarantee.

## Decision

### 1. Entity identity is not event identity

An entity id says *what* changed. An event id says *which logical mutation* happened. Collapsing them means the second change to the same entity either overwrites the first or is discarded as a duplicate.

Two fields, with distinct jobs:

| Field | Meaning |
|---|---|
| `external_ref` | The affected entity's identity. Opaque to Gu OS, stored and compared, never parsed. |
| `event_id` | The identity of **one logical mutation**. Minted once, reused across every delivery attempt. |

Gu OS derives its idempotency key from both, through the **existing** helper, unchanged:

```
buildSourceEventDedupKey({ sourceSystem, eventKind, externalRef, discriminator: event_id })
```

That helper lives in `packages/types` precisely so the polling adapter and the C1 webhook cannot drift apart, and reusing it here is what keeps that property real rather than aspirational.

**The following must never be used as event identity:** the entity id alone, `assigned_at`, a generic timestamp, a database update timestamp, or the request arrival time. None of them distinguishes two mutations of the same entity within the same second, and the timestamp-shaped ones are not stable across retries.

### 2. Where `event_id` comes from, per kind

**Provider-originated events reuse the provider's identity. Internally-generated mutations mint one.**

| Kind | `event_id` | Why |
|---|---|---|
| `inbound_prospect_message` | the Meta/provider message id | The provider already supplies a durable logical message identity. Inventing a UUID would discard it. |
| `advisor_activity` (same-thread) | the provider echo message id where the source provides one; otherwise a minted UUID | Same-thread takeover arrives as a `smb_message_echoes` change carrying an id. |
| `assignment_change` | a minted UUID, created once at the mutation | No provider is involved; nothing in legacy state identifies the mutation. |
| `appointment_change` | a minted UUID, created once at the mutation | The appointment's own business key is stable across its whole lifecycle (§5), so it cannot identify one change within it. |

Retries reuse the same `event_id`. A retry that mints a new one is a duplicate event, not a retry.

**This rule is load-bearing for the poll→webhook cutover, in a way worth stating explicitly.** Gu OS's polling adapter derives the message discriminator as `wamid ?? timestamp ?? leadUpdatedAt`. If C1 sends a minted UUID for `inbound_prospect_message`, the same physical message ingested by both paths produces two different dedup keys and therefore two Gu OS events. Using the provider id makes the two paths agree by construction.

It makes them agree **only when the provider id is actually present on both paths**, and repository truth says it is not always: the Firestore conversation entries Gu writes itself carry no provider id, so the gateway read can surface a null `wamid` and the poll path then falls back to a timestamp. So SL-5 must either cut over with no overlap window, or accept that an overlap window can produce duplicate Gu OS events for Gu-written messages. That is an SL-5 design constraint, recorded here because C1's identity rule is what creates it; this record does not choose between the two options.

### 3. The event envelope

**One event per request.** Batching is deliberately excluded from v1: it introduces partial-failure semantics on both sides for a pilot-scale volume that does not need it. Adding a batch form later is additive.

```json
{
  "protocol": "GuOSLegacyEvents-v1",
  "event_id": "<provider id, or a UUID minted once for this mutation>",
  "event_kind": "assignment_change",
  "source_system": "traditional_gu",
  "external_ref": "<affected entity identity>",
  "external_lead_ref": "<lead identity, when the event concerns a lead>",
  "legacy_owner_ref": "<the Traditional Gu owner/source this event belongs to>",
  "occurred_at": "<RFC 3339, UTC, Z-suffixed>",
  "producer": {
    "component": "ts-services",
    "writer": "guard-lead-one",
    "attempt": 1,
    "emitted_at": "<RFC 3339>"
  },
  "payload": { }
}
```

- `event_kind` is one of the four values the `source_events` CHECK constraint already allows. The constraint, not the documentation, is the vocabulary.
- **Payloads are allowlisted normalized JSON, never raw Firestore or Mongo documents.** A raw document leaks fields nobody agreed to and couples Gu OS to legacy schema drift.
- `occurred_at` is when the business mutation happened, which is not when it was emitted (`producer.emitted_at`) and not when Gu OS received it. `producer.attempt` is diagnostic only and is explicitly **not** part of the identity — attempt 1 and attempt 4 of the same event are the same event.
- **The Organization is not in the envelope.** It is resolved server-side from the ADR-111 key binding. If a future envelope carries an organization field it is a consistency assertion to be checked against the binding, never an authorization input.
- **`legacy_owner_ref` is the owner/source this event belongs to** *(rev 5; governed by [ADR-111](ADR-111-legacy-service-auth-v1.md) §6.3b, **PROPOSED**)*. It is **producer-derived from the actual source mutation or source state** — never a caller-configurable value or a default — and it is **required on every C1 event**. It is **opaque to Gu OS**, which does exactly one thing with it: check `legacy_owner_ref ∈ ownerRefs` against the server-side key record. It is **never parsed, never used to derive the Organization**, and **never authorization by itself**. Because it is a top-level envelope field it sits inside the raw bytes the ADR-111 signature covers, which is what makes an attested owner meaningfully different from an asserted header. Absent owner ref, empty `ownerRefs`, or a non-member value all **fail closed**; a non-member is `403`. **This field is specified here and authorized only by ADR-111 §6.3b's re-ratification** — until then no receiver may be built against it.

### 4. Normalized `assignment_change`

```json
{
  "operation": "assignment | reassignment | unassignment | assignment_state_set",
  "lead_ref": "<legacy lead id>",
  "assigned_user_ref": "<advisor ref> | null",
  "previous_assigned_user_ref": "<advisor ref> | null",
  "previous_known": true,
  "legacy_assigned_flag": true,
  "policy": {
    "legacy_assignment_type": "guardias | carrusel | carrusel-manual | propiedad | manual | null",
    "legacy_assignation_type": "<the other legacy field, when the writer sets it> | null",
    "writer": "<the emitting writer's stable name>"
  },
  "advisor_role_semantic": "advisor | principal | unknown"
}
```

**`legacy_owner_ref` moved out of this payload and into the envelope at rev 5, and is not duplicated here.** Rev 4 carried it inside `assignment_change` as *"organization principal ref"*, which is **the same semantic** as the envelope field §3 now requires on every event: the Traditional Gu owner/source the event belongs to, which in the legacy model is the organization principal. Keeping both would create two places to write one value and therefore a way for them to disagree — and since the envelope copy is the one ADR-111 §6.3b checks against `ownerRefs`, a divergent payload copy would be a security-relevant ambiguity rather than a cosmetic one. There is **no** assignment-specific owner concept distinct from authorization scope, so none is invented: the envelope field is canonical for both jobs. The advisor side of the relationship is unaffected — `assigned_user_ref`, `previous_assigned_user_ref` and `advisor_role_semantic` are about the **advisor**, not the owner, and are unchanged.

Five rules, each forced by observed behavior rather than preference:

**`assignment_state_set` exists because most writers cannot tell an assignment from a reassignment.** Eight of thirteen assignment writers never read the prior `assignedTo` before overwriting it. `operation` therefore reports only what the writer actually established: `assignment` when it confirmed there was no prior assignee, `reassignment` when it confirmed a different one, `unassignment` when the assignee was removed or parked on the principal, and `assignment_state_set` when it set an assignee **without establishing the prior state**. Without the fourth member, every one of those eight writers would have to lie.

**Absence is preserved, never fabricated.** `previous_known: false` with `previous_assigned_user_ref: null` is a valid and common event. A reconstructed "previous" value would be a guess, and a guess about who used to own a lead is exactly the kind of thing a downstream system would act on.

**The raw legacy flag travels alongside the semantic operation.** `legacy_assigned_flag` carries the legacy `assigned` boolean verbatim. It is genuinely independent of the semantic operation: one writer sets `assigned: false` while pointing `assignedTo` at the principal (an "unassigned, parked" state), and another changes `assignedTo` on offboarding while leaving `assigned: true` untouched.

**Both legacy policy fields are carried, because they are not synonyms.** Some writers set `assignment_type`, others set `assignation_type`, one sets both, and the codebase's own comment records the intended distinction: `assignation_type` describes how *this lead* was assigned, while `assignment_type` is the organization's configured strategy. Normalizing them into one field would destroy a distinction the source deliberately makes.

**The role is normalized semantically at the boundary, and no legacy literal becomes a Gu OS invariant.** The legacy vocabulary is internally inconsistent — `seller` and `vendedor` are both written for the same concept by different paths, the only eligibility predicate that reads roles compares against `admin` and `super-admin`, no writer ever produces `admin`, and nothing anywhere reads `seller` or `vendedor` as a gate. There is also a second, independent role axis (`multiusers_role`). Worse for any rule keyed on the literal: the offboarding path **sets a removed advisor's role to `super-admin`**, so that literal does not reliably mean "organization principal". Hence `advisor_role_semantic` with three values, `unknown` included, resolved by the producer from membership and eligibility rather than from a string comparison.

**What C1 does not do:** it does not reproduce assignment-selection policy. Traditional Gu remains the owner of that policy in this phase. The three concerns stay separate — organization membership and advisor eligibility, the policy that chooses an advisor, and the resulting durable lead→advisor assignment — and Gu OS consumes only the third as a semantic event.

### 5. Normalized `appointment_change`

```json
{
  "operation": "created | rescheduled | confirmed | cancelled | status_changed | other",
  "appointment_ref": "<the legacy appointment business key>",
  "legacy_deal_ref": "<deal ref> | null",
  "lead_ref": "<legacy lead id>",
  "property_ref": "<property ref> | null",
  "store_write_outcomes": [
    { "store": "mongo", "outcome": "written | deleted | failed | not_attempted | unknown" },
    { "store": "firestore", "outcome": "written | deleted | failed | not_attempted | unknown" }
  ],
  "calendar_effect": { "google_event_id": "<id> | null", "operation": "created | updated | deleted | none | unknown" },
  "finalization": { "finalized_by": "writer | recovery", "finalized_at": "<RFC 3339>" },
  "status_after": { "status": "...", "appointment_status": "...", "owner_appointment_status": "..." },
  "scheduled_for": { "date": "...", "hour": "...", "front_date": "...", "front_hour": "..." }
}
```

**`appointment_ref` is the legacy appointment business key — the client-minted `appointment_id` — and never the Mongo `_id`.** It is a UUID minted once at creation and stable for the appointment's whole life.

***Corrected at rev 5, because the rev-4 justification was false and the rule would have been unimplementable as stated.*** Rev 4 said *"Every writer queries on that business key."* **Seven current writers do not.** The five `jobFilter` reminder writes key on `_id: {$in: […]}`, and **both `ungga-landing` appointment routes** key on `_id` through a shared `buildIdFilter()` helper whose row type does not model `appointment_id` at all. Three of the reminder writes leave the emitting set as bookkeeping (§5A) and the fourth must fan out, but the two `ungga-landing` writers are **in** the first C1 scope, so the rule needs a mechanism rather than an assumption.

**The normative rule (rev 5).**

- `appointment_ref` **is** the stable `appointment_id`. **Mongo `_id` is never an allowed fallback**, not even transiently and not even when it is the only identifier a writer holds.
- **An emitting writer must obtain the business key before emission.** For a writer that mutates by `_id`, that means loading or projecting `appointment_id` first. This is cheap where it applies: both `ungga-landing` routes already perform an authorization read of the document before mutating, so the key is one added projection field, not an added round trip.
- **If the business key is absent: fail closed.** Do not fabricate an identifier, do not fall back to `_id`, **do not emit**, and record a coverage/operational anomaly on the producer side. A missing event is recoverable — the anomaly says exactly which mutation was not published. A wrong `external_ref` is not.

**Why mixing the two identity spaces is not survivable, which is the reason `_id` is refused rather than merely discouraged.** Gu OS derives its idempotency key through `buildSourceEventDedupKey(…, externalRef, discriminator: event_id)`, so `external_ref` *is* the entity's identity on the Gu OS side. If `ungga-landing`'s confirm emitted `external_ref = <_id>` while `guv3`'s reschedule emitted `external_ref = <appointment_id>` for **the same appointment**, the two events would produce different dedup keys and Gu OS would hold **one appointment as two unrelated entities** — splitting its SL-8 visit subject, and never reconciling, because nothing downstream can know the two refs denote one thing. Note that the usual argument does not apply here and is deliberately not used: `_id` is in fact stable across reschedule, since a reschedule is an in-place update. The defect is not instability. It is that **two identity spaces for one entity cannot be joined after the fact.** A second reason reinforces it: the Firestore replica carries its own document id, so only the business key can correlate the two stores at all.

**Current-source note, kept because it is what the coverage test must target.** `appointment_id` is minted as a UUID at both live creation sites and written into the Mongo insert, so appointments created by the live path carry it. The one creation path that accepts a key without minting one is in `bots/main` and has **no callers repository-wide**, so it cannot produce keyless documents today. Historical coverage of `appointment_id` on pre-existing Mongo documents is **unmeasured**: SL-1 sampled *Firestore* and found the key on 63 of 126 documents, and no equivalent Mongo figure exists. A read-only survey is authorized and is recorded as **pending evidence**; it sizes the residual frequency of the fail-closed branch and **does not change this rule**.

**`appointment_ref` is not `event_id`.** One appointment experiences creation, reschedule, confirmation, cancellation and status transitions; each is its own event with its own `event_id`. The business key is stable across all of them — a reschedule is an in-place update, never a new record — which is precisely why it cannot identify one of them.

**`store_write_outcomes` states which stores actually changed, per event.** This is not bookkeeping: nine of fourteen appointment writers touch Mongo only, so the advisor-facing lifecycle — confirmation, advisor-side reschedule, reminder outcomes, the post-visit survey — never reaches Firestore at all. An event that implied both stores changed would be false most of the time. Cancellation is the sharpest case: the Firestore document is **deleted** while Mongo keeps a tombstone, so after a cancellation the two stores no longer describe the same set of appointments.

**A Firestore-only writer must not be represented as a change to the canonical record.** If a mutation path updates only Firestore, `store_write_outcomes` says so and `status_after` reports only what that path actually set.

**`calendar_effect` is preserved as effect evidence**, because a Calendar event can exist while persistence fails — the orphan risk the audit describes at §11.4. Note that the calendar event id can change across a reschedule even though the appointment key does not.

**`unknown` is not a synonym for `none` or for `failed`, and §7C is the only thing that produces it.** It means *this outcome was never observed, because the process died between the canonical mutation and finalization*. A consumer that treats it as "no effect" reintroduces exactly the orphaned-Calendar blindness this contract is trying to remove; a consumer that treats it as "failed" invents a failure that may not have happened. It is a third state on purpose.

**`finalization` records how the outcomes above were arrived at** — `writer` when the mutating path reported them, `recovery` when §7C defaulted them after a crash. Provenance of an outcome is part of the outcome.

**C1 is not the project that normalizes the legacy appointment model.** The divergence between the two stores stays visible and is never silently reconciled. Which representation binds when they disagree remains an open question owned by the R1 Technical Plan, and this record does not answer it.

### 5A. The emitting set — which appointment mutations are events *(rev 5)*

Rev 4 never said which mutations emit. That left the coverage guarantee of §7D without a denominator: a test asserting *"no appointment write path constructs its update outside the helper"* cannot be written, let alone pass, until *which* paths owe an event is a closed list. This section is that list, decided by the Accountable as **D1** and **D4**. It is normative and deliberately enumerable, because the point is that omissions become mechanically reviewable.

**The principle.** C1 emits for **actor-driven business lifecycle transitions of an appointment**. **Scheduled notification bookkeeping does not emit.** The list below applies that principle to current source; where source and list disagree, source is the trigger to repair this record.

| Mutation | Site (current source) | Disposition |
|---|---|---|
| Create — prospect conversation | `appointment_assistant/nodes/tools.py` → `AppointmentsRepo.create()` | **EMIT** `created` |
| Create — standby graph | `standby_graph/standby_tools.py` → same | **EMIT** `created` |
| Reschedule — prospect side | `appointment_assistant/nodes/tools.py` | **EMIT** `rescheduled` — the one §7A→§7B gap |
| Cancellation | `appointment_assistant/nodes/tools.py` | **EMIT** `cancelled` |
| Advisor confirm — Python | `agent_appointment_assistant/nodes/tools.py` | **EMIT** `confirmed` |
| Advisor reschedule — Python | `agent_appointment_assistant/nodes/tools.py` | **EMIT** `rescheduled` |
| Advisor confirm — TS route | `services/src/services/appointmentsService.ts` | **EMIT** `confirmed` |
| Prospect-will-be-contacted — TS route | `services/src/services/appointmentsService.ts` | **EMIT** `status_changed` |
| Prospect-will-be-contacted — Python twin | `guv3/gu/main_app.py` | **EMIT** `status_changed` — named at rev 5; a per-runtime twin of the row above, and coverage misses it if it is not enumerated |
| Visit lifecycle / status transitions — guv3 | `visit_tracker_assistant/nodes/tools.py` | **EMIT** `status_changed` |
| Satisfaction / post-visit outcome — guv3 | `visit_tracker_assistant/nodes/tools.py` | **EMIT** |
| **`finished`** — survey sweep | `jobFilter/.../findUsersFromAppointment.ts` | **EMIT** — see the fan-out rule below |
| Advisor confirm | **`ungga-landing`** `api/appointments/[id]/confirm/route.ts` | **EMIT** `confirmed` — in first C1 scope; needs §5's business-key rule |
| Advisor reschedule | **`ungga-landing`** `api/appointments/[id]/reschedule/route.ts` | **EMIT** `rescheduled` — in first C1 scope; needs §5's business-key rule |
| `satisfaction_survey_sended` | `jobFilter/.../findUsersFromAppointment.ts` | **EXCLUDED — bookkeeping** |
| `owner_notified` (bulk reset) | `jobFilter/.../findUsersFromAppointment.ts` | **EXCLUDED — bookkeeping** |
| `owner_notified` (second write after confirm/cancel) | `visit_tracker_assistant_tools.py` and its guv3 twin | **EXCLUDED — bookkeeping.** The obligation for that logical operation rides the **status** write, not this one |
| `owner_pre_notified` | `jobFilter/.../findUsersFromAppointment.ts` | **EXCLUDED — bookkeeping** |
| Reset / purge (guv3, deletes appointments) | `guv3/gu/helpers/helpers.py` | **NO C1 EVENT — producer-side operational audit only** |
| Owner-phone sync — Python and TS twin | `gu/db/mongo/appointments.py`; `appointmentsService.ts` | **DEAD — excluded from the denominator, drift guard retained** |
| Appointment creation — `bots/main`, Mongo and Firestore | `bots/main/global_db/{mongo,firebase}/appointments.py` | **DEAD — excluded, drift guard retained.** If revived it must mint `appointment_id` first |
| `bots/main` visit-tracker status and satisfaction writers | `bots/main/global_tools/visit_tracker_assistant_tools.py` | **EXCLUDED FROM THE FIRST ALEBRIXE PILOT SCOPE** — see below |

**`finished` is an event, and that has a consequence the bulk site cannot avoid.** It is not bookkeeping: it is the appointment's active/closed predicate, filtered on by five separate read paths, and it is also written by the cancellation path. So it emits. But the sweep that sets it writes `updateMany` over a matched set, and **one bulk mutation cannot carry one `event_id`**, because `event_id` identifies *one logical mutation of one entity* (§1). The contract requirement is therefore semantic, not an API choice: **fan out per affected appointment — one appointment, one logical mutation, one stable `event_id`, one durable obligation recorded atomically with that appointment's own write.** This record deliberately does **not** prescribe a loop, a bulk-with-per-document-obligation primitive, or any particular driver call; any mechanism satisfying the four properties conforms. **Cancellation already carries its own `finished` transition and must not emit a second event merely for the field.**

**Excluded bookkeeping, and what is forgone.** Gu OS is never woken by "a reminder was dispatched". That is acceptable and not merely convenient: no Gu OS behavior in S1–S4 or the R1 Technical Plan consumes notification dispatch, the Supervisor reconsiders on appointment *changes*, and emitting them would multiply event volume by the reminder cadence for no consumer. **Reset/purge** produces no event, so Gu OS may retain a Case referencing appointments legacy has destroyed; that divergence is accepted **only** because purge is a reset/testing path, and the producer must record it operationally so it is not invisible. **Dead paths** forgo nothing today — the drift guard is the entire point, so that reviving one without emission fails coverage instead of silently narrowing it.

**`bots/main` — excluded from the first Alebrixe pilot scope, and the reason is a limit of evidence, not a finding of safety.** Current source establishes a narrow capability: `bots/main` **cannot create** appointments in either store (both creation functions have no callers repository-wide), its only live appointment-mutating capability is the visit tracker, and that is wired into exactly one graph — `mkt`. `gga`, `info` and `franchises` register no appointment tool, and a bot number outside the hard-coded brand allowlist is classified `"gu"`, whose dispatch branch is an explicit `pass`. Reaching an appointment mutation therefore requires the receiving business number to be the single literal that selects `mkt`.

**Whether the Alebrixe pilot uses that number is not provable from available read-only repository evidence.** Deployment configuration is untracked in source — the Terraform declares no environment variables and every service carries `lifecycle { ignore_changes = all }` — the Gu-number→Organization mapping lives in a Firestore collection rather than in the repository, and Gu OS's own hosted-evidence artifacts mask the identifier that would answer it. **This record does not claim Alebrixe is known not to use it.** The recorded truth is *scope not provable from available read-only repository evidence*, and the disposition is conservative:

- `bots/main` appointment-mutation paths **stay explicit** in this record and in the Technical Plan's producer inventory, and carry a **drift/scope guard**;
- **expanding C1 to any pilot or runtime that uses them requires adding them to C1 coverage first**;
- and a **hard precondition before Alebrixe hosted C1 evidence**: *prove that no Alebrixe traffic can mutate appointments through an excluded `bots/main` runtime.* Reconnaissance has reduced that proof to a single comparison — whether the pilot's Gu business number is the one `mkt`-selecting literal — which is a hosted-evidence gate, not an ADR gate. If it cannot be proven, hosted evidence does not proceed until `bots/main` is instrumented or brought into scope.

### 6. Durable publication: a narrow producer-side outbox

A business mutation followed by a best-effort HTTP POST has a loss window that no amount of retrying closes: the business write commits, the process dies, and the event is never delivered — with nothing anywhere recording that it should have been.

So the producer persists a durable integration record **before** attempting delivery, and a bridge drains it:

```
integration_events
  event_id          -- unique; the identity from §1/§2
  event_kind
  source_system
  external_ref
  external_lead_ref
  occurred_at
  legacy_scope      -- producer-derived owner/source scope, never caller-supplied
  payload           -- bounded, allowlisted
  producer          -- component + writer
  delivery_state    -- pending | delivering | delivered | failed_permanent
  attempts
  next_attempt_at
  last_attempt_at
  last_error
  created_at
```

- The bridge drains `pending`, signs per [ADR-111](ADR-111-legacy-service-auth-v1.md) with an `events-ingest` key, and retries with backoff. Existing Pub/Sub infrastructure may carry the delivery leg **after** the durable record exists; it may not replace it.
- **The row is not always where the obligation first becomes durable, and §7 is what decides that per store.** For assignment the row is written inside the business Firestore transaction. For appointments the obligation is first recorded inside the appointment document itself, atomically with the business write (§7A), and the drain promotes it into this table **only once it is finalized** (§7B); the table is then the delivery ledger rather than the durability boundary. Either way, no path attempts delivery before the obligation is durable somewhere, **and no path delivers an event whose secondary outcomes are still unresolved.**
- **`delivery_state` is about delivery, not about completeness.** An entry that has not yet reached §7B is not a `pending` row here — it is not in this table at all. The two vocabularies are deliberately separate: `state: pending | finalized` on the appointment document governs *readiness*, and `delivery_state` governs *transmission*. Collapsing them was what let rev 2 imply a delivery-ready event that had unresolved outcomes.
- **Gu OS `source_events` remains a second, independent idempotency boundary.** Its `unique (organization_id, dedup_key)` protects Gu OS from duplicate delivery. It is not a substitute for producer-side durability: it can only deduplicate events that arrive.
- **This is not an event-sourcing platform.** It is one table, four event kinds, and a drain loop. No projections, no replay-as-truth, no generic event bus.

### 7. Atomicity, stated honestly per store

Cross-database atomicity is not invented anywhere. Where a business mutation and its integration record can be persisted in one native transaction, they are; where they cannot, the residual window is named and given a bounded recovery mechanism.

**Assignment mutations — atomic, achievable today, but not by one universal mechanism.** The authoritative assignment write is Firestore, and the Mongo mirror write stays non-atomic — the event describes the assignment decision, which Firestore owns. That much is unchanged.

***Repaired at rev 5, because rev 4's mechanism did not exist at eleven of thirteen writers.*** Rev 4 said the record is written *"inside the same Firestore transaction as the assignment write"*, *"at an organization-scoped path"*. Current source contradicts both halves, and they also contradict each other. **Only two controllers hold a `runTransaction`.** Three use a `WriteBatch`. **Six perform three independent `.set(…, {merge:true})` calls under `Promise.all`**, which is deliberately parallel for latency and is not a transaction. And the org-scope clause pulls against the authority clause: the document every sticky gate actually *reads* is the top-level `leads/{lead}`, which is **not** organization-scoped by path, while the organization-scoped `users/{org}/user_leads/{lead}` copy is not what the assignment decision consults. **There is no single universally authoritative assignment document, and this record no longer pretends there is** — two writers never touch the global document at all.

**The invariant, restated so it is true of every writer and still says the same thing about tenancy:**

> **The integration obligation is written in the same atomic Firestore operation that establishes that writer's assignment truth.**

A single-document `.set()` / `.update()`, a `batch.update()` and a `tx.update()` are each atomic, so in every writer family below the obligation rides **in the operation that is already being performed** — no added operation, no added round trip, and no conversion of a parallel fan-out into a transaction.

**Organization scope stays producer-derived, by one of two structural routes**, chosen per writer rather than assumed:

1. **By path**, where the document establishing assignment truth is already organization-scoped (`users/{org}/user_leads/{lead}`); or
2. **By the Organization reference written in that same atomic operation** — four of the global-document writers already set `organization_id` as a Firestore `DocumentReference` in the very payload that sets `assigned` / `assignedTo`.

**The Accountable explicitly confirmed that route 2 satisfies `legacy_scope` is producer-derived and never caller-supplied**, which is why this is a mechanism repair rather than a tenancy change: the value is still computed by the producer inside the atomic write and is still never accepted from a caller. What moved is *how* the scope is made structural, not *whether* it is.

**Two independent writes must never be described as durable.** That is rev 1's error and this repair does not reintroduce it: the obligation and the business mutation are one operation, or the writer does not conform.

| Writer family | Establishes assignment truth in | Firestore primitive (current source) | Obligation rides | Organization scope route |
|---|---|---|---|---|
| Guardia on-demand (`guardLeadOne`) | global `leads/{lead}` — the sticky gate reads it | three independent `.set(merge)` under `Promise.all` | the global-document `.set()` | **2** — `organization_id` ref in the same payload |
| Carrusel (`autoLead`) | global `leads/{lead}` | independent `.set()` under `Promise.all` | the global-document `.set()` | **2** |
| Explicit / manual (`manualLead`) | global `leads/{lead}` | independent | the global-document `.set()` | **2** |
| Property assignation (`c21propertiesassignation`) | global `leads/{lead}` | independent | the global-document `.set()` | **2** |
| Properties-manual (`propertiesmanual`) | global `leads/{lead}` | independent | the global-document `.set()` | **2** |
| Lead creation (`checkIfUserExists`, and the Python `createLead`) | global `leads/{lead}` | independent single-document write | that write | **2** |
| Carrusel manual (`manualcarrusel`) | global + org + advisor copies, all three inside one transaction | **`runTransaction`** | `tx.update()` on the global document | **2** |
| Property-driven / property-carrusel (`autoLeadOnProperty`) | global `leads/{lead}` | **`runTransaction`** on the carrusel branch | `tx.update()` | **2** |
| Guardia batch (`periodAssignation`) | **org copy only** — `users/{user}/user_leads` where `assigned == false`; never touches the global document | **`WriteBatch`** | the same `batch.update()` | **1** — path |
| Principal-parking backfill (`assignUserLeadsToOwner`) | **org copy only**; never touches the global document | **`WriteBatch`** | the same `batch.update()` | **1** — path |
| **Advisor offboarding cascade** (`deleteSubUserCascade`) | global `leads/{lead}` **and** the org copy, in two separate per-document loops — **not** a batch | per-document `await doc.ref.update()` | the **global-document** update in the first loop | **2** |
| **Lead re-keying** (`numberChange`, in both the workers and jobFilter components) | **recreates** documents rather than updating them | independent `.set()` on new documents | the `set()` that creates the new global document | **2** |

**Two exceptional paths are called out because a per-lead helper silently misses them**, as rev 4's Consequences already warned in prose without naming their mechanics. The **offboarding cascade** is the one writer that reliably knows the previous assignee — it is the query key — and it changes `assignedTo` while leaving `assigned` untouched, which is exactly the asymmetry §4's `legacy_assigned_flag` exists to carry. The **re-keying job** changes assignment by recreating documents, so there is no update to attach an obligation to; the creating `set()` is the atomic operation, and it exists twice, in two components.

**A hazard that follows from the source and is not obvious from the contract.** `manualcarrusel` already performs a Mongo write *inside* its `runTransaction` callback. Firestore retries transaction callbacks under contention, so anything non-transactional placed in that body can execute more than once. **An emission placed in a transaction callback must therefore be the transactional write itself (`tx.update`/`tx.set`), never a side effect beside it** — otherwise at-least-once quietly becomes at-least-once-per-retry on the producer side, before delivery is even attempted.

**Appointment mutations — two boundaries, and conflating them is the mistake this section exists to prevent.** A *separate* Mongo outbox collection cannot be transactional with the business write today: the TypeScript services reach Mongo through the **Atlas Data API**, which is stateless HTTP and cannot participate in a multi-document transaction at all, and while the Python runtime's PyMongo could in principle open a session, **no session or transaction usage exists anywhere in the repository**, so that capability is unproven rather than available.

Rev 1 concluded from this that the business write and the integration record must be sequential, named the resulting process-death window, and then called the result *at-least-once with a reconciliation backstop*. **That claim was not supported by that mechanism** — a mutation lost in that window leaves no record anywhere that an event was owed. The conclusion was also unnecessary, because it asked for the wrong atomicity:

> **Every canonical appointment mutation *in the emitting set* is a write to exactly one appointment document, and MongoDB is atomic at the single document — including through the Atlas Data API.**

***Scoped at rev 5.*** Rev 2 stated this of *every* appointment mutation, and rev 3 and rev 4 inherited that. **It is false as a universal claim**: the five `jobFilter` reminder writers mutate with `updateMany({_id: {$in: […]}})`, an unbounded multi-document write, and no single-document argument reaches them. The premise is repaired by scoping it to what it actually has to be true of — **the operation that owes an event** — which §5A now enumerates. Three of those five writes are excluded as bookkeeping and owe nothing; the fourth, `finished`, owes an event and must therefore **fan out per appointment** (§5A), at which point each emitting operation *is* a write to exactly one document and the premise holds by construction rather than by assumption. **The quantifier changed; the mechanism did not.**

Rev 2 used that to close the durability gap, and **overstated it**. A *logical appointment operation* is not one Mongo write. It can also produce a **Calendar effect** and a **Firestore effect**, and the normalized payload of §5 reports both — `store_write_outcomes` and `calendar_effect`. So an event is **not** ready to send merely because the canonical mutation committed and its obligation was recorded atomically: at that instant some secondary outcomes may still be unknown. Sending then would mean **fabricating them**.

Rev 3 therefore separates two boundaries that rev 2 ran together.

#### 7A. The obligation becomes durable

**The canonical Mongo mutation and the integration-event obligation are recorded in one single-document update.** This is the durability boundary, and it is the *only* thing here that is single-document atomic:

```
appointments/<doc>
  ...business fields...                 -- the canonical mutation
  pending_integration_events: [         -- $push in the SAME update
    {
      event_id,                         -- the identity from §1/§2
      event_kind, operation, occurred_at,
      state,                            -- "pending" | "finalized"
      awaiting,                         -- ["calendar", "firestore"]; [] when nothing is outstanding
      payload,                          -- bounded; carries store_write_outcomes and calendar_effect
      finalized_at, finalized_by        -- null until 7B
    }
  ]
```

Either the business change and its obligation both exist, or neither does. **After this point the event cannot be lost.** It can still be *incomplete*, which is what 7B is for.

#### 7B. The event becomes finalized and delivery-ready

**An entry is eligible for delivery only once every secondary outcome the operation can produce is either observed or explicitly recorded as unobserved.** The drain delivers `state: "finalized"` entries and **never** touches `pending` ones.

```
canonical Mongo mutation + durable obligation   (7A, atomic)
        │
        ▼
  state: "pending", awaiting: [...]
        │           ── Calendar effect ──▶ outcome
        │           ── Firestore effect ──▶ outcome
        ▼
  state: "finalized", awaiting: []              (7B)
        │
        ▼
  drain ──▶ integration_events ──▶ Gu OS
```

**On most paths the two boundaries coincide, and cost one write rather than two.** This is not a convenience — it falls out of the ordering the audit establishes at §24.3, re-verified against `ungga-full` @ `gcp/main` while writing this revision:

| Writer family | Actual ordering | At 7A the secondary outcomes are | Mechanism |
|---|---|---|---|
| **Creation** (prospect-conversation and standby generators) | Calendar → Firestore → **Mongo last** | **already known** | push `finalized`, outcomes filled. One write. |
| **Prospect-side cancel** | Firestore delete → Calendar delete → **Mongo tombstone last** | **already known** | push `finalized`, outcomes filled. One write. |
| **The Mongo-only emitting writers** (advisor confirm in both runtimes, advisor reschedule, prospect-will-be-contacted in both runtimes, visit-tracker status, satisfaction outcome, the fanned-out `finished`, and `ungga-landing`'s confirm and reschedule) | Mongo only | **none exist** | push `finalized`, `awaiting: []`. One write. |
| **Prospect-side reschedule** | Firestore → **Mongo** → Calendar → **Mongo again** | **Calendar unknown** | push `pending`, `awaiting: ["calendar"]`; the **second Mongo update the path already performs** carries the outcome and flips to `finalized`. Still no extra round trip. |

**Exactly one writer family in the emitting set — the prospect-side reschedule — has a real gap between 7A and 7B**, and on that one the code already issues a second `update_one` on the appointment after the Calendar call, so finalization has a natural home and adds no request. Every other emitting writer reaches both boundaries in a single write.

***Counts corrected at rev 5, and the correction matters for the coverage test rather than for the mechanism.*** Rev 3 and rev 4 said *"nine of the fourteen"*, a tally taken over `ungga-full` alone and including paths that cannot run. **Two of those nine are dead code**: `sync_owner_phone` and its TypeScript twin `syncOwnerPhone` exist in both runtimes with **every real call site commented out**, and the Python module's only remaining reference is a compatibility shim nothing imports. **`bots/main`'s two appointment-creation functions are likewise unreachable**, with no callers anywhere in the repository. Meanwhile **two writers were missing entirely** — `ungga-landing`'s confirm and reschedule routes, which mutate the canonical Mongo store directly through the native driver. §5A is now the authoritative enumeration and this table describes ordering only. Dead paths are excluded from the emission denominator and carry drift guards, because **a coverage test that asserts an emission from a path that cannot execute proves nothing** — and would fail the moment someone deleted the dead code, for no defect.

**One further shape the ordering table does not show, and a writer must not misread.** Several Mongo-only emitting paths perform **two** writes for one logical operation: the visit-tracker confirm and cancel paths set `appointment_status` and then, in a *separate* `update_one`, set `owner_notified`. The obligation belongs with the **status** write — the one that carries the business transition. The bookkeeping write is excluded by §5A and is **not** a second emission point.

**Finalization is a conditional atomic transition, not a write.** Because §7C's recovery sweep can target the same entry, finalization must be a single-document update whose filter requires the entry to still be unfinalized:

```
updateOne(
  { appointment_ref: <ref>,
    pending_integration_events: { $elemMatch: { event_id: <E>, state: "pending" } } },
  { $set: { "pending_integration_events.$.state": "finalized",
            "pending_integration_events.$.awaiting": [],
            "pending_integration_events.$.payload...": <observed outcomes>,
            "pending_integration_events.$.finalized_by": "writer",
            "pending_integration_events.$.finalized_at": <now> } }
)
```

The `$elemMatch` on `state: "pending"` is the whole mechanism: MongoDB evaluates the filter and applies the update atomically on one document, so **the transition is a compare-and-set**. A caller that matches nothing modified nothing, and must read that as *someone else already finalized this entry*, never as an error and never as a reason to retry. §7C defines who that someone can be. The general two-state mechanism is nonetheless normative for all of them, because a writer whose ordering changes later must not silently start emitting fabricated outcomes.

#### 7C. Recovery: a crash between 7A and 7B

The entry is durable from 7A, so it is still in the document with `state: "pending"` and `awaiting` naming exactly what was never resolved. **It is discoverable by definition** — a scan for `pending_integration_events.state: "pending"` finds it.

A recovery sweep finalizes any entry `pending` beyond a declared age by recording each `awaiting` outcome as **`unknown`**, and stamping `finalized_by: "recovery"`:

- **never `written`, never `deleted`, never `failed`, never `not_attempted`** — each of those is a claim about what happened, and recovery does not know;
- `unknown` is therefore added to the `store_write_outcomes` outcome vocabulary and to `calendar_effect.operation` (§5);
- `finalized_by` distinguishes *the writer reported these outcomes* from *the writer died and these were defaulted*, so a consumer is never misled about provenance.

This is what makes the guarantee honest in both directions: **the event is not lost, and it is not embellished.** Gu OS can tell "there was no Calendar effect" (`none`) from "the Calendar effect state was never observed" (`unknown`), which are operationally very different — the second is the orphaned-Calendar-event risk of audit §11.4 and must stay visible.

**Reconstructing the true outcome by re-reading Calendar or Firestore is deliberately out of scope for v1.** It is more machinery, and it cannot reliably distinguish *created then deleted* from *never created*. An `unknown` a human can act on beats a guess that looks authoritative.

#### 7C-bis. The writer and the sweep can race, and exactly one wins

The sweep fires on age, not on proof of death, so it can reach an entry whose writer is merely slow — a Calendar call hanging past the threshold rather than a process that died. Both would then finalize the same `event_id` with **different outcomes and different provenance**, which must never both succeed.

**Recovery uses the same conditional transition as §7B**, filtered on `$elemMatch: { event_id: <E>, state: "pending" }`, differing only in what it writes: `unknown` for each `awaiting` effect and `finalized_by: "recovery"`. Since both paths compare-and-set the same field of the same document, **MongoDB decides the winner and at most one transition takes effect.**

- **Writer wins** (the normal case). Recovery's filter no longer matches, it modifies nothing, and **that is a no-op and a success** — the obligation is finalized, which is all recovery wanted. It must not log an error, retry, or force the entry back to `pending`.
- **Recovery wins.** The writer's filter no longer matches. **The writer must not overwrite the finalized entry, and the reason is sharper than politeness: the event may already have been delivered.** Gu OS deduplicates on `event_id`, so a redelivery carrying corrected outcomes would be **silently dropped** by `source_events` uniqueness — leaving the producer believing it had sent a correction that Gu OS will never hold. Overwriting would manufacture exactly the kind of invisible divergence this record exists to prevent.

**The late real outcome is retained, and not as an event.** The losing writer appends its observation to a separate `late_outcome_observations` array on the appointment document, recording the `event_id`, what it actually observed, and when. Nothing is emitted. Two reasons that is the right size: the value is diagnostic, and a rising count is the signal that **the sweep's age threshold is mistuned** and is firing while writers are still working — which is the problem worth fixing, rather than the symptom worth broadcasting. **If consumers ever need corrections delivered, that is a new event kind and a new decision**, not something to smuggle in by mutating a delivered event.

**The invariant, stated so it can be tested:** *for one `event_id`, at most one finalization transition ever succeeds; a delivered event's outcomes and provenance never change afterwards.* `finalized_by` therefore always describes how the outcomes that were actually sent were arrived at.

#### 7D. What the guarantee is, exactly

**At-least-once delivery of every event whose obligation reached 7A, with outcome completeness that is either reported or explicitly marked unreported.** Not exactly-once: a crash mid-delivery re-delivers, which is what Gu OS's `source_events` uniqueness absorbs. **Not** an atomicity claim over the logical operation — the Calendar and Firestore effects are not transactional with anything, and this record does not pretend otherwise.

**What can still be lost is a mutation written by a path that bypasses the emission helper.** That is a **coverage** property, not a durability one, and the distinction is load-bearing: coverage is enumerable and testable, and **the emitting writers are enumerated in §5A** and mapped onto named seams in the R1 Technical Plan Appendix D.2 and D.5. It is enforced by a deterministic test asserting that no appointment write path in the emitting set constructs its update outside the helper — not by a runtime sweep, which cannot see what was never recorded. **Rev 5 makes that test writable for the first time**: until the emitting set was closed, the assertion had no denominator, and a coverage test whose population is undefined cannot fail for the right reason. The test's population is §5A's EMIT rows; its **drift guards** are the excluded and dead rows, which must stay non-emitting — so reviving a dead path, or quietly turning a bookkeeping write into a lifecycle one, fails coverage instead of silently narrowing it.

**The reconciliation sweep is therefore two narrow checks, both over named fields:** entries `pending` beyond a declared age (7C finalizes them), and entries `finalized` but undrained beyond a declared age (a **drain-liveness** alert). It is not a lost-event detector and is not described as one.

**No native-driver migration is required.** Rev 1 named moving off the Atlas Data API as the upgrade path; single-document atomicity closes the durability boundary without touching the driver, so that migration is not a prerequisite for C1 and is not proposed here.

### 7E. `integration_seq` is removed, because it raced and was not needed

Rev 2 put an `integration_seq` on the appointment document, `$inc`-ed in the same update, with the incremented value copied into the pending entry as `seq`. **That cannot be made correct client-side.** A read-then-increment-then-push sequence is not atomic as a unit: two concurrent updates can both read `5`, both stamp `seq: 6`, and both `$inc` — leaving the document at `7` with two entries claiming `6`. `$inc` is atomic; *knowing what it produced* is not, and nothing in the Atlas Data API returns the post-increment value in the same call as a `$push` that depends on it.

Rather than reach for a mechanism that would guarantee the relationship, **the dependence is removed**, because both jobs the counter was doing are already done better:

- **Drain liveness** does not need it. `pending_integration_events` *is* the outstanding work: a non-empty array beyond a declared age is the alert, and an empty array means everything drained. A counter pair adds a second source of truth that can disagree with the array.
- **Recording mutation order** does not need it either. **`$push` appends within the single-document update of 7A**, so for one appointment the array order *is* the canonical mutation order — established by MongoDB, precomputed by no client, and unracheable. That is a durable record, useful for operators and reconciliation.

#### 7F. Delivery order: the array records mutation order, and C1 does not deliver in it

**Rev 3 said the drain "preserves array order", and that claim does not survive contact with §7B.** Drainability is *finalized and unclaimed*, so an appointment can hold entry **A** still `pending` while a later entry **B** is already `finalized` — and B is then claimable and deliverable while A is not. Since only the prospect-side reschedule can be `pending` at all, this is exactly the case where it happens: a reschedule awaiting its Calendar outcome, followed by an advisor confirmation that finalizes in one write. **Append order therefore records mutation order; it does not establish delivery order, and rev 3 conflated the two.**

**The guarantee is removed rather than enforced, because no consumer requires it and enforcing it would cost liveness.** Head-of-line delivery per appointment — refusing to claim a later entry while an earlier one is unresolved — was the alternative, and it would mean one `pending` entry stalls every subsequent event for that appointment until the §7C sweep ages it out. That trades a stall for a property nothing asks for.

Repository evidence for *nothing asks for it*, since this is the kind of claim that should not rest on assertion:

- **No Gu OS consumer of `appointment_change` or `assignment_change` exists.** `source_events` has one live consumer, the admission pipeline, and it handles `inbound_prospect_message` only.
- **The inbox was never ordered.** `source_events` copies the `telegram_webhook_updates` pattern, which is a per-row insert-or-claim idempotency ledger keyed on the update id, with no entity-scoped queue and no sequence. Its guarantee is at-most-one active processing per row, not ordered delivery across rows.
- **The product specs treat these events as triggers, not as an ordered stream.** S1 §8.9 states progression is *not* a mandatory linear funnel and that Opportunities may move backward, hold multiple visits, and cancel or reschedule. S2 lists an appointment change and an assignment change among the things that *trigger a reconsideration*. S2 AC-04 makes duplicate delivery an idempotency requirement, which is the property C1 actually provides.

**So the non-claim, stated precisely:** *C1 delivers each event at least once and in no guaranteed order — not across appointments, not across entities, not across retries, and **not within one appointment**, because a later mutation can finalize before an earlier one does.*

**What a consumer should do with that is narrower than "last-writer-wins", and one ratified constraint bounds it.** `occurred_at` orders *mutations of one appointment*, and comparing it is the right way to tell a stale mutation from a current one. It does **not** resolve *disagreement between the two legacy stores*: S2 **EC-09** explicitly requires preserving uncertainty and provenance there and explicitly rejects "generic last-read/last-write truth". Those are different questions, and this record must not appear to license the second. Gu OS idempotency stays keyed on `event_id`, which needs no sequence and no order.

**Drain exclusivity, since removing the counter must not open a double-delivery hole.** A drain worker claims a finalized entry with a single `findOneAndUpdate` filtered on that entry being `finalized` and unclaimed, stamping `claim_id` and `claimed_at` through the positional operator — one document, one atomic operation, so two workers cannot claim the same entry. Delivery follows, then `$pull` by `event_id`. A crash between claim and `$pull` re-delivers after the claim expires, which is at-least-once and is the stated guarantee.

**One operational bound, named rather than discovered later.** Entries are pulled after delivery, so the array is normally near-empty; a prolonged drain outage grows it inside a document subject to MongoDB's 16 MB limit. Payloads are bounded and allowlisted (§3), so the ceiling is far above normal volume — but the liveness alert above exists to fire long before it, and a business write failing because its appointment document is full would be a much worse failure than a late event.

**Message ingress — covered by provider retry, conditional on one change.** Meta redelivers unacknowledged webhooks, so the ingress leg is already durable *provided the receiver acknowledges only after the durable record exists*. The audit records that the current webhook acknowledges receipt before downstream processing completes, so this is a requirement on the ingress seam and not a property it has today.

### 8. The Gu OS side

C1 needs two additive columns on `source_events`, because the table today has neither a producer event id distinct from the dedup key nor a business-occurrence time — it records only `received_at`:

- `occurred_at timestamptz null` — when the business mutation happened, as distinct from when Gu OS received it;
- `producer_event_id text null` — the `event_id` verbatim, so provenance survives independently of the derived `dedup_key`.

**Owner scope on the receiving side (rev 5).** The receiver validates the attested `legacy_owner_ref` of §3 against the key's server-side `ownerRefs` and **performs no per-event legacy read**. That is [ADR-111](ADR-111-legacy-service-auth-v1.md) §6.3b, which is **PROPOSED and not ratified**, so this paragraph specifies the receiver's obligation without authorizing it to be built. `source_events` needs no owner column: the check is made at admission against the key record, and the Organization continues to come only from that record.

Both are nullable and additive, so existing rows and the polling adapter are unaffected. The migration number is assigned at landing, never pre-reserved. Nothing here is implemented; the receiving route, the ADR-111 verifier and these columns are SL-5's work and are not started before ratification.

### 12. What rev 5 deliberately did not change

The repair was bounded on purpose, and this section exists so a reviewer can check the boundary rather than infer it. **Every mechanism below survives rev 5 untouched**, and if any accepted decision had forced one of them to move, that would have exceeded a precision repair and the record would have gone back to the Accountable instead:

one logical `event_id` per mutation · the separation of entity identity from event identity · at-least-once delivery, not exactly-once · the producer-side durable obligation before any delivery attempt · `integration_events` as the delivery ledger rather than the appointment durability boundary · the `pending` / `finalized` two-state readiness model · §7C recovery · `unknown` as a third outcome state that is neither *no effect* nor *failed* · §7C-bis conditional single-winner finalization · the absence of a sequence counter (§7E) · the absence of any delivery-order guarantee, including within one appointment (§7F) · drain claim and retry semantics · `late_outcome_observations` · and the distinction between coverage and durability.

**What rev 5 changed is narrower than that list**: a quantifier (§7A), an identity rule that was stated as an observation and is now a normative obligation (§5), a placement mechanism that did not exist at most writers (§7), an enumeration that was incomplete and partly unreachable (§5A), and one new envelope field that another record must ratify (§3).

## Consequences

- C1 becomes implementable by the other team once this and [ADR-111](ADR-111-legacy-service-auth-v1.md) are ratified. Until then it is specified, not executable. **At rev 5 this is the live constraint rather than a formality**: ADR-112 is repaired and governing, while [ADR-111](ADR-111-legacy-service-auth-v1.md) §6.3b — which authorizes the owner-scope model §3's `legacy_owner_ref` depends on — is **PROPOSED and awaiting a separate security review and explicit re-ratification**. C1 is therefore **not yet implementable end to end**, and the gap is one governed security decision, not a specification gap.
- **The emitting set is now part of the contract** (§5A). Rev 4 left it unstated, which meant §7D's coverage guarantee had no population to quantify over. Naming it costs an enumeration that must be maintained against source; not naming it cost a test that could not be written.
- **`bots/main` is excluded from the first Alebrixe pilot emitting set on an evidence limit, not a safety finding**, and carries a drift guard plus a hard hosted-evidence precondition (§5A). Nothing in this record asserts that Alebrixe cannot reach it.
- Traditional Gu gains one new table, a drain/retry bridge, and an emission call inside each mutation family. Because thirteen assignment writers and fourteen appointment writers have no common seam, the realistic path is a shared emission helper per runtime; the concrete placement is in the R1 Technical Plan's implementation map, which names the two writers that will still bypass any per-lead helper (a bulk reassignment on advisor offboarding, and a lead re-keying job that mutates assignment by recreating documents).
- Gu OS gains two nullable columns and, later, the ingestion route. The `source_events` CHECK constraint and dedup uniqueness are unchanged, which is what lets the polling adapter and the webhook coexist.
- **The guarantee is at-least-once in both stores, by two different mechanisms** (§7): a multi-document transaction for assignment, single-document atomicity for appointments. It is **not** exactly-once, and duplicate delivery is expected and absorbed by `source_events` uniqueness. The residual risk is **coverage** — a writer that bypasses the emission helper — which is enumerable against the writers named in the implementation map and enforced by a deterministic test, not by a runtime sweep that cannot see what was never recorded.
- **Durability and completeness are separate properties, and the drain respects both** (§7A/§7B). An appointment event is durable the instant its canonical mutation commits, and deliverable only once its Calendar and Firestore outcomes are resolved or explicitly marked `unknown`. Thirteen of the fourteen writers reach both boundaries in one write; the one that does not already has a second write to carry it.
- **Gu OS consumers must handle `unknown` as a third state.** It is neither *no effect* nor *failed*, and flattening it into either reintroduces the orphaned-Calendar blindness this contract removes. That is a small but real obligation on SL-5 and SL-10.
- **Two earlier drafts of this record were wrong in the same area, in opposite directions, and both corrections are kept rather than quietly replaced.** Rev 1 claimed at-least-once from a mechanism that could not provide it, having asked for the wrong atomicity. Rev 2 fixed that and then over-claimed the atomicity it had found, treating a durable obligation as a deliverable event. The failure modes are different — rev 1 would have dropped events silently, rev 2 would have delivered confident falsehoods about Calendar and Firestore — and both are the class of thing this record exists to prevent, which is why the history stays visible.
- **No sequence number is part of the contract** (§7E), and **no delivery-order guarantee either, including within one appointment** (§7F). The pending array records canonical mutation order durably, which is a producer-side and operator-facing property; consumers get at-least-once delivery in no order, must stay idempotent on `event_id`, and compare `occurred_at` to tell a stale mutation from a current one — while store disagreement remains governed by S2 EC-09, not by timestamp.
- **Exactly one finalization transition per event ever succeeds** (§7B/§7C-bis), enforced by a conditional single-document compare-and-set rather than by ordering the writer and the sweep. A delivered event's outcomes and provenance never change afterwards, which is what makes `finalized_by` trustworthy. The cost is that a late real outcome after a recovery finalization is kept as diagnostics rather than delivered; treating it otherwise would require a new event kind and a new decision.
- Assignment-selection policy, the legacy role vocabulary and the Mongo/Firestore appointment model are all left where they are. This record consumes their results; it does not migrate or normalize them.

## Reevaluate when

- An appointment mutation **in the emitting set** stops being a write to exactly one document, which is the property §7A's durability rests on. *(Scoped at rev 5: the universal form of this trigger had already fired unnoticed, because the bulk reminder writers were never single-document.)*
- **A bulk or multi-document writer enters the emitting set** (§5A). That is the precise condition under which §7A's premise stops holding by construction, and the answer is a fan-out or an exclusion — not a weaker premise.
- **A path currently recorded as dead or excluded acquires a caller**, or a bookkeeping field starts carrying a lifecycle meaning. The drift guards exist to make this fail loudly; the record is what they are checked against.
- **`bots/main` scope becomes provable, or Alebrixe's runtime routing changes.** The first-pilot exclusion rests on an evidence limit, so new evidence is a reason to revisit it rather than to keep the exclusion by habit.
- **A writer's store ordering changes** so that a path which currently reaches §7B in one write no longer does — the §7B table is pinned to `ungga-full` @ `gcp/main` and is an observation, not a guarantee the other team owes us. The two-state mechanism is normative precisely so that such a change degrades into an extra finalization write rather than into fabricated outcomes.
- **`unknown` outcomes stop being rare.** A rising rate is a signal that processes are dying between §7A and §7B, and the answer is to find out why rather than to widen what recovery is allowed to assume.
- Event volume makes one-event-per-request wasteful, at which point a batch form with per-event disposition is the additive change.
- Ownership of leads or appointments moves into Gu OS, at which point the transitional source precedence these events assume no longer holds and the affected kinds should be retired rather than reinterpreted.
- A fifth event kind is needed: the kind vocabulary is a database constraint on the Gu OS side, so adding one is a migration and a contract change, deliberately not a convention.
