# R1 — cross-repo contract requests to the Traditional Gu team (C1, C2, C6)

> **Status:** Reference — **this document owns no truth.** Every requirement below is derived from the artifact named in its own *Owned by* line, and if the two ever disagree the owning artifact wins. It exists because nothing else in this repository is addressed to the other team.
> **Owner:** engineering owner (R1)
> **Roadmap Increment:** R1 — Relationship Operations v1 — [`slice-plan.md`](slice-plan.md), [`technical-plan.md`](technical-plan.md)
> **Created:** 2026-09-16, as the outcome of the Development Continuity Loop after SL-14 closed and the READY Horizon emptied ([`slice-plan.md`](slice-plan.md) §1)
> **Not an approval of anything.** It requests work owned by another team and records the joint decisions that must be settled before that work can start. It ratifies no architecture, moves no bar, and changes no Slice contract.

## 1. Why this exists

**Every remaining R1 Slice waits on C1, C2 or C6.** SL-14 closed SL-4's carry-forward finding and nothing depended on it, so its closure moved no dependency fact. Readiness work cannot advance a single candidate: SL-5 waits on C1, SL-6 on C2 advisory, SL-9 on the C6 hard gate, and SL-8, SL-8b and SL-13 wait behind those three ([`slice-plan.md`](slice-plan.md) §1, §3).

These three contracts are **owned by the Traditional Gu team, not by this one.** Advancing them is a human action across a team boundary. What this team can do — and what this document is — is state the ask precisely enough that it can be acted on, and name the decisions that block the ask itself.

**The Gu OS half of each contract is this team's work and is not requested here.** SL-5 builds the event receiver, SL-6 the authority resolver and endpoint, SL-9 the adapter switch. None of them is READY, and none can be made READY by building them: a receiver with nothing forwarding to it proves nothing, which is exactly why these are cross-repo contracts rather than internal work.

## 2. The blocking decision, before any of the three

**TD-13 `LegacyServiceAuth` v1 is fully specified and still marked TENTATIVE, and C1 and C2 both authenticate through it** ([`technical-plan.md`](technical-plan.md) TD-13, §4: *"All C-contracts authenticate per TD-13 … not shared static bearers"*). It is not vague — it specifies HMAC-SHA256 over `method + path + timestamp + body-hash`, the three headers, per-purpose key ids (`events-ingest`, `authority-read`, `delivery-callback`), server-side organization binding, a ±5-minute window with no signature cache because every endpoint is idempotent through durable Postgres state, and two-key overlapping rotation. What it does not have is ratification or an ADR.

**This is an authentication contract across a trust boundary between two systems and two teams**, so settling it is a consequential architecture/security decision and not engineering authority (root `AGENTS.md` §5, §9). Asking Traditional Gu to build against a TENTATIVE spec asks them to build twice.

**The smallest concrete action: ratify TD-13 as an ADR, or direct that it be revised first.** It gates C1 and C2 together. It does **not** gate C6's payload shapes, which are already code.

## 3. C6 — bounded legacy read APIs

> **Owned by** [`technical-plan.md`](technical-plan.md) TD-5 and §4 (row C6). **Gate:** hard, before SL-9 — *no production risk-waiver path*. **Unblocks:** SL-9, and through it SL-10, SL-11 and SL-13.

**This is the most actionable of the three, because Gu OS can hand over an exact contract today rather than a description of one.** The four capabilities are a closed vocabulary in `packages/types/src/legacy-gateway.ts`, their normalized response shapes are typed there, and the fixtures under `apps/web/src/lib/legacy-gateway/fixtures/` are the regression baseline SL-1's evidence was produced against. A C6 endpoint is correct when it returns those shapes.

**The request — four bounded, organization-scoped read endpoints**, semantically equivalent to what the bootstrap adapters read today:

| Gu OS capability | Must preserve | Why, and where it comes from |
|---|---|---|
| `legacy_lead_get_context` | the normalized lead shape with provenance and freshness metadata | SL-1's delivered contract; the adapter behind it becomes `legacy_read_api` instead of `bootstrap_direct`, and that value is recorded per result |
| `legacy_lead_get_recent_messages` | **thread awareness** — the Gu thread and `asesor_*` threads kept distinct — with `source`, `wamid` and `delivery_status` per item | [`legacy-source-audit.md`](legacy-source-audit.md) §10.1 (multi-thread conversations) and §15.7 (delivery writeback); SL-9 reconciles sends against this |
| `appointment_get` | **partial persistence must stay visible, not be papered over** | [`legacy-source-audit.md`](legacy-source-audit.md) §11.3 — appointment persistence is not atomic across Firestore and Mongo, and Gu OS deliberately pairs or refuses rather than guessing |
| `property_get_details` | the normalized property shape | SL-1's delivered contract |

The names are the closed vocabulary `LEGACY_GATEWAY_CAPABILITIES` in `packages/types/src/legacy-gateway.ts`; they are Gu OS's internal capability names, not a required URL shape.

**What C6 landing actually retires**, and why the gate has no waiver: today Gu OS reads Traditional Gu's stores directly, under the `traditional_gu_firestore` and `traditional_gu_mongo` credentials recorded in [`sl1-legacy-read-credentials.md`](sl1-legacy-read-credentials.md). That is acceptable while every stage is shadow. SL-9 is the first stage that produces a prospect-facing external effect, and reading a broad project credential to decide an effect is the boundary TD-5 refuses to waive. **C6 is therefore not a performance or tidiness change — it is the condition under which Gu OS stops holding read access it should not hold once it can act.**

**Not C6, and worth saying so explicitly:** the Mongo lead runtime fields (`bypass_bot`, the assignment mirror) are **not** a read API. They arrive as C1 events and are consumed by C2. Asking for them here would build the wrong thing.

## 4. C1 — event forwarding

> **Owned by** [`technical-plan.md`](technical-plan.md) TD-5 (event ingestion) and §4 (row C1). **Gate:** hard for SL-5. **Unblocks:** SL-5, and through it SL-8 and SL-8b. **Interim fallback in place:** the gateway polling adapter (AC-1 §6.7), which is why shadow Slices SL-2 … SL-4 could close without it.

**The receiving side is already built and already in use, which makes this request unusually cheap to specify.** `source_events` exists, with `UNIQUE (organization_id, dedup_key)`, and the four event kinds are a database `CHECK` constraint, not a convention: `inbound_prospect_message`, `advisor_activity`, `appointment_change`, `assignment_change` (`packages/types/src/source-events.ts`). The polling adapter writes those same rows today. **C1 changes the writer, not the table** — which is the stated reason the ingestion shape was frozen early.

**The request — POST the four event classes to `/api/legacy/events`**, signed per TD-13 with an `events-ingest` key:

| Event kind | Legacy source | Audit reference |
|---|---|---|
| `inbound_prospect_message` | messageFilter / services, at ingress | [`legacy-source-audit.md`](legacy-source-audit.md) §7.1–§7.2 |
| `advisor_activity` | advisor takeover — `bypass_bot`, `last_owner_interaction_wba`, and the owner-app send path that synthesizes a webhook | [`legacy-source-audit.md`](legacy-source-audit.md) §8.1–§8.4, §9 |
| `appointment_change` | appointment lifecycle, across both stores | [`legacy-source-audit.md`](legacy-source-audit.md) §11.3 |
| `assignment_change` | sticky assignment — `/guard-lead-one` | [`legacy-source-audit.md`](legacy-source-audit.md) §6.1–§6.3 |

**The one part that must be agreed rather than assumed is the dedup key.** Gu OS derives it as `<sourceSystem>:<eventKind>:<externalRef>:<discriminator>` through `buildSourceEventDedupKey`, and that function lives in the shared types package *specifically* so the polling adapter and the C1 webhook cannot drift apart — because the moment they do, duplicate suppression stops working at exactly the point ingestion changes. **The discriminator is the joint decision:** it must distinguish two events about the same subject, and the audit's §7.1 provider message id is the natural choice for messages. The other three kinds need one agreed each.

