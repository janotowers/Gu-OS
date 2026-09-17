# ADR-112 — Cross-repo integration events: stable event identity and durable publication

**Status:** Proposed (**rev 2**) — awaiting human ratification. Nothing in this record is an architectural constraint yet.
**Date:** 2026-09-17
**Revision history:** **rev 2 (2026-09-17)** — the **appointment durability guarantee was unsupported by its own mechanism** and is corrected, with the architecture direction unchanged. Rev 1 concluded that the Atlas Data API's lack of multi-document transactions forced a sequential business-write-then-record, named the resulting process-death window, and then still called the result *at-least-once with a reconciliation backstop* — which that mechanism cannot provide, since a mutation lost in that window leaves no record anywhere that an event was owed. It had asked for the wrong atomicity: every appointment mutation is a write to **exactly one document**, and Mongo is atomic at the single document even through the Data API, so the obligation is now recorded **inside the appointment document** atomically with the business write. At-least-once is therefore earned rather than asserted; the residual risk is reclassified from durability to **coverage**; the reconciliation sweep is retained with its purpose corrected to **drain liveness** and its comparands named (`pending_integration_events` age, `integration_seq` against `last_emitted_seq`) instead of an unspecified last-modified field; and the native-driver migration is **no longer a prerequisite** (§7, Consequences). A stale `§4` cross-reference in §2 was repaired to `§5`.
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
  "legacy_owner_ref": "<organization principal ref>",
  "advisor_role_semantic": "advisor | principal | unknown"
}
```

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
    { "store": "mongo", "outcome": "written | deleted | failed | not_attempted" },
    { "store": "firestore", "outcome": "written | deleted | failed | not_attempted" }
  ],
  "calendar_effect": { "google_event_id": "<id> | null", "operation": "created | updated | deleted | none" },
  "status_after": { "status": "...", "appointment_status": "...", "owner_appointment_status": "..." },
  "scheduled_for": { "date": "...", "hour": "...", "front_date": "...", "front_hour": "..." }
}
```

**`appointment_ref` is the legacy appointment business key, not the Mongo `_id`.** Every writer queries on that business key, and it is a UUID minted once at creation. The `_id` is incidental.

**`appointment_ref` is not `event_id`.** One appointment experiences creation, reschedule, confirmation, cancellation and status transitions; each is its own event with its own `event_id`. The business key is stable across all of them — a reschedule is an in-place update, never a new record — which is precisely why it cannot identify one of them.

**`store_write_outcomes` states which stores actually changed, per event.** This is not bookkeeping: nine of fourteen appointment writers touch Mongo only, so the advisor-facing lifecycle — confirmation, advisor-side reschedule, reminder outcomes, the post-visit survey — never reaches Firestore at all. An event that implied both stores changed would be false most of the time. Cancellation is the sharpest case: the Firestore document is **deleted** while Mongo keeps a tombstone, so after a cancellation the two stores no longer describe the same set of appointments.

**A Firestore-only writer must not be represented as a change to the canonical record.** If a mutation path updates only Firestore, `store_write_outcomes` says so and `status_after` reports only what that path actually set.

**`calendar_effect` is preserved as effect evidence**, because a Calendar event can exist while persistence fails — the orphan risk the audit describes at §11.4. Note that the calendar event id can change across a reschedule even though the appointment key does not.

**C1 is not the project that normalizes the legacy appointment model.** The divergence between the two stores stays visible and is never silently reconciled. Which representation binds when they disagree remains an open question owned by the R1 Technical Plan, and this record does not answer it.

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
- **The row is not always where the obligation first becomes durable, and §7 is what decides that per store.** For assignment the row is written inside the business Firestore transaction. For appointments the obligation is first recorded inside the appointment document itself, atomically with the business write, and the drain promotes it into this table; the table is then the delivery ledger rather than the durability boundary. Either way, no path attempts delivery before the obligation is durable somewhere.
- **Gu OS `source_events` remains a second, independent idempotency boundary.** Its `unique (organization_id, dedup_key)` protects Gu OS from duplicate delivery. It is not a substitute for producer-side durability: it can only deduplicate events that arrive.
- **This is not an event-sourcing platform.** It is one table, four event kinds, and a drain loop. No projections, no replay-as-truth, no generic event bus.

### 7. Atomicity, stated honestly per store

Cross-database atomicity is not invented anywhere. Where a business mutation and its integration record can be persisted in one native transaction, they are; where they cannot, the residual window is named and given a bounded recovery mechanism.

**Assignment mutations — atomic, achievable today.** The authoritative assignment write is Firestore, and the codebase already demonstrates a working `runTransaction` read-then-conditional-write. The integration record is written **inside the same Firestore transaction** as the assignment write. Placing it at an organization-scoped path makes `legacy_scope` structural rather than a supplied value. The separate Mongo mirror write stays non-atomic, but the event describes the assignment decision, which Firestore owns.

**Appointment mutations — atomic at the document, which is enough, and this record's earlier draft got it wrong.** A *separate* Mongo outbox collection cannot be transactional with the business write today: the TypeScript services reach Mongo through the **Atlas Data API**, which is stateless HTTP and cannot participate in a multi-document transaction at all, and while the Python runtime's PyMongo could in principle open a session, **no session or transaction usage exists anywhere in the repository**, so that capability is unproven rather than available.

