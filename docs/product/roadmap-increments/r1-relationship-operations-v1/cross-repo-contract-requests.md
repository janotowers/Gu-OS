# R1 — cross-repo contract requests to the Traditional Gu team (C1, C2, C6)

> **Status:** Reference — **this document owns no truth.** Every requirement below is derived from the artifact named in its own *Owned by* line, and if the two ever disagree the owning artifact wins. It exists because nothing else in this repository is addressed to the other team.
> **Owner:** engineering owner (R1)
> **Roadmap Increment:** R1 — Relationship Operations v1 — [`slice-plan.md`](slice-plan.md), [`technical-plan.md`](technical-plan.md)
> **Created:** 2026-09-16, as the outcome of the Development Continuity Loop after SL-14 closed and the READY Horizon emptied ([`slice-plan.md`](slice-plan.md) §1)
> **Revised:** 2026-09-17 (**v0.3**) against the contract-precision pass and the pre-ratification review that followed it — Technical Plan **v1.20**, [`ADR-111`](../../../adr/ADR-111-legacy-service-auth-v1.md) **rev 2**, [`ADR-112`](../../../adr/ADR-112-cross-repo-integration-events.md) **rev 2**, [`legacy-source-audit.md`](legacy-source-audit.md) §24. The ask is unchanged in substance and much more precise in detail. **Five statements in earlier drafts were wrong or stale and are corrected in place, each marked *Corrected 2026-09-17*** — including one this document got wrong about appointment identity, and one where the durability guarantee was stronger than its mechanism could support.
> **Not an approval of anything.** It requests work owned by another team and records the joint decisions that must be settled before that work can start. It ratifies no architecture, moves no bar, and changes no Slice contract.

## 1. Why this exists

**Every remaining R1 Slice waits on C1, C2 or C6.** SL-14 closed SL-4's carry-forward finding and nothing depended on it, so its closure moved no dependency fact. Readiness work cannot advance a single candidate: SL-5 waits on C1, SL-6 on C2 advisory, SL-9 on the C6 hard gate, and SL-8, SL-8b and SL-13 wait behind those three ([`slice-plan.md`](slice-plan.md) §1, §3).

These three contracts are **owned by the Traditional Gu team, not by this one.** Advancing them is a human action across a team boundary. What this team can do — and what this document is — is state the ask precisely enough that it can be acted on, and name the decisions that block the ask itself.

**The Gu OS half of each contract is this team's work and is not requested here.** SL-5 builds the event receiver, SL-6 the authority resolver and endpoint, SL-9 the adapter switch. None of them is READY, and none can be made READY by building them: a receiver with nothing forwarding to it proves nothing, which is exactly why these are cross-repo contracts rather than internal work.

**What changed on 2026-09-17, and why it matters to the reader of this document.** A read-only revalidation against `UnggaMX/ungga-full` @ `gcp/main` `3fdb16ca` and `UnggaMX/ungga-landing` @ `main` `ce60cb22` turned the ask from a description into a specification. **No legacy, staging or production system was modified; every operation was a read.** The findings are in [`legacy-source-audit.md`](legacy-source-audit.md) §24, the two consequential decisions became ADR-111 and ADR-112, and [`technical-plan.md`](technical-plan.md) **Appendix D** maps them onto named seams in your repositories so that ratification is followed by implementation rather than by another discovery round.

## 2. Contract lifecycle — where each one actually stands

**Owned by** [`technical-plan.md`](technical-plan.md) §4. Reproduced here because "blocked on C1" means nothing without knowing which step is blocked, and because collapsing these into *done* is how one team ends up believing the other has shipped.

A contract passes through: **discovered → specified → ratified → Traditional Gu implementation planned → Traditional Gu implementation landed → Gu OS integration landed → hosted/production evidence completed.**

| Contract | State as of 2026-09-17 | The single next step |
|---|---|---|
| **TD-13** (`LegacyServiceAuth` v1) | **specified** — [ADR-111](../../../adr/ADR-111-legacy-service-auth-v1.md) **rev 2**, Proposed | human ratification (§3, decision **A**) |
| **C1** (event forwarding) | **specified** — [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) **rev 2**, Proposed | human ratification (§3, decision **B**), plus TD-13 |
| **C2** (authority-aware routing) | **specified**, advisory scope only | TD-13 ratification |
| **C6** (bounded legacy reads) | **specified**; payloads implementable now, **authentication not** | TD-13 ratification for the authenticated path |

