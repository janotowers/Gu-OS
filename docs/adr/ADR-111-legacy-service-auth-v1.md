# ADR-111 — LegacyServiceAuth v1: cross-repo service authentication

**Status:** Proposed (**rev 2**) — awaiting human ratification. Nothing in this record is an architectural constraint yet.
**Date:** 2026-09-17
**Revision history:** **rev 2 (2026-09-17)** — two implementation-blocking defects corrected in pre-ratification review, with the **mechanism, key-binding model, purposes, rotation model and existing vectors unchanged**. (1) The header grammar moved out of a Markdown table into a fenced block: a table cell requires `|` to be escaped as `\|`, so the timestamp pattern read `^(0\|[1-9][0-9]{0,11})$` in source — which matches no ordinary epoch, including the fixture's — while rendering as an alternation (§2). (2) "Sort by byte order" was ambiguous against a host language's default string sort, so the query alphabet is now an enforced printable-ASCII precondition under which the two orderings are provably identical, with the divergence outside it named precisely (§3). Both are now asserted by `npm run test:td-13-test-vectors`, which grew from 43 checks to 85.
**Related:** [ADR-106](ADR-106-organization-native-multiseat-tenancy.md) (Organization tenancy), [ADR-107](ADR-107-runtime-conversation-authority.md) (runtime/conversation authority), R1 [`technical-plan.md`](../product/roadmap-increments/r1-relationship-operations-v1/technical-plan.md) TD-13 (the recommendation this record makes precise), [`td-13-legacy-service-auth-v1.test-vectors.json`](../product/roadmap-increments/r1-relationship-operations-v1/td-13-legacy-service-auth-v1.test-vectors.json) (the interoperability fixture)

## Context

Gu OS and Traditional Gu (`UnggaMX/ungga-full`, `UnggaMX/ungga-landing`) must call each other across a trust boundary that separates **two systems, two teams and two deployment estates**. Four contracts depend on it: C1 event forwarding, C2 authority reads, C6 bounded legacy reads, and C3/C4 delivery callbacks.

TD-13 already chose the mechanism — per-service, per-purpose HMAC-SHA256 request signing — and rejected static bearers, mTLS and OAuth client credentials with reasons that still hold. That choice is not reopened here. What TD-13 lacked was **implementation-level precision**: it named the three headers and the general shape of the signed material, but not the canonicalization, the encoding, the malformed-input behavior or the key-binding model. Two teams cannot independently implement "HMAC over method + path + timestamp + body-hash" and interoperate; the ambiguity is in exactly the places that produce a signature mismatch on the first real request.

Three pieces of repository truth shaped the specification below, all established 2026-09-17:

- **Neither side has any implementation.** Gu OS has no `x-guos-*` handling anywhere, and `/api/legacy/events` and `/api/legacy/authority` do not exist. This is a greenfield protocol with no installed base to stay compatible with, which is why it can afford to be strict.
- **Raw-body preservation does not exist in either codebase.** Gu OS's only webhook route reads `await request.json()`; Traditional Gu's `messageFilter` uses plain `express.json()` with no `verify` callback. Traditional Gu *does* contain an `x-hub-signature` HMAC verifier for Meta webhooks, but the line that installs it is commented out, it is SHA-1, and it returns silently when the header is absent — so it is not a pattern to inherit. Body-hash-over-raw-bytes therefore requires new middleware on both sides, and §"Raw body" below states the requirement rather than assuming a facility.
- **Secrets reach the three deployables by three different mechanisms** — 1Password Connect baked into Cloud Run revisions at build time (`ungga-full`), Secret Manager references (`ungga-landing`), GitHub Actions environments plus encrypted database rows (Gu OS). Rotation must work across all three, which is why §"Rotation" requires two concurrently valid key ids rather than a coordinated cutover.

## Decision

### 1. Protocol identity and versioning

The protocol is `LegacyServiceAuth`, version `v1`. The version appears in **two** places, deliberately:

1. as the literal first line of the signing string, so a signature computed under a future version can never be replayed as a v1 signature — the versions are cryptographically domain-separated, not merely labelled;
2. as the `v1=` prefix of the `x-guos-signature` header value, so a verifier can reject an unsupported version before doing any work.

A verifier that supports only v1 rejects any other prefix with the same response as a bad signature.

### 2. Headers

Exactly three request headers carry the authentication. All names are lowercase on the wire.

**The accepted forms are given in a fenced block rather than in a table, deliberately.** A Markdown table cell requires `|` to be escaped as `\|`, so a regex containing an alternation renders as one thing and reads in source as another — and an implementer working from either the raw file or a copied cell gets a pattern that matches nothing. An earlier draft of this record carried exactly that defect on the timestamp. A fenced block has no escaping rules, so what is read is what is implemented.

```
x-guos-key-id      ^[a-z0-9][a-z0-9_-]{2,63}$
x-guos-timestamp   ^(?:0|[1-9][0-9]{0,11})$
x-guos-signature   ^v1=[0-9a-f]{64}$
```

- **`x-guos-key-id`** is opaque. It names one calling service **and** one purpose, and carries no authority by itself (§6).
- **`x-guos-timestamp`** is Unix epoch **seconds**, decimal ASCII: no fraction, no sign, no leading zeros, no whitespace, and no value wider than twelve digits. The group is non-capturing only so the alternation cannot be misread; `^(0|[1-9][0-9]{0,11})$` accepts the same language.
- **`x-guos-signature`** is lowercase hex only. Uppercase hex is **rejected rather than normalized**, as is a missing `v1=` prefix.

These three patterns are the normative grammar. `npm run test:td-13-test-vectors` asserts that every header in the fixture matches them, and that a set of representative malformed forms — uppercase hex, a fractional or signed or zero-padded timestamp, a missing `v1=` prefix, a comma-joined duplicate value, and surrounding whitespace — does not.

**Duplicate headers are rejected, never joined or resolved to the first value.** This is not a stylistic rule: several HTTP stacks, including the `Headers` object Gu OS's Next.js routes receive, silently join repeated headers with `, `. The strict regexes above are what make that rejection automatic, because a joined value cannot match them. Implementations that read headers through an API which drops duplicates instead of joining them must check duplication explicitly.

A missing header, a header failing its regex, or a duplicated header produces the same rejection as an invalid signature (§7).

### 3. The canonical signing string

Exactly **seven lines**, joined by a single LF (`0x0A`), with **no trailing newline**, encoded UTF-8:

```
LegacyServiceAuth-v1
<x-guos-key-id verbatim>
<HTTP method, uppercased>
<request path>
<canonical query>
<x-guos-timestamp verbatim>
<body SHA-256, lowercase hex>
```

- **Method.** Uppercased ASCII (`POST`, `GET`). Uppercasing is the only normalization.
- **Path.** The request-target path only: no scheme, host, query or fragment. **Percent-encoding is preserved exactly as received.** The path is not decoded, not re-encoded, not trailing-slash-normalized, and dot segments are not collapsed. Decoding is lossy and re-encoding is implementation-specific, so any normalization would make the two sides disagree. An empty path signs as `/`.
  - Consequence, stated because it is a real operational risk rather than a theoretical one: if an intermediary rewrites the path, verification fails. That is the intended behavior — a signature that survives path rewriting does not protect the path.