**Payloads are allowlisted normalized JSON, not raw Firestore or Mongo documents**, and [`technical-plan.md`](technical-plan.md) §8 already calls for the C1 contract tests to be **shared** with the legacy plans rather than written twice.

## 5. C2 — authority-aware routing

> **Owned by** [`technical-plan.md`](technical-plan.md) TD-3 and §4 (row C2), under [`ADR-107`](../../../adr/ADR-107-runtime-conversation-authority.md). **Gate:** advisory at SL-6, **enforcing at SL-11**. **Unblocks:** SL-6, then SL-11.

**C2 is the only one of the three with a deliberate two-step shape, and the step that is requested now is the harmless one.** At SL-6 the legacy router calls the endpoint and the answer is **compared, logged and not obeyed** — the Slice's own outcome is *"for pilot conversations the resolver's authority answer matches observed reality, log-only, with conflicts failing safe"* ([`slice-plan.md`](slice-plan.md) §3). Enforcement is SL-11, a different stage and a separate decision.

**The request, in two parts that should not be conflated:**

1. **For SL-6 — call `POST /api/legacy/authority` from the legacy router before invoking the legacy agent, and ignore the answer.** Signed per TD-13 with an `authority-read` key, distinct from the events key: TD-13's purpose scoping means an events key cannot call this endpoint, and that separation is the point.
2. **For SL-11 — suppress the automated legacy reply when the answer says Gu OS owns the interaction.** Not requested now. It is named here only so the SL-6 wiring is built with it in view.

**Two constraints that come from the audit rather than from a preference, and getting either wrong would be worse than not shipping C2:**

- **`advisor_wa` / waProbe captures are evidence, never authority.** They are off-thread observations and do **not** set `bypass_bot` ([`legacy-source-audit.md`](legacy-source-audit.md) §9.1, §9.1.1). Treating them as authority would hand a conversation to Gu OS on the strength of a side-channel.
- **A human who is actively handling a conversation keeps it.** Suppression must respect the takeover state the audit describes in §8, including the resume window. ADR-107's rule is that conflict **fails safe**, and that transport is not authority.

**One sequencing note.** The router C2 touches is the same one C5's WBA compatibility mechanism runs through ([`technical-plan.md`](technical-plan.md) Appendix C). C5 is not an R1 readiness dependency — that was established on evidence and repaired in Technical Plan v1.6 — but C2 work should be planned with it in view, because testing suppression on a pilot number that is not processable proves nothing.

## 6. What this team does when each one lands

Stated so the ask carries its own return, and so no one is waiting on the other side without knowing what follows.

| Contract lands | This team's next action | Slice |
|---|---|---|
| **TD-13 ratified** | C1 and C2 become specifiable; neither Slice's readiness pass can complete without it | SL-5, SL-6 |
| **C6** | switch each capability's adapter from `bootstrap_direct` to `legacy_read_api`, re-run SL-1's hosted evidence against the new path, retire the broad store credentials on effect paths | SL-9 |
| **C1** | elaborate SL-5 to READY, build the receiver and the TD-13 verifier, flip `legacy_event_ingestion` from `poll` to `webhook`, retire polling for production wake-ups | SL-5 → SL-8, SL-8b |
| **C2 advisory** | elaborate SL-6 to READY, build `external_conversation_bindings` and the resolver, run the comparison log-only | SL-6 → SL-11 |

## 7. What is deliberately not in this document

- **No Slice is made READY by anything here.** Readiness is determined by a readiness pass against the Definition of Ready, recorded in [`slice-plan.md`](slice-plan.md) §9.
- **No architecture is ratified.** TD-13 stays TENTATIVE until a human decision says otherwise, and §2 exists to ask for that decision rather than to assume it.
- **No estimate, bar, Release Scope or acceptance assertion is stated or changed.**
- **§8 Q11 is untouched.** The residual SL-4-era Supervisor judge-quality finding is an input to R1 graduation, is unrelated to these three contracts, and is not repaired or re-opened by this work.