**No Traditional Gu implementation of any of the three exists**, and nothing in this document should be read as claiming otherwise. **No Gu OS integration exists either**: the `api/legacy` route tree, the ADR-111 verifier and the `source_events` columns C1 needs are all SL-5 and SL-6 work that has not started.

## 3. The decisions that block the ask

Three, and no more. Everything else this pass raised was answerable from the repositories and was answered there. All three are recorded in [`slice-plan.md`](slice-plan.md) §8, which owns them.

**A. Ratify TD-13 `LegacyServiceAuth` v1** — [`slice-plan.md`](slice-plan.md) §8 **Q14**, specified in [ADR-111](../../../adr/ADR-111-legacy-service-auth-v1.md).

The mechanism is unchanged from TD-13: per-service, per-purpose HMAC-SHA256. What ADR-111 adds is the precision that lets two teams in three languages implement it without talking — the canonical signing string and its exact separators, path and query canonicalization, raw-body hashing, signature encoding, duplicate and malformed header behavior, skew, and two-key overlapping rotation. **The security substance is the key binding:** `key_id` resolves service, purpose, Gu OS Organization and permitted legacy owner scope **server-side**, so a valid signature buys authentication and nothing else. An Organization claim in a signed payload is at most a consistency check, never authority.

**It gates C1 and C2 together, and C6's authenticated path as well.** *Corrected 2026-09-17:* v0.1 of this document said TD-13 *"does not gate C6's payload shapes, which are already code."* The first half is true and the sentence as a whole was misleading — C6 runs Gu OS → Traditional Gu, ADR-111 §9 adds the **`legacy-read`** purpose for exactly that direction, and a bounded read API without authentication is not a boundary. C6's payloads can be built before ratification; C6 cannot be *used* before it.

**B. Ratify the C1 integration-event architecture** — [`slice-plan.md`](slice-plan.md) §8 **Q15**, specified in [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md). Two decisions: **entity identity is not event identity**, and **publication must be durable on the producer side**. Both are detailed in §5 below, because they change what you would build.

**C. Name who provisions and rotates the keys** — [`slice-plan.md`](slice-plan.md) §8 **Q16**. Repository evidence establishes the *mechanism* on both sides and not the *accountable owner* of a key spanning both estates. **Deferred behind A on 2026-09-17, with the shape settled and the name left open:** one accountable owner across the two estates, with local custodians and implementers permitted on each side. Deliberately not a secrets-management redesign. **No secret value was inspected or recorded anywhere in this work.**

## 4. C6 — bounded legacy read APIs

> **Owned by** [`technical-plan.md`](technical-plan.md) TD-5 and §4 (row C6), with the authenticated path owned by [ADR-111](../../../adr/ADR-111-legacy-service-auth-v1.md). **Gate:** hard, before SL-9 — *no production risk-waiver path*. **Unblocks:** SL-9, and through it SL-10, SL-11 and SL-13. **Implementation map:** [`technical-plan.md`](technical-plan.md) Appendix D.4.

**This is the most actionable of the three, because Gu OS can hand over an exact contract today rather than a description of one.** The four capabilities are a closed vocabulary in `packages/types/src/legacy-gateway.ts`, their normalized response shapes are typed there, and the fixtures under `apps/web/src/lib/legacy-gateway/fixtures/` are the regression baseline SL-1's evidence was produced against. A C6 endpoint is correct when it returns those shapes.

**The request — four bounded, organization-scoped read endpoints**, semantically equivalent to what the bootstrap adapters read today. The names are Gu OS's internal capability names (`LEGACY_GATEWAY_CAPABILITIES`), **not a required URL shape**.

| Gu OS capability | Must preserve | Why, and where it comes from |
|---|---|---|
| `legacy_lead_get_context` | the normalized lead shape with provenance and freshness, **composed across both stores** — see below | SL-1's delivered contract; the adapter behind it becomes `legacy_read_api` instead of `bootstrap_direct`, and that value is recorded per result |
| `legacy_lead_get_recent_messages` | **thread awareness** — the Gu thread and `asesor_*` threads kept distinct — with `source`, the provider message id and `delivery_status` **per message** | [`legacy-source-audit.md`](legacy-source-audit.md) §10.1 (multi-thread conversations) and §15.7 (delivery writeback); SL-9 reconciles sends against this |
| `appointment_get` | **both representations, with divergence visible** — see below | [`legacy-source-audit.md`](legacy-source-audit.md) §11.3, §24.3 |
| `property_get_details` | the normalized property shape | SL-1's delivered contract |