- **Canonical query.** The empty string when there is no query string. Otherwise: split the raw query on `&`; drop zero-length segments; keep every remaining segment **verbatim**, including its original percent-encoding and its `=` if present; **sort the segments in ascending order of their unsigned byte values, comparing byte by byte and treating a proper prefix as smaller** (`a` before `ab` before `b`); join with `&`. Segments are never parsed or decoded, because `+` versus `%20` is not recoverable after decoding and the two languages would not agree. Sorting makes parameter order irrelevant; duplicate names are permitted and simply sort together.
  - **The query must be pure ASCII, and a byte outside `0x21`–`0x7E` is rejected before canonicalization.** This is what makes "byte order" unambiguous across languages. RFC 3986 already restricts the request target to ASCII — anything else must arrive percent-encoded — so the constraint costs nothing, and it is stated as an enforced precondition rather than an assumption. Under it, an ordinary lexicographic sort over UTF-8 bytes, over Python `str`, and over JavaScript UTF-16 code units are **provably the same ordering**, because every code unit is a single byte below `0x80`. Without it they are not: UTF-16 encodes supplementary characters as surrogates in `D800`–`DFFF`, which sort *below* the BMP characters in `E000`–`FFFF` that UTF-8 encodes with a smaller lead byte, so the two orderings disagree for any comparison spanning that boundary. The divergence is narrow, which is exactly what makes it dangerous: it would stay invisible until a query carrying a supplementary character appeared in production.
  - Implementations are free to use their language's default string sort once the ASCII precondition is enforced. `npm run test:td-13-test-vectors` asserts the precondition holds for every fixture segment **and** that an explicit bytewise comparison agrees with the default sort on those segments, so the equivalence is checked rather than asserted.
- **Timestamp.** Byte-identical to the `x-guos-timestamp` header. A verifier that re-renders the timestamp from a parsed integer will disagree with a signer that sent a differently formatted equivalent, which is why the header form is constrained in §2 and copied verbatim here.
- **Body hash.** Lowercase hex SHA-256 over the exact raw body bytes (§4). An empty body hashes to the SHA-256 of zero bytes, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

The key id is inside the signed material even though it also selects the secret. Including it costs nothing and means the audit log's key attribution is signed rather than asserted.

### 4. Raw body

The body hash is computed over **the exact bytes received in the HTTP body**, before any parsing, and never over a parsed-then-re-serialized structure. Re-serializing JSON changes key order, whitespace and unicode escaping, none of which the sender controls.

Two requirements follow, both of which are new work in both repositories:

- The receiving framework must expose the raw body to the verifier. In Express this is `express.json({ verify })` or an equivalent that captures the buffer; in a Next.js route handler it is `await request.text()` (or `arrayBuffer()`) with parsing performed afterwards on the captured bytes.
- **`Content-Encoding` must be absent on signed requests, and a present `Content-Encoding` is rejected.** Otherwise "the raw bytes" is ambiguous between the compressed and decompressed forms, and the two sides will choose differently.

Request-size caps are declared per purpose and enforced **before** hashing, so an oversized body is rejected without hashing unbounded input. An oversize rejection is a `413` and is not an authentication outcome.

### 5. Signature

`HMAC-SHA256(secret, signing_string)`, where the secret is the **UTF-8 bytes of the configured string** (not base64-decoded) and the signing string is its UTF-8 bytes. The result is lowercase hex; the wire form is `v1=<hex>`.

Comparison decodes both sides to 32 bytes and compares in **constant time** (`crypto.timingSafeEqual` or `hmac.compare_digest`). The length is checked before the constant-time compare, because a length-mismatched compare either throws or leaks.

Provisioning requires at least 32 bytes of entropy per secret. Secrets are never sent to a browser, never logged, and never included in an error response.

### 6. Key binding — what a valid signature does *not* buy

A key id resolves, **server-side only**, to:

```
key_id -> { secret, service, purpose, gu_os_organization_id, legacy_source_scope, not_before, not_after, revoked }
```

Four rules, all fail-closed:

1. **Purpose scoping.** Each endpoint declares exactly one required purpose. A key whose purpose does not match is rejected with `403`, even though its signature is valid. An `events-ingest` key cannot read authority; a `legacy-read` key cannot ingest events.
2. **Organization binding.** The Gu OS Organization comes **only** from the key record. If the payload also names an organization it must be absent or equal; inequality is `403`. A payload organization claim is never an authorization input — it is at most a consistency assertion to be checked.
3. **Legacy source scope.** The key record names the `source_system` and the Traditional Gu owner/source refs the caller may speak for. An event about an out-of-scope owner is `403`. For the pilot a single owner ref per key is sufficient; the field is a set so that widening later does not change the protocol.
4. **Validity window.** `not_before` / `not_after` / `revoked` are evaluated per request. Verification uses **only** the key named by `x-guos-key-id` — a verifier never trials other keys, which is what keeps rotation (§8) from becoming an oracle.

**A valid signature therefore cannot let a caller self-select an Organization or a legacy owner.** That property, not the HMAC itself, is what makes this contract safe to expose to another team's deployment.

### 7. Rejection behavior

| Condition | Status |
|---|---|
| Missing, malformed, duplicated or unsupported-version auth header | `401` |
| Unknown key id | `401` |
| Signature mismatch | `401` |
| Timestamp outside the freshness window | `401` |
| Key revoked or outside its validity window | `401` |
| Valid signature, wrong purpose / organization / source scope | `403` |
| Body exceeds the declared cap | `413` |

Every `401` returns the **same** body and the same machine-readable reason code. In particular, an unknown key id is indistinguishable from a bad signature: revealing which key ids exist is a free enumeration oracle. The `403` cases may distinguish themselves, because reaching one already required a valid signature from a known key.

**Freshness:** `|now - timestamp| <= 300` seconds, checked in **both** directions. Future-dated requests are rejected too; a one-sided check accepts a clock-skewed or deliberately future-stamped request indefinitely.

### 8. Replay, idempotency and rotation

**There is no signature cache.** The HMAC plus the freshness window provide authenticity, integrity and freshness only. A process-local cache is unsound under multiple application instances, and a shared durable one adds infrastructure for no gain, because within-window replay is rendered harmless by **semantic idempotency in durable state at each endpoint**:

- **C1 events** — `source_events` has `unique (organization_id, dedup_key)`; duplicate delivery collapses to one row, so the ingress is at-least-once safe. This constraint is **implemented today** (forward migration `20260906040233_admission_policy_and_source_events.sql`).
- **C2 authority** — a read-only recomputation of current state; a replay returns current truth, and the endpoint is rate-limited per key.
- **C6 reads** — read-only by construction.
- **C3/C4 effects and callbacks** — TD-13's original text cited `external_effect_operations.operation_key` and `resource_usage_events.event_key`. **Neither table exists yet**; they are planned, not migrated. The only comparable unique key in current code is `publication_operations.operation_key`, which serves a different purpose. So this bullet is a *requirement on the Slices that introduce those effects*, not a present guarantee, and C3/C4 must not be treated as replay-safe before it is satisfied.

**Rotation** is two concurrently valid key ids per (service, purpose, organization) with overlapping windows: provision the new key on both sides, switch the signer, drain in-flight requests, revoke the old. No coordinated cutover, no shared moment of downtime. This matters concretely because `ungga-full` bakes secrets into Cloud Run revisions at build time — rotation there requires a redeploy, and overlapping validity is what keeps that redeploy from being a synchronized outage.

**Rate limiting** is per key id, applies to rejected requests as well as accepted ones, and sits outside the signature contract.

### 9. Purposes

| Purpose | Direction | Endpoint | Contract |
|---|---|---|---|
| `events-ingest` | Traditional Gu → Gu OS | `POST /api/legacy/events` | C1 |
| `authority-read` | Traditional Gu → Gu OS | `POST /api/legacy/authority` | C2 |
| `delivery-callback` | Traditional Gu → Gu OS | delivery/status callbacks | C3/C4 |
| `legacy-read` | **Gu OS → Traditional Gu** | bounded C6 read capabilities | C6 |

