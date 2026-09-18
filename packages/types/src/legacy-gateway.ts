/**
 * Bounded operational read capabilities over Traditional Gu (R1 SL-1 / TD-5,
 * architecture contract AC-1; R1 SL-6 / TD-3 Q17).
 *
 * These types are the **durable interface**. The adapter behind each capability
 * is a replaceable bootstrap detail (direct Firestore/Mongo reads today,
 * bounded legacy-side read APIs at cross-repo contract C6); the capability
 * contract is what callers depend on and what fixtures pin.
 *
 * Three rules the shapes here exist to enforce:
 *   * **No generic CRUD, ever.** The vocabulary is closed: named semantic
 *     capabilities, each with its own typed request and result. There is no
 *     "read collection X" shape to widen into one.
 *   * **Provenance on every result** - where it came from, which store, when it
 *     was read, and through which adapter. A normalized value without
 *     provenance is not a gateway result.
 *   * **External identifiers stay opaque.** `legacy_lead_id` is a composite
 *     operational-context key (audit 5.1); it is carried whole and never parsed
 *     into phone-number components.
 *
 * C6's ratified first-wave contract is still exactly four capabilities
 * (`legacy_lead_get_context`, `legacy_lead_get_recent_messages`,
 * `appointment_get`, `property_get_details`). `legacy_conversation_authority_get`
 * is a later SL-6 / TD-3 addition in this same union. It is **not** a C6
 * endpoint, is not a model tool, and is sanctioned on `bootstrap_direct` only
 * until a least-privilege legacy-side implementation sits behind the same
 * replaceable abstraction (Q17).
 */

// ============================================================
// Capability vocabulary
// ============================================================

/**
 * Named gateway capabilities. Adding a member is a capability-surface change
 * and belongs to a Slice, not to a call site.
 *
 * The first four are the SL-1 / C6 first-wave surface. The fifth is the SL-6
 * authority read (TD-3 Q17) and is not retrofitted into C6.
 */
export const LEGACY_GATEWAY_CAPABILITIES = [
  "legacy_lead_get_context",
  "legacy_lead_get_recent_messages",
  "appointment_get",
  "property_get_details",
  "legacy_conversation_authority_get",
] as const;

export type LegacyGatewayCapability =
  (typeof LEGACY_GATEWAY_CAPABILITIES)[number];

/** Physical stores the bootstrap adapters may reach. Closed on purpose. */
export type LegacySourceStore = "firestore" | "mongo";

/**
 * How the value was obtained. `bootstrap_direct` is the sanctioned shadow-stage
 * adapter; `legacy_read_api` is the C6 target. Recording it per result is what
 * makes the eventual handover auditable rather than invisible.
 */
export type LegacyReadAdapter = "bootstrap_direct" | "legacy_read_api";

// ============================================================
// Provenance and freshness
// ============================================================

/**
 * Freshness metadata. `readAt` is always known; `sourceUpdatedAt` only when the
 * source record carries a usable timestamp, so `ageSeconds` is nullable rather
 * than invented. These are *fresh operational* reads by architecture (AC-1
 * 6.5) - this block reports how fresh, it does not make them fresh.
 */
export interface LegacyReadFreshness {
  /** ISO-8601 instant the gateway performed the read. */
  readAt: string;
  /** ISO-8601 instant the source record reports it was last written, if any. */
  sourceUpdatedAt: string | null;
  /** `readAt - sourceUpdatedAt` in seconds; null when the source carries none. */
  ageSeconds: number | null;
  /** Which source field `sourceUpdatedAt` was taken from, for auditability. */
  sourceUpdatedAtField: string | null;
}

/**
 * Whether the requested external identity was already bound to a Gu OS
 * Organization at read time.
 *
 *   * `bound` - an `external_identity_bindings` row for this id resolves to the
 *     calling Organization.
 *   * `unbound` - no binding exists yet. Legitimate during admission discovery
 *     (SL-2 reads a lead in order to decide whether to admit it), so the read is
 *     allowed, but only after ownership containment proves the record belongs to
 *     the calling Organization. Recorded so a consumer can tell the two apart.
 */
export type LegacyBindingState = "bound" | "unbound";

/**
 * One allowlisted source's contribution inside a composed read.
 * Used when a single capability envelope cannot honestly carry one
 * `sourcePath` / freshness pair for every field.
 */
export interface LegacyReadSourceContribution {
  /** Semantic field this source produced, e.g. `numberKillSwitchActive`. */
  field: string;
  sourcePath: string;
  sourceUpdatedAt: string | null;
  sourceUpdatedAtField: string | null;
}