**Source precedence, recorded as a transitional fact about your system and not as a Gu OS invariant.** Mongo `gu2.appointments` is the **current primary operational representation** for appointments; the Firestore deal appointment is a **secondary/replicated** representation that may carry additional effect evidence. Divergence remains observable and is **never silently reconciled**. This precedence is transitional and may change if appointment ownership migrates to Gu OS.

**Lead context must compose, not choose.** Mongo is the more complete source for substantive lead data where both stores hold equivalent information — **but it is not a superset of Firestore.** Firestore carries operational assignment and ownership semantics (`assigned`, `assignedTo`, `assigned_at`, `assignment_type`, `assignation_type`, `new_assignment`, organization containment, advisor references, conversation structures) that are **not projected 1:1** into the Mongo `users` document, which in existing assignment flows instead carries fields like `owner_phone_number` and `owner_name`. So the response composes Mongo substantive data with Firestore assignment/ownership metadata, **with per-field provenance preserved**, and no read may discard Firestore assignment state on the grounds that Mongo is the preferred lead source. The real source model is asymmetric and capability-specific; *lead → Mongo, everything else → Firestore* is not a correct simplification of it.

**Appointments return both representations, never a fabricated single truth** — per-store presence and absence, per-store provenance, an explicit list of disagreements, and Firestore-specific effect evidence where present. *Corrected 2026-09-17:* Gu OS had assumed the Google Calendar identifier was **Firestore-only**. It is written by the legacy appointment creators to **both** stores (audit §24.3). That assumption was a live defect on our side — the Mongo normalizer discarded the field, blinding the orphaned-Calendar-effect check on the store that is actually canonical — and it is **repaired here** with fixture and selftest coverage. It is named because it would have produced a C6 response that looked clean and was wrong.

**Appointment persistence is currently partial and distributed, and the response must not hide that** to look tidier. Refusing or pairing explicitly is the correct behavior; guessing is not.

**What C6 landing actually retires**, and why the gate has no waiver: today Gu OS reads Traditional Gu's stores directly, under the `traditional_gu_firestore` and `traditional_gu_mongo` credentials recorded in [`sl1-legacy-read-credentials.md`](sl1-legacy-read-credentials.md). That is acceptable while every stage is shadow. SL-9 is the first stage that produces a prospect-facing external effect, and reading a broad project credential to decide an effect is the boundary TD-5 refuses to waive. **C6 is therefore not a performance or tidiness change — it is the condition under which Gu OS stops holding read access it should not hold once it can act.** **That transition is not claimed until it happens**: it requires C6 implemented on your side *and* the broad access removed on ours, under SL-9.

**Not C6, and worth saying so explicitly:** the Mongo lead runtime fields (`bypass_bot`, the assignment mirror) are **not** a read API. They arrive as C1 events and are consumed by C2. Asking for them here would build the wrong thing. Equally: this must stay **capability-bounded**. Generic collection access, or a generic Firestore/Mongo pass-through, is not a smaller version of C6 — it is the thing C6 exists to avoid.

## 5. C1 — event forwarding

> **Owned by** [`technical-plan.md`](technical-plan.md) TD-5 and §4 (row C1), and by [ADR-112](../../../adr/ADR-112-cross-repo-integration-events.md) for identity, envelope and durability. **Gate:** hard for SL-5. **Unblocks:** SL-5, and through it SL-8 and SL-8b. **Interim fallback in place:** the gateway polling adapter (AC-1 §6.7), which is why shadow Slices SL-2 … SL-4 could close without it. **Implementation map:** [`technical-plan.md`](technical-plan.md) Appendix D.2.

**The receiving side is already built and already in use, which makes the payload contract cheap to specify.** `source_events` exists, with `UNIQUE (organization_id, dedup_key)`, and the four event kinds are a database `CHECK` constraint, not a convention: `inbound_prospect_message`, `advisor_activity`, `appointment_change`, `assignment_change` (`packages/types/src/source-events.ts`). The polling adapter writes those same rows today. **C1 changes the writer, not the table.**

**The request — POST the four event classes to `/api/legacy/events`**, signed per ADR-111 with an `events-ingest` key.