`legacy-read` is added by this record. TD-13 was written as though the boundary were one-directional, but C6 is Gu OS calling Traditional Gu, and it needs the same authentication with the same key-binding properties in the opposite direction. **C6's payload contract is already defined and can be implemented before this ADR is ratified; C6's authentication cannot.** Treating C6 as authentication-independent because its response shapes are settled is the specific mistake this row exists to prevent.

### 10. Interoperability proof

[`td-13-legacy-service-auth-v1.test-vectors.json`](../product/roadmap-increments/r1-relationship-operations-v1/td-13-legacy-service-auth-v1.test-vectors.json) is the shared fixture: a fictional secret, two complete request descriptions, the exact raw body bytes as base64, the body hash, the **complete canonical signing string in both escaped and base64 form**, and the expected signature.

The base64 rendering of the signing string is there for a reason — the escaped form still requires a reader to agree on what `\n` means, and disagreement about line separators is the single most likely cause of a first-integration mismatch.

Both sides prove compatibility independently against this file. **No shared runtime package is introduced**; the protocol contract, not executable code, is the interoperability source of truth. A shared library across a Python/Node/two-repo boundary would couple deployments to avoid implementing thirty lines of HMAC twice, which is the wrong trade.

The fixture is guarded in this repository by `npm run test:td-13-test-vectors`, which recomputes every derived value from an independent transcription of the rule above, and additionally asserts that the signature changes when the method, path, query, timestamp, key id, body or secret changes — so a fixture that documented a weaker protocol than this record describes would fail.

### 11. Contract tests both sides must cover

Rejection cases have no canonical signature to agree on, so they are specified here rather than as vectors:

valid signature accepted · wrong secret · wrong purpose for the endpoint · stale timestamp · future timestamp beyond skew · altered path · altered query · reordered query (**must still pass**) · altered body by one byte · parsed-and-re-serialized body (**must fail**) · wrong Organization for the key · out-of-scope legacy owner · old key inside the rotation window (**must pass**) · old key after revocation · duplicate auth header · malformed auth header · uppercase hex signature · missing `v1=` prefix · unknown key id indistinguishable from bad signature · `Content-Encoding` present · body over the cap.

### 12. Key provisioning and rotation ownership

Repository evidence establishes the **mechanism** on each side (§Context) but not the **accountable owner** of a key that spans both estates. That is the one operational question this record cannot answer from the repositories, and it is raised as a bounded decision in R1's [`slice-plan.md`](../product/roadmap-increments/r1-relationship-operations-v1/slice-plan.md) §8 rather than settled here. It is deliberately not widened into a secrets-management redesign: the three existing mechanisms are each adequate for holding a key, and the contract only requires that two key ids can be valid at once.

## Consequences

- C1 and C2 become specifiable end-to-end once this is ratified; both are blocked on it today.
- Both repositories gain raw-body-preserving middleware on the signed routes. In Traditional Gu that also creates the opportunity — not the obligation, and not part of this record — to re-enable real signature verification on the Meta webhook, which is currently unverified.
- The strictness is deliberate and has a cost: uppercase hex, a re-rendered timestamp, a normalized path or a re-serialized body all fail rather than being accepted. Every one of those leniencies would be a place the two implementations could silently diverge.
- The protocol says nothing about payload schemas. C1's envelope and event semantics are [ADR-112](ADR-112-cross-repo-integration-events.md); C2's and C6's shapes are owned by the R1 Technical Plan.
- Nothing here is implemented. This record plus the fixture is what makes ratification a decision about a contract rather than about an intention.

## Reevaluate when

- The signed surface grows beyond service-to-service calls between these two estates, or a third party needs to call it — at which point mTLS or OAuth client credentials become proportionate, and TD-13's rejection of them should be revisited rather than inherited.
- Any endpoint under this contract stops being semantically idempotent in durable state, which is the assumption that lets §8 omit a signature cache.
- Traditional Gu moves off build-time secret baking, which would remove the operational reason rotation must tolerate overlapping keys.