/** Provenance carried by every gateway result. Never optional. */
export interface LegacyReadProvenance {
  sourceSystem: "traditional_gu";
  store: LegacySourceStore;
  /** Allowlisted logical source path, e.g. `leads/{leadId}/wsp_messeges`. */
  sourcePath: string;
  /** The opaque external identifier the read was performed with. */
  externalId: string;
  capability: LegacyGatewayCapability;
  adapter: LegacyReadAdapter;
  /** Gu OS Organization the read was authorized against. */
  organizationId: string;
  bindingState: LegacyBindingState;
  freshness: LegacyReadFreshness;
  /**
   * Present when the envelope composes more than one allowlisted source.
   * Envelope `sourcePath` / `freshness` stay the primary (lead) contribution
   * and must not be read as attributing every field to that path.
   */
  contributions?: readonly LegacyReadSourceContribution[];
}

/** Envelope every capability returns. Data never travels without provenance. */
export interface LegacyReadResult<T> {
  value: T;
  provenance: LegacyReadProvenance;
  /**
   * Server-observed Traditional Gu owner/source of the read record.
   * Authorization evidence for ADR-111 §6, not a capability semantic field.
   */
  observedOwnerRef?: string | null;
}

// ============================================================
// legacy_lead_get_context
// ============================================================

/**
 * Normalized lead context. Deliberately a small, semantic projection - not a
 * pass-through of the Firestore document, which would recreate generic CRUD
 * behind a capability name.
 */