| Event kind | Legacy source | Reference |
|---|---|---|
| `inbound_prospect_message` | the inbound webhook ingress | audit §7.1–§7.2, §24.6 |
| `advisor_activity` | **same-thread** owner/advisor takeover only | audit §8.1–§8.4, §9, §24.6 |
| `appointment_change` | the appointment lifecycle writers | audit §11.3, §24.3 |
| `assignment_change` | **all** assignment writers — see below | audit §6.1–§6.3, §24.4 |

*Corrected 2026-09-17:* v0.1 named `assignment_change`'s source as *"sticky assignment — `/guard-lead-one`"*. **That endpoint is one writer among thirteen** (audit §24.4). The others include both carrusel implementations, the property-driven and property-carrusel paths, explicit/manual assignment, principal-parking backfill, lead creation, an advisor-offboarding cascade that reassigns in bulk, and a re-keying job that changes assignment by **recreating documents** rather than updating a field. There is no shared assignment service, no Firestore trigger, no change stream, and the one helper that would have propagated advisor changes has **every call site commented out**. Emitting from `/guard-lead-one` alone would have produced an event stream that looked healthy and was mostly empty.

### 5.1 Event identity — the part that must be agreed, not assumed

**Entity identity is not event identity.** An entity id says *what* changed; an event id says *which mutation* happened.

- **`inbound_prospect_message`** — use the **provider (Meta) message id**. It is a durable logical message identity the provider already supplies, it is available at ingress, and inventing a UUID beside it would be strictly worse. *(It is currently available at ingress and persisted nowhere, which is why emitting at ingress is both the cheapest and the only reliable point.)*
- **Same-thread advisor activity** — the provider/echo message id where one exists.
- **`assignment_change` and `appointment_change`** — a stable `event_id` minted **once** for the logical mutation and **reused across every retry and delivery attempt**. Explicitly **not** the entity id, not `assigned_at`, not a database update timestamp, and not request arrival time. One appointment legitimately has many logical events — creation, reschedule, confirmation, cancellation, status transition — and identifying them by the entity collapses them into one.
  - *Corrected 2026-09-17:* an earlier draft of this section called the Mongo `_id` the canonical appointment entity identity. **It is not.** The event-facing entity identity is the **client-minted `appointment_id` business key** — the UUID created once at creation that every writer actually queries on — and the `_id` is incidental. ADR-112 §5 has this right; this document did not.

Gu OS derives its dedup key as `<sourceSystem>:<eventKind>:<externalRef>:<discriminator>` through `buildSourceEventDedupKey`, which lives in the shared types package *specifically* so the polling adapter and the C1 webhook cannot drift apart. **The `event_id` above is that discriminator.**

### 5.2 Normalized `assignment_change`

Treat assignment as **three concerns, not one**: organization membership and advisor eligibility; the legacy policy that chooses an advisor; and the resulting durable lead → advisor assignment. **C1 does not reproduce your assignment algorithms.** Traditional Gu remains the owner of assignment-selection policy in this phase, and Gu OS consumes the resulting semantic event.

Carry, where available: the stable `event_id`; the lead ref; the assigned advisor ref; the **previous** advisor ref *when it is genuinely known*; the semantic operation (`assignment` / `reassignment` / `unassignment`); the legacy policy provenance (`assignment_type` / `assignation_type` and the writer) when useful; `occurred_at`; and source provenance.

**Preserve absence rather than fabricating it.** Most writers do not read the previous assignee before overwriting it, so it is not reconstructable for them — the offboarding cascade is the clear exception, since the previous assignee is its query key. A field that is *sometimes* a guess is worse than a field that is sometimes null.

**Do not infer current assignment** from the Mongo owner name, the owner phone number, or a single `role_user` literal. On roles: the legacy vocabulary includes at least `vendedor`, `seller`, `admin` and `super-admin`, with different paths using different literals for the same concept. **Normalize the semantic role at the integration boundary** rather than propagating inconsistent literals into a durable contract — and note that `role_user == vendedor` is not by itself the eligibility rule, since existing logic also weighs organization membership and status. Carrusel is documented as **round-robin with legacy eligibility behavior** — ordered sellers, an order counter, wrap-around, skipping ineligible sellers — not as pure round-robin.

### 5.3 Normalized `appointment_change`

