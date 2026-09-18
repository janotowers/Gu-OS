# Gu OS architectural decision records

ADRs capture cross-cutting decisions that should not remain buried in long plans. Topic plans retain implementation detail.

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-100](ADR-100-hybrid-knowledge-storage.md) | Hybrid raw/index/Brain storage; Markdown is a representation | Accepted direction |
| [ADR-101](ADR-101-organization-tenancy.md) | Historical user-scoped → organization-native target decision; superseded by ADR-106 | Superseded |
| [ADR-102](ADR-102-knowledge-ownership-scopes.md) | Platform/industry/organization/team/user ownership dimension | Accepted direction |
| [ADR-103](ADR-103-hybrid-retrieval.md) | Hybrid retrieval plus generated indexes; no index-only product | Accepted direction |
| [ADR-104](ADR-104-governed-improvement.md) | Improvement authority is target-specific and gated | Accepted direction |
| [ADR-105](ADR-105-shareable-regenerable-views.md) | Share views, not duplicate truth; software may be situational under constraints | Accepted direction |
| [ADR-106](ADR-106-organization-native-multiseat-tenancy.md) | Organization-native multi-seat tenancy with legacy identity bridge | Accepted direction |
| [ADR-107](ADR-107-runtime-conversation-authority.md) | Runtime, conversation and approval authority during brownfield migration | Accepted direction |
| [ADR-108](ADR-108-versioned-organization-policy.md) | Typed, versioned organization policy with governed publication and runtime resolution | Accepted direction |
| [ADR-109](ADR-109-generic-case-relationships-lineage.md) | Generic cross-domain Case relationships and lineage; association remains distinct from identity/history lineage | Accepted direction |
| [ADR-110](ADR-110-resource-usage-cost-attribution.md) | Cross-domain resource usage, cost valuation and causal attribution kept separate from customer pricing/billing | Accepted direction |
| [ADR-111](ADR-111-legacy-service-auth-v1.md) | `LegacyServiceAuth` v1: per-service, per-purpose HMAC request signing across the Gu OS / Traditional Gu trust boundary, with server-side Organization binding | Accepted direction (ratified at rev 2, 2026-09-17; rev 3–5 implementation repairs 2026-09-18) |
| [ADR-112](ADR-112-cross-repo-integration-events.md) | Cross-repo integration events: entity identity separated from logical event identity, and durable producer-side publication with the durability and delivery-readiness boundaries kept distinct | Accepted direction (ratified at rev 4, 2026-09-17) |

Status meanings:

- **Proposed:** fully specified and awaiting human ratification; **not yet an architectural constraint**, and not to be implemented against.
- **Accepted direction:** architectural constraint for target design; implementation may still be pending.
- **Implemented:** verified in current code/migrations.
- **Superseded:** retained for history with a link to the replacement.

Workflow-specific ADRs live under [`../manuals/adr/`](../manuals/adr/); the `100+` range here avoids claiming those numbers. Current records include [ADR-0001 — Durable work roots](../manuals/adr/0001-durable-work-roots.md) and [ADR-0011 — Governed hybrid storage for private skill packages](../manuals/adr/0011-skill-package-interoperability.md).