export interface LegacyLeadContext {
  /** Opaque composite key. Carried whole, never parsed (audit 5.1, 5.3). */
  legacyLeadId: string;
  /** Legacy owner principal (`users/{uid}` normalized to the bare uid). */
  ownerLegacyUserId: string | null;
  /** Raw owner representation as stored, kept as provenance only. */
  ownerRawValue: string | null;
  /** Legacy advisor label as recorded on the lead, when present. */
  assignedAdvisorLabel: string | null;
  assignmentType: string | null;
  clientType: string | null;
  /** Legacy origin/source label. Evidence with provenance, not Gu OS semantics. */
  originLabel: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// ============================================================
// legacy_lead_get_recent_messages
// ============================================================

/**
 * Which conversation thread an item came from (audit 10.1). The Gu thread and
 * each advisor own-WhatsApp thread are different documents with different
 * visibility semantics; flattening them into one list without this dimension
 * would lose a legacy product semantic.
 */
export type LegacyMessageThreadKind = "gu" | "advisor";

export interface LegacyMessageThread {
  kind: LegacyMessageThreadKind;
  /** Thread document id, e.g. the Gu number or `asesor_<phone>`. Opaque. */
  threadId: string;
  /** Advisor endpoint the thread belongs to, for `advisor` threads. */
  advisorEndpoint: string | null;
}

export type LegacyMessageDirection = "inbound" | "outbound" | "unknown";

/**
 * Per-item delivery evidence as the legacy store records it (audit 15.7).
 * `unknown` is a first-class value: queue acceptance is not delivery, and
 * collapsing "not reported yet" into "sent" is exactly the error 15.1 warns
 * about.
 */
export type LegacyDeliveryStatus =
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "unknown";

export interface LegacyConversationItem {
  thread: LegacyMessageThread;
  /** Provider message id when the source recorded one. Opaque. */
  wamid: string | null;
  direction: LegacyMessageDirection;
  /** Legacy `source` marker, e.g. `advisor_wa`. Preserved verbatim. */
  source: string | null;
  authorLabel: string | null;
  text: string | null;
  timestamp: string | null;
  deliveryStatus: LegacyDeliveryStatus;
  deliveryErrorCode: string | null;
}

export interface LegacyRecentMessages {
  legacyLeadId: string;
  threads: LegacyMessageThread[];
  /** Newest-last, across all threads, each item carrying its own thread. */
  items: LegacyConversationItem[];
  /** True when the source held more items than the requested bound. */
  truncated: boolean;
}

// ============================================================
// appointment_get
// ============================================================

/**
 * Which legacy stores answered. Appointment persistence is **not atomic**
 * across them (audit 11.3), so a single-store answer is reported as such rather
 * than presented as the whole truth.
 */
export interface LegacyAppointmentStorePresence {
  firestore: boolean;
  mongo: boolean;
}

/** One appointment record as a single store holds it. */
export interface LegacyAppointmentView {
  /** Store-local identifier: the Firestore document id, or the Mongo `_id`. */
  legacyAppointmentId: string;
  store: LegacySourceStore;
  legacyDealId: string | null;
  legacyLeadId: string | null;
  legacyPropertyId: string | null;
  /** Legacy status label, preserved verbatim - never mapped to a Gu OS state. */
  status: string | null;
  /** `date` + `hour` normalized to an instant where both parse. */
  scheduledAt: string | null;
  rawDate: string | null;
  rawHour: string | null;
  createdAt: string | null;
  finished: boolean | null;
  /**
   * Non-null means an external Calendar effect exists, which is the orphan risk
   * audit 11.4 describes. Written by the legacy appointment creators to BOTH
   * stores, so it is read from both: treating it as Firestore-only blinded the
   * orphan check on the store that is actually canonical (audit 24.3).
   */
  googleEventId: string | null;
}

/**
 * The two stores' records of what should be the same appointment.
 *
 * There is **no shared per-appointment identifier**: the Firestore replica is
 * keyed by an auto-id (its `appointment_id` field is present on only half the
 * documents and never equals the document id), while Mongo is keyed by
 * `ObjectId`. Verified first-hand on 2026-09-04. Pairing therefore uses the
 * natural key the two stores do share - deal, property, date and hour - and an
 * unmatched record on either side is reported as exactly that.
 *
 * Nothing here resolves a conflict. Which store wins, and what the business
 * consequence is, belongs to SL-8/SL-10 reconciliation, not to a read.
 */
export interface LegacyAppointmentPair {
  /** Natural key the pairing used, for traceability. */
  key: string;
  firestore: LegacyAppointmentView | null;
  mongo: LegacyAppointmentView | null;
  presence: LegacyAppointmentStorePresence;
  /** True when both stores answered and their records differ. */
  storesDisagree: boolean;
  /** Field-level differences, or the single-store presence note. */
  disagreements: string[];
}

export interface LegacyDealAppointments {
  legacyDealId: string;
  /**
   * Which stores were actually consulted. Mongo is `false` when no Mongo
   * credential is bound for the Organization - and a single-store answer is
   * then explicitly incomplete rather than silently authoritative.
   */
  storesConsulted: LegacyAppointmentStorePresence;
  entries: LegacyAppointmentPair[];
}

// ============================================================
// property_get_details
// ============================================================

export interface LegacyPropertyDetails {
  legacyPropertyId: string;
  title: string | null;
  /** Owner principal resolved from either representation (see below). */
  ownerLegacyUserId: string | null;
  /**
   * `user_owner` has two representations in the source: normally a Firestore
   * DocumentReference to `users/{uid}`, but part of the imported inventory
   * stores it as a text path. Both normalize to the bare uid; anything else
   * yields null rather than a guess.
   */
  ownerRawValue: string | null;
  operationType: string | null;
  status: string | null;
  price: number | null;
  currency: string | null;
  addressLabel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// ============================================================
// legacy_conversation_authority_get (R1 SL-6 / TD-3 Q17)
// ============================================================

/**
 * Current conversation-authority inputs from Traditional Gu. A semantic
 * projection only — never a pass-through of the Mongo lead-runtime or
 * Gu-number documents.
 *
 * The per-lead takeover flag and the per-Gu-number kill switch are distinct
 * fields with distinct meanings (audit §24.6). Neither is read as the other.
 * This shape reports both; it does not interpret a resume window.
 */
export interface LegacyConversationAuthority {
  /** Opaque composite key. Carried whole, never parsed (audit 5.1, 5.3). */
  legacyLeadId: string;
  /**
   * Per-lead same-thread takeover (`users.bypass_bot`). Null when the source
   * did not record a boolean.
   */
  leadTakeoverActive: boolean | null;
  /**
   * Last same-thread owner interaction as the source recorded it
   * (`last_owner_interaction_wba`), normalized to an instant. Null when
   * absent or unparseable. Resume-window interpretation is not this
   * capability's job.
   */
  lastOwnerInteractionAt: string | null;
  /**
   * Per-Gu-number kill switch (`gunumbers.bypass_bot`). Distinct from
   * `leadTakeoverActive`. Null when no number was resolved, the number
   * record was missing, or the source did not record a boolean.
   */
  numberKillSwitchActive: boolean | null;
  /**
   * Opaque Gu-number identity the kill switch was read for, when a number
   * was resolved. Null when the lead runtime carried none.
   */
  guNumberRef: string | null;
}

// ============================================================
// Organization-scoped credential providers (TD-1 / TD-5)
// ============================================================

/**
 * Providers stored in `organization_tool_secrets`. `traditional_gu_api` is the
 * C6 target and is registered now so the credential vocabulary does not have to
 * change when the adapter does.
 */
export const ORGANIZATION_TOOL_SECRET_PROVIDERS = [
  "traditional_gu_firestore",
  "traditional_gu_mongo",
  "traditional_gu_api",
] as const;

export type OrganizationToolSecretProvider =
  (typeof ORGANIZATION_TOOL_SECRET_PROVIDERS)[number];