The **`appointment_id` business key** — client-minted at creation, stable for the appointment's whole life, and what every writer queries on — is the entity identity. The Mongo `_id` is incidental and is not the contract. Each logical mutation gets its own `event_id` (§5.1). Where a mutation also produces Firestore effects or replica changes, carry those as **secondary provenance/effect evidence**. Where a writer touches **only** Firestore, say so explicitly rather than implying the canonical Mongo appointment changed. **C1 is not the project in which the legacy appointment model is normalized**, and nothing here asks you to reconcile the two stores.

### 5.4 Durable publication — the one architectural ask

**A business mutation followed by a best-effort HTTP POST is not sufficient**, and this is the part of C1 that is a design ask rather than a wiring ask. The write commits, the process dies, and the event is never delivered — with nothing anywhere recording that it was owed.

So: **persist a durable integration record before attempting delivery**, and have the bridge drain it. The smallest useful record carries the `event_id`, event kind, external/entity ref, `occurred_at`, a **server-derived** organization/legacy scope (never caller-supplied), the bounded payload, provenance, delivery state, attempts, and last attempt/error. **This is not an event-sourcing platform and is not a request to become one** — one table, four event kinds, a drain loop. No projections, no replay-as-truth, no generic bus.

**Existing Pub/Sub may carry the delivery leg *after* the durable record exists; it cannot replace it.** Both main consumers acknowledge before doing the work, and one dead-letter topic has no subscription (audit §24.7), so Pub/Sub does not close the mutation-to-publish window — it moves it.

**Atomicity, stated per store rather than averaged:**

- **Assignment — atomic, achievable today.** The authoritative write is Firestore, `runTransaction` is already used in the codebase, and the integration record goes **inside the same transaction**. Writing it at an organization-scoped path makes the scope structural rather than a supplied value.
- **Appointments — atomic at the document, which turns out to be enough.** A *separate* Mongo outbox collection cannot be transactional with the business write: the Atlas Data API is stateless HTTP and cannot join a multi-document transaction, and no session or transaction usage exists anywhere in the repository. But **every appointment mutation is a write to exactly one appointment document, and Mongo is atomic at the single document, including through the Data API.** So the obligation is recorded **inside the appointment document**, in the same update as the business change — an `integration_seq` incremented and a `pending_integration_events` entry pushed — and the drain promotes it, delivers it, and pulls it. **There is no window:** either the change and its pending event both exist, or neither does. A crash re-delivers rather than loses.
  - **What can still be lost is a mutation written by a path that bypasses the emission helper.** That is a **coverage** property, not a durability one — enumerable against the fourteen named appointment writers and enforced by a test, not by a sweep that cannot see what was never recorded. The reconciliation sweep is kept as a **drain-liveness** check, comparing `pending_integration_events` age and `integration_seq` against `last_emitted_seq`; it is not a lost-event detector and is not described as one.
  - *Corrected 2026-09-17:* an earlier draft named a real process-death window here and then called the result *at-least-once with a reconciliation backstop*. **That mechanism could not have provided it** — a mutation lost in that window leaves no record anywhere that an event was owed. The correction is the single-document marker above. **The guarantee is at-least-once, not exactly-once**, and duplicate delivery is expected and absorbed by `source_events` uniqueness.
- **Message ingress — covered by provider retry, conditional on one change.** Meta redelivers unacknowledged webhooks, so the ingress leg is durable **provided the receiver acknowledges only after the durable record exists.** The current webhook acknowledges before downstream processing (audit §7.2), so this is a requirement on the seam, not a property it has.

**Gu OS `source_events` remains a second, independent idempotency boundary.** Its Organization-scoped uniqueness protects us from duplicate delivery. It is **not** a substitute for producer-side durability: it can only deduplicate events that arrive.

### 5.5 `ungga-landing` is in scope for C1, and this was the other stale premise

*Corrected 2026-09-17:* the earlier working assumption that `ungga-landing` is a marketing front end is wrong, and correcting it adds work the assumption would have missed (audit §24.8). It is a server-rendered application with privileged direct access to both systems of record, and it writes state all three contracts care about: the organization's assignment policy, the guardia roster, the carrusel ordering, property→advisor assignment, appointments **directly in the canonical store**, and the flags a suppression decision would consult. It has **no event-emission infrastructure at all**.