The earlier draft concluded from this that the business write and the integration record must be sequential, named the resulting process-death window, and then called the result *at-least-once with a reconciliation backstop*. **That claim was not supported by that mechanism** — a mutation lost in that window leaves no record anywhere that an event was owed, so nothing downstream can be at-least-once about it. The conclusion was also unnecessary, because it asked for the wrong atomicity:

> **Every appointment mutation is a write to exactly one appointment document, and MongoDB is atomic at the single document — including through the Atlas Data API.**

So the event obligation is made durable **at mutation time** by writing it **into the appointment document itself**, in the same update as the business change:

```
appointments/<doc>
  ...business fields...
  integration_seq          -- $inc by 1 in the same update; monotonic per appointment
  pending_integration_events: [        -- $push in the same update
    { event_id, event_kind, operation, occurred_at, seq, payload }
  ]
```

One `updateOne` (or the insert, at creation) carries both. There is no window: either the business change and its pending event both exist, or neither does. The drain then copies each pending entry into `integration_events`, delivers it, and `$pull`s it by `event_id`, recording the drained `seq` as `last_emitted_seq` on the document. **A crash anywhere in the drain re-delivers rather than loses**, which is what at-least-once means and is exactly what Gu OS's `source_events` uniqueness absorbs.

**So the guarantee is at-least-once, and it is now earned rather than asserted** — for every mutation that goes through the shared emission helper. **What can still be lost is a mutation written by a path that bypasses the helper**, and that is a **coverage** property, not a durability one. The difference matters: coverage is enumerable and testable, and the fourteen appointment writers are named in the R1 Technical Plan Appendix D.2. It is enforced where such things belong — a deterministic test asserting that no appointment write path constructs its update outside the helper — rather than by a runtime sweep that cannot see what was never recorded.

**The reconciliation sweep is retained with its purpose corrected.** It is a **drain-liveness** check, not a lost-event detector, and it compares named durable fields rather than an unspecified last-modified: it finds documents whose `pending_integration_events` is non-empty beyond a declared age, or whose `integration_seq` exceeds `last_emitted_seq` beyond that age, and alerts. **It cannot detect a mutation by a writer that maintained neither field**, and this record says so rather than implying a backstop that does not exist.

**No native-driver migration is required.** The earlier draft named moving off the Atlas Data API as the upgrade path that would close the window; single-document atomicity closes it without touching the driver, so that migration is not a prerequisite for C1 and is not proposed here.

**Message ingress — covered by provider retry, conditional on one change.** Meta redelivers unacknowledged webhooks, so the ingress leg is already durable *provided the receiver acknowledges only after the durable record exists*. The audit records that the current webhook acknowledges receipt before downstream processing completes, so this is a requirement on the ingress seam and not a property it has today.

### 8. The Gu OS side

C1 needs two additive columns on `source_events`, because the table today has neither a producer event id distinct from the dedup key nor a business-occurrence time — it records only `received_at`:

- `occurred_at timestamptz null` — when the business mutation happened, as distinct from when Gu OS received it;
- `producer_event_id text null` — the `event_id` verbatim, so provenance survives independently of the derived `dedup_key`.

Both are nullable and additive, so existing rows and the polling adapter are unaffected. The migration number is assigned at landing, never pre-reserved. Nothing here is implemented; the receiving route, the ADR-111 verifier and these columns are SL-5's work and are not started before ratification.

## Consequences

- C1 becomes implementable by the other team once this and [ADR-111](ADR-111-legacy-service-auth-v1.md) are ratified. Until then it is specified, not executable.
- Traditional Gu gains one new table, a drain/retry bridge, and an emission call inside each mutation family. Because thirteen assignment writers and fourteen appointment writers have no common seam, the realistic path is a shared emission helper per runtime; the concrete placement is in the R1 Technical Plan's implementation map, which names the two writers that will still bypass any per-lead helper (a bulk reassignment on advisor offboarding, and a lead re-keying job that mutates assignment by recreating documents).
- Gu OS gains two nullable columns and, later, the ingestion route. The `source_events` CHECK constraint and dedup uniqueness are unchanged, which is what lets the polling adapter and the webhook coexist.
- **The guarantee is at-least-once in both stores, by two different mechanisms** (§7): a multi-document transaction for assignment, single-document atomicity for appointments. It is **not** exactly-once, and duplicate delivery is expected and absorbed by `source_events` uniqueness. The residual risk is **coverage** — a writer that bypasses the emission helper — which is enumerable against the writers named in the implementation map and enforced by a deterministic test, not by a runtime sweep that cannot see what was never recorded.
- **An earlier draft of this record claimed at-least-once from a mechanism that could not provide it**, having concluded that the Atlas Data API's lack of multi-document transactions forced a sequential write-then-record with a real loss window. It asked for the wrong atomicity. The correction is recorded in §7 rather than quietly replaced, because the failure mode it would have shipped — a silently missing appointment event, with nothing anywhere recording that one was owed — is exactly the one this record exists to prevent.
- Assignment-selection policy, the legacy role vocabulary and the Mongo/Firestore appointment model are all left where they are. This record consumes their results; it does not migrate or normalize them.

## Reevaluate when

- An appointment mutation stops being a write to exactly one document, which is the property §7's durability rests on.
- Event volume makes one-event-per-request wasteful, at which point a batch form with per-event disposition is the additive change.
- Ownership of leads or appointments moves into Gu OS, at which point the transitional source precedence these events assume no longer holds and the affected kinds should be retired rather than reinterpreted.
- A fifth event kind is needed: the kind vocabulary is a database constraint on the Gu OS side, so adding one is a migration and a contract change, deliberately not a convention.