Two consequences. **It needs C1 emission**, for the state it writes directly. But **assignment events must be emitted where the durable lead → advisor assignment changes** — for the manual path that is the `ungga-full` endpoint this repository proxies to, not the proxy. Emitting from the proxy would miss every other writer and double-count this one. It does **not** create leads (portal origination is a WhatsApp deep link and the backend creates the lead), so lead-creation events are not its concern.

**It needs nothing for C6** — the bounded reads are served from the `ungga-full` bridge — and **nothing for SL-6's advisory C2**, since it has no prospect-reply path to gate. It is, however, the **writer** of the authority flags, so whichever way C2 eventually sources them is work here at SL-11. Details in [`technical-plan.md`](technical-plan.md) Appendix D.5.

## 6. C2 — authority-aware routing

> **Owned by** [`technical-plan.md`](technical-plan.md) TD-3 and §4 (row C2), under [`ADR-107`](../../../adr/ADR-107-runtime-conversation-authority.md). **Gate:** advisory at SL-6, **enforcing at SL-11**. **Unblocks:** SL-6, then SL-11. **Implementation map:** [`technical-plan.md`](technical-plan.md) Appendix D.3.

**C2 is the only one of the three with a deliberate two-step shape, and the step requested now is the harmless one.** At SL-6 the legacy router calls the endpoint and the answer is **compared, logged and not obeyed** — the Slice's outcome is *"for pilot conversations the resolver's authority answer matches observed reality, log-only, with conflicts failing safe"* ([`slice-plan.md`](slice-plan.md) §3). Enforcement is SL-11, a different stage and a separate decision.

**The request, in two parts that should not be conflated:**

1. **For SL-6 — call `POST /api/legacy/authority` before invoking the legacy agent, and ignore the answer.** Signed per ADR-111 with an `authority-read` key, **distinct from the events key**: purpose scoping means an events key cannot call this endpoint, and that separation is the point.
2. **For SL-11 — suppress the automated legacy reply when the answer says Gu OS owns the interaction.** Not requested now. It is named here only so the SL-6 wiring is built with it in view.

**The seam.** Audit §24.6 places it in the Python runtime's main app, at the per-lead branch immediately before the agent is invoked and **after** the provider-id dedup guard — after, so a duplicate delivery does not produce a second advisory call for one message. The comparison is logged alongside the existing structured logging on that branch and **discarded for decision purposes**. **No organization entity is in scope at that point**, which is why the request carries opaque refs and never an organization claim; the Organization comes from the ADR-111 key binding.

**Constraints that come from the audit rather than from a preference, and getting either wrong would be worse than not shipping C2:**

- **`advisor_wa` / waProbe captures are evidence, never authority.** They are off-thread observations and do **not** set `bypass_bot` (audit §9.1, §9.1.1). Treating them as authority would hand a conversation to Gu OS on the strength of a side channel. The `advisor_activity` event of §5 must therefore be emitted from the **same-thread** echo branch only.
- **A human actively handling a conversation keeps it.** Suppression must respect the takeover state the audit describes in §8, including the resume window. ADR-107's rule is that conflict **fails safe**, and that transport is not authority.
- **Four concepts stay distinct** and must not be flattened into one: the assigned advisor; an organization member; a same-thread human takeover; and off-thread advisor evidence. The organization → advisor → lead relation may later enrich authority reasoning; it does not broaden SL-6.
- **The two `bypass_bot` fields are different things** — per-lead takeover in Mongo `users`, and a per-bot-number kill switch in `gunumbers` (audit §24.6). They stay distinct.

**One sequencing note.** The router C2 touches is the same one C5's WBA compatibility mechanism runs through ([`technical-plan.md`](technical-plan.md) Appendix C). C5 is not an R1 readiness dependency — established on evidence and repaired in Technical Plan v1.6 — but C2 work should be planned with it in view, because testing suppression on a pilot number that is not processable proves nothing.

## 7. Proving the contracts without a joint integration environment

**Owned by** [`technical-plan.md`](technical-plan.md) §8 and [ADR-111](../../../adr/ADR-111-legacy-service-auth-v1.md) §10–§11. Summarized here because it is the part that requires both sides to do something.

**TD-13 is proved against a shared fixture, not against each other's running systems.** [`td-13-legacy-service-auth-v1.test-vectors.json`](td-13-legacy-service-auth-v1.test-vectors.json) carries a fictional secret, two complete request descriptions (one POST with a body, one GET whose received query order differs from canonical order so an unsorted signer cannot pass), the exact raw body bytes as base64, the body hash, the **complete canonical signing string in both escaped and base64 form**, and the expected signature. The base64 rendering exists because the escaped form still requires agreeing what `\n` means, and a line-separator disagreement is the single most likely first-integration failure.

Each side implements independently and asserts against the file. **No shared runtime package is introduced** — a shared library across a Python/Node/two-repo boundary would couple deployments to avoid implementing thirty lines of HMAC twice. On our side the fixture is guarded by `npm run test:td-13-test-vectors`, which recomputes every derived value and additionally asserts the signature moves when the method, path, query, timestamp, key id, body or secret moves. **The protocol contract, not executable code, is the interoperability source of truth.**

**Rejection cases are specified rather than fixtured**, because a rejection has no canonical signature to agree on. ADR-111 §11 enumerates them; the ones most likely to be missed are that a **reordered query must still pass**, that a **parsed-and-re-serialized body must fail**, and that an **old key inside the rotation window must pass** while one after revocation must not.

**Two things worth copying from ADR-111 rev 2 rather than re-deriving.** The three header patterns are normative and live in a **fenced block, not a table** — a table cell requires a pipe to be backslash-escaped, and an earlier draft therefore published a timestamp pattern that, read from source, matches no ordinary epoch at all. And the query must be **printable ASCII, `0x21`–`0x7E`, rejected before canonicalization**: that precondition is what makes "sort by byte order" mean the same thing in Node and in Python, since without it UTF-16 and UTF-8 orderings diverge on supplementary characters. Under it you may use your language's default string sort.

**Per contract, the behaviors both sides should cover** ([`technical-plan.md`](technical-plan.md) §8): for **C1**, that the same event retried under the same `event_id` yields one semantic Gu OS event, that two different logical mutations of the same entity stay distinct, that provider message ids deduplicate, and that neither assignment nor appointment identity rests on a timestamp; for **C2**, that the advisory call enforces nothing and that same-thread evidence is distinguishable from off-thread; for **C6**, that only the bounded capabilities are reachable, that a cross-Organization request is rejected, that lead composition preserves per-field provenance, that appointment disagreement stays visible, that advisor and Gu threads stay distinct, and that delivery status stays per message.

## 8. What this team does when each one lands

Stated so the ask carries its own return, and so no one is waiting on the other side without knowing what follows.

| Contract lands | This team's next action | Slice |
|---|---|---|
| **TD-13 ratified** | C1 and C2 become specifiable end-to-end; the key registry, the raw-body handling and the verifier become buildable; neither Slice's readiness pass can complete without it | SL-5, SL-6 |
| **C1 ratified, then landed** | elaborate SL-5 to READY, build the receiver and the ADR-111 verifier, add the two additive `source_events` columns, flip `legacy_event_ingestion` from `poll` to `webhook`, retire polling for production wake-ups | SL-5 → SL-8, SL-8b |
| **C2 advisory** | elaborate SL-6 to READY, build `external_conversation_bindings` and the resolver, run the comparison log-only | SL-6 → SL-11 |
| **C6** | switch each capability's adapter from `bootstrap_direct` to `legacy_read_api`, re-run SL-1's hosted evidence against the new path, **then** retire the broad store credentials on effect paths | SL-9 |

## 9. What is deliberately not in this document

- **No Slice is made READY by anything here.** Readiness is determined by a readiness pass against the Definition of Ready, recorded in [`slice-plan.md`](slice-plan.md) §9.
- **No architecture is ratified.** ADR-111 and ADR-112 are **Proposed**. §3 asks for those decisions rather than assuming them, and **C1 is not executable across repositories until they are settled.**
- **No claim that any implementation exists** in either repository. §2 is the state; nothing beyond *specified* has happened.
- **No estimate, bar, Release Scope or acceptance assertion is stated or changed.**
- **No redesign of your persistence.** Nothing here migrates leads or appointments, normalizes historical role literals globally, rewrites the assignment engine, replaces carrusel or guardia, or reconciles the two appointment stores. The standing authorization risks of audit §16 and §24.8 are **not** repaired by this work and remain where they are.
- **§8 Q11 is untouched.** The residual SL-4-era Supervisor judge-quality finding is an input to R1 graduation, is unrelated to these three contracts, and is not repaired or re-opened by this work.
