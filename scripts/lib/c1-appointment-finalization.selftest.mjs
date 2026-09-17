// Executable encoding of ADR-112 §7's appointment semantics: the durability boundary
// (§7A), the delivery-readiness boundary (§7B), crash recovery between them (§7C), and
// why the sequence counter was removed (§7E).
//
// This is NOT the producer. The outbox lives in Traditional Gu and nothing here talks to
// MongoDB. What this guards is the part Gu OS can be wrong about on its own: the contract
// both sides implement against, and the two over-claims earlier revisions of ADR-112
// actually made. Rev 1 would have dropped events silently; rev 2 would have delivered
// confident falsehoods about Calendar and Firestore. Both read as reasonable in prose,
// which is the argument for checking them as code.
//
// The model below is an independent transcription of the ADR, not an import from it, so a
// drift between the record and this file shows up as a failure rather than as agreement.

let checks = 0;
const failures = [];

function check(label, actual, expected) {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

function checkTrue(label, actual) {
  checks += 1;
  if (actual !== true) failures.push(label);
}

function checkDeep(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
}

function checkThrows(label, fn) {
  checks += 1;
  try {
    fn();
    failures.push(`${label} (expected a refusal, got none)`);
  } catch {
    // refusing is the pass
  }
}

// ---------------------------------------------------------------------------
// ADR-112 §5 vocabularies. `unknown` is the addition rev 3 makes, and it is a third
// state on purpose: neither "no effect" nor "failed".
// ---------------------------------------------------------------------------

const STORE_OUTCOMES = ["written", "deleted", "failed", "not_attempted", "unknown"];
const CALENDAR_OPERATIONS = ["created", "updated", "deleted", "none", "unknown"];
const OUTCOMES_RECOVERY_MAY_NOT_ASSERT = ["written", "deleted", "failed", "not_attempted"];

// ---------------------------------------------------------------------------
// ADR-112 §7B, pinned to ungga-full @ gcp/main and sourced from legacy-source-audit §24.3.
// `mongoLast` is the whole question: when the canonical write is last, every secondary
// outcome is already known at §7A and the two boundaries coincide.
// ---------------------------------------------------------------------------

// One entry per row of the audit's §24.3 table. The audit's headline figures are fourteen
// individual writers, nine of them Mongo-only, and none Firestore-only -- but it does NOT
// state how the fourteen distribute across these nine rows (several rows are explicitly
// plural, e.g. "agent tool, and the ts-services route"). So the totals are recorded below
// as the audit's own numbers and are not reconstructed from per-row guesses. What the
// design actually depends on is per-row ORDERING, which is asserted directly.
const AUDIT_TOTAL_WRITERS = 14;
const AUDIT_MONGO_ONLY_WRITERS = 9;

const WRITER_FAMILIES = [
  {
    id: "prospect-conversation-creation",
    operation: "created",
    ordering: ["calendar", "firestore", "mongo"],
    secondaryEffects: ["calendar", "firestore"],
  },
  {
    id: "standby-graph-creation",
    operation: "created",
    ordering: ["calendar", "firestore", "mongo"],
    secondaryEffects: ["calendar", "firestore"],
  },
  {
    // The one gap. Mongo commits, THEN Calendar runs, THEN Mongo is updated again --
    // so the second write is where finalization lands, at no extra request.
    id: "prospect-side-reschedule",
    operation: "rescheduled",
    ordering: ["firestore", "mongo", "calendar", "mongo"],
    secondaryEffects: ["calendar", "firestore"],
  },
  {
    id: "prospect-side-cancel",
    operation: "cancelled",
    ordering: ["firestore", "calendar", "mongo"],
    secondaryEffects: ["calendar", "firestore"],
  },
  { id: "advisor-confirm", operation: "confirmed", ordering: ["mongo"], secondaryEffects: [] },
  { id: "advisor-reschedule", operation: "rescheduled", ordering: ["mongo"], secondaryEffects: [] },
  { id: "visit-tracker-status-and-survey", operation: "status_changed", ordering: ["mongo"], secondaryEffects: [] },
  { id: "owner-phone-sync-twins", operation: "other", ordering: ["mongo"], secondaryEffects: [] },
  { id: "job-filter-reminders", operation: "other", ordering: ["mongo"], secondaryEffects: [] },
];

const mongoOnlyFamilies = WRITER_FAMILIES.filter((f) => f.ordering.every((store) => store === "mongo"));
const dualStoreFamilies = WRITER_FAMILIES.filter((f) => f.ordering.some((store) => store !== "mongo"));

// An effect is resolved at §7A only if it ran strictly before the FIRST canonical write.
// Anything after it -- including effects sandwiched between two Mongo writes -- is not.
function effectsUnresolvedAtDurability(family) {
  const firstMongo = family.ordering.indexOf("mongo");
  return family.secondaryEffects.filter((effect) => family.ordering.indexOf(effect) > firstMongo);
}

// ---------------------------------------------------------------------------
// A reference appointment document. Single-document semantics only: every mutation below
// is one atomic update, which is the property §7A rests on.
// ---------------------------------------------------------------------------

function newAppointmentDoc(appointmentRef) {
  return { appointment_ref: appointmentRef, pending_integration_events: [], late_outcome_observations: [] };
}

// §7B/§7C-bis. Finalization is a compare-and-set, not a write: the filter requires the
// entry to still be `pending`, so MongoDB decides the winner when the writer and the
// recovery sweep reach the same entry. Returns the matched entry, or null for no-match --
// which callers must read as "someone else finalized this", never as an error.
function conditionalFinalize(doc, eventId, mutate) {
  const entry = doc.pending_integration_events.find((e) => e.event_id === eventId && e.state === "pending");
  if (!entry) return null;
  mutate(entry);
  entry.awaiting = [];
  entry.state = "finalized";
  return entry;
}

// §7A. The canonical mutation and the obligation land in ONE update. There is no code
// path here that writes business fields without also pushing the obligation, because that
// is precisely the gap rev 1 left open.
function applyCanonicalMutation(doc, { eventId, eventKind, operation, occurredAt, businessFields, resolvedOutcomes, awaiting }) {
  if (!eventId) throw new Error("§1: an event_id is required; entity identity is not event identity");
  if (doc.pending_integration_events.some((e) => e.event_id === eventId)) {
    throw new Error("§7E: event_id must be unique within the pending array");
  }
  Object.assign(doc, businessFields);
  doc.pending_integration_events.push({
    event_id: eventId,
    event_kind: eventKind,
    operation,
    occurred_at: occurredAt,
    state: awaiting.length === 0 ? "finalized" : "pending",
    awaiting: [...awaiting],
    payload: { store_write_outcomes: { ...resolvedOutcomes.stores }, calendar_effect: { ...resolvedOutcomes.calendar } },
    finalized_at: awaiting.length === 0 ? occurredAt : null,
    finalized_by: awaiting.length === 0 ? "writer" : null,
  });
  return doc;
}

// §7B. The writer reports what actually happened. Validation runs BEFORE the transition so
// a bad vocabulary cannot half-apply. Returns null if the writer lost to recovery.
function finalizeByWriter(doc, eventId, observed, at) {
  for (const value of Object.values(observed.stores ?? {})) {
    if (!STORE_OUTCOMES.includes(value)) throw new Error(`§5: ${value} is not a store outcome`);
  }
  if (observed.calendar && !CALENDAR_OPERATIONS.includes(observed.calendar.operation)) {
    throw new Error(`§5: ${observed.calendar.operation} is not a calendar operation`);
  }
  const entry = conditionalFinalize(doc, eventId, (e) => {
    for (const [key, value] of Object.entries(observed.stores ?? {})) {
      e.payload.store_write_outcomes[key] = value;
    }
    if (observed.calendar) e.payload.calendar_effect = { ...observed.calendar };
    e.finalized_at = at;
    e.finalized_by = "writer";
  });
  if (entry) return entry;
  // §7C-bis: recovery won. The event may already be delivered and Gu OS dedups on
  // event_id, so a corrected redelivery would be silently dropped. Keep the observation
  // as diagnostics instead of overwriting anything.
  doc.late_outcome_observations.push({ event_id: eventId, observed, observed_at: at });
  return null;
}

// §7C. Recovery knows only that the process died -- or that the writer is slow. It may
// mark outcomes `unknown` and nothing else; each other value is a claim about what
// happened. A no-match means the writer finalized first, which is a success, not an error.
function finalizeByRecovery(doc, eventId, at) {
  return conditionalFinalize(doc, eventId, (e) => {
    for (const effect of e.awaiting) {
      if (effect === "calendar") {
        e.payload.calendar_effect = { google_event_id: null, operation: "unknown" };
      } else {
        e.payload.store_write_outcomes[effect] = "unknown";
      }
    }
    e.finalized_at = at;
    e.finalized_by = "recovery";
  });
}

// §7B/§7E. The drain sees finalized entries only, in array order, and claims exclusively.
function drainable(doc) {
  return doc.pending_integration_events.filter((e) => e.state === "finalized" && !e.claim_id);
}

function claim(doc, eventId, claimId) {
  const entry = doc.pending_integration_events.find((e) => e.event_id === eventId);
  if (!entry) throw new Error("no such entry");
  if (entry.state !== "finalized") throw new Error("§7B: the drain must not claim a pending entry");
  if (entry.claim_id) throw new Error("§7E: entry already claimed");
  entry.claim_id = claimId;
  return entry;
}

function pullDelivered(doc, eventId) {
  const before = doc.pending_integration_events.length;
  doc.pending_integration_events = doc.pending_integration_events.filter((e) => e.event_id !== eventId);
  return before - doc.pending_integration_events.length;
}

// ---------------------------------------------------------------------------
// §7B — the ordering table, and which families actually have a gap
// ---------------------------------------------------------------------------

const withGap = WRITER_FAMILIES.filter((f) => effectsUnresolvedAtDurability(f).length > 0);

check("§7B: exactly one writer family has a gap between durability and finalization", withGap.length, 1);
check("§7B: and it is the prospect-side reschedule", withGap[0]?.id, "prospect-side-reschedule");
checkDeep(
  "§7B: the reschedule's unresolved effect at §7A is the Calendar one",
  effectsUnresolvedAtDurability(withGap[0]),
  ["calendar"]
);
check("§24.3: the table covers nine writer families", WRITER_FAMILIES.length, 9);
check("§24.3: five writers touch more than Mongo, which the audit's totals imply", AUDIT_TOTAL_WRITERS - AUDIT_MONGO_ONLY_WRITERS, 5);
checkTrue(
  "§24.3: those five are spread across four dual-store rows, so at least one row is plural -- which is why per-row writer counts are not asserted here",
  dualStoreFamilies.length === 4 && AUDIT_TOTAL_WRITERS - AUDIT_MONGO_ONLY_WRITERS > dualStoreFamilies.length
);
check("§24.3: and the remaining rows are the Mongo-only ones", mongoOnlyFamilies.length, 5);
check(
  "§24.3: no family touches Firestore alone for the appointment document",
  WRITER_FAMILIES.filter((f) => f.ordering.every((store) => store === "firestore")).length,
  0
);
checkTrue(
  "§7B: every Mongo-only family reaches finalization at the canonical write",
  mongoOnlyFamilies.every((f) => effectsUnresolvedAtDurability(f).length === 0)
);

// Creation and cancel are the load-bearing cases: both touch Calendar and Firestore, and
// both are safe ONLY because the canonical write is last. If that ever changes, this fails.
for (const id of ["prospect-conversation-creation", "standby-graph-creation", "prospect-side-cancel"]) {
  const family = WRITER_FAMILIES.find((f) => f.id === id);
  checkDeep(
    `§7B: ${id} has secondary effects but none outstanding at §7A, because Mongo is last`,
    effectsUnresolvedAtDurability(family),
    []
  );
  checkTrue(`§7B: ${id} does have secondary effects, so this is not a vacuous pass`, family.secondaryEffects.length > 0);
  check(`§7B: ${id} performs the canonical write last`, family.ordering[family.ordering.length - 1], "mongo");
}

// The reschedule's second Mongo write is what makes finalization free on that path.
checkTrue(
  "§7B: the reschedule path writes Mongo twice, which is where finalization lands at no extra request",
  WRITER_FAMILIES.find((f) => f.id === "prospect-side-reschedule").ordering.filter((s) => s === "mongo").length === 2
);

// ---------------------------------------------------------------------------
// §7A — durability, and the fact it is NOT completeness
// ---------------------------------------------------------------------------

{
  const doc = applyCanonicalMutation(newAppointmentDoc("appt-1"), {
    eventId: "evt-resched-1",
    eventKind: "appointment_change",
    operation: "rescheduled",
    occurredAt: "2026-09-17T20:00:00Z",
    businessFields: { date: "2026-09-25", hour: "17:00" },
    resolvedOutcomes: { stores: { mongo: "written", firestore: "written" }, calendar: { google_event_id: null, operation: "unknown" } },
    awaiting: ["calendar"],
  });

  check("§7A: the business change is durable immediately", doc.date, "2026-09-25");
  check("§7A: and so is the obligation", doc.pending_integration_events.length, 1);
  check("§7A: an entry with something outstanding is pending, not finalized", doc.pending_integration_events[0].state, "pending");
  checkDeep("§7B: a pending entry is not drainable", drainable(doc), []);
  checkThrows("§7B: the drain must refuse to claim a pending entry", () => claim(doc, "evt-resched-1", "worker-a"));

  // The whole point of separating the boundaries.
  checkTrue(
    "§7A/§7B: durable and delivery-ready are different states, and this entry is the first without being the second",
    doc.pending_integration_events[0].state === "pending" && doc.pending_integration_events.length === 1
  );

  const entry = finalizeByWriter(
    doc,
    "evt-resched-1",
    { calendar: { google_event_id: "gcal-abc", operation: "updated" } },
    "2026-09-17T20:00:04Z"
  );
  check("§7B: the writer's report finalizes it", entry.state, "finalized");
  check("§7B: provenance is the writer", entry.finalized_by, "writer");
  check("§7B: the observed Calendar outcome replaces the placeholder", entry.payload.calendar_effect.operation, "updated");
  check("§7B: and it is now drainable", drainable(doc).length, 1);
}

// The single-write paths: durability and readiness coincide.
{
  const doc = applyCanonicalMutation(newAppointmentDoc("appt-2"), {
    eventId: "evt-confirm-1",
    eventKind: "appointment_change",
    operation: "confirmed",
    occurredAt: "2026-09-17T21:00:00Z",
    businessFields: { appointment_status: "confirmed" },
    resolvedOutcomes: { stores: { mongo: "written", firestore: "not_attempted" }, calendar: { google_event_id: null, operation: "none" } },
    awaiting: [],
  });
  check("§7B: a Mongo-only mutation is finalized at the canonical write", doc.pending_integration_events[0].state, "finalized");
  check("§7B: in one write, with writer provenance", doc.pending_integration_events[0].finalized_by, "writer");
  check("§7B: and is immediately drainable", drainable(doc).length, 1);
  check(
    "§5: a Mongo-only path reports Firestore as not_attempted, not as written",
    doc.pending_integration_events[0].payload.store_write_outcomes.firestore,
    "not_attempted"
  );
}

// ---------------------------------------------------------------------------
// §7C — crash between the boundaries
// ---------------------------------------------------------------------------

{
  const doc = applyCanonicalMutation(newAppointmentDoc("appt-3"), {
    eventId: "evt-resched-2",
    eventKind: "appointment_change",
    operation: "rescheduled",
    occurredAt: "2026-09-17T22:00:00Z",
    businessFields: { date: "2026-09-26" },
    resolvedOutcomes: { stores: { mongo: "written", firestore: "failed" }, calendar: { google_event_id: null, operation: "unknown" } },
    awaiting: ["calendar"],
  });

  // ---- process dies here ----

  checkTrue(
    "§7C: after a crash the obligation is still discoverable by a scan for pending state",
    doc.pending_integration_events.filter((e) => e.state === "pending").length === 1
  );
  check("§7C: the business mutation survived", doc.date, "2026-09-26");
  checkDeep("§7C: and it is still not deliverable", drainable(doc), []);

  const recovered = finalizeByRecovery(doc, "evt-resched-2", "2026-09-17T22:30:00Z");
  check("§7C: recovery finalizes it", recovered.state, "finalized");
  check("§7C: the unresolved Calendar outcome becomes unknown", recovered.payload.calendar_effect.operation, "unknown");
  check("§7C: provenance records that recovery defaulted it, not the writer", recovered.finalized_by, "recovery");
  check("§7C: recovery does not invent a Calendar id", recovered.payload.calendar_effect.google_event_id, null);

  // Recovery must not touch what the writer DID manage to report.
  check(
    "§7C: an outcome the writer already reported is preserved, not overwritten with unknown",
    recovered.payload.store_write_outcomes.firestore,
    "failed"
  );
  check("§7C: nor is the canonical store's reported outcome disturbed", recovered.payload.store_write_outcomes.mongo, "written");

  checkTrue(
    "§7C: recovery asserts none of the four outcomes that would be a claim about what happened",
    !OUTCOMES_RECOVERY_MAY_NOT_ASSERT.includes(recovered.payload.calendar_effect.operation)
  );
  check("§7C-bis: a second recovery pass matches nothing", finalizeByRecovery(doc, "evt-resched-2", "2026-09-17T23:00:00Z"), null);
  check("§7C-bis: and changes nothing -- provenance is untouched", recovered.finalized_by, "recovery");
  check("§7C-bis: including the finalization timestamp", recovered.finalized_at, "2026-09-17T22:30:00Z");
  check("§7C: the recovered event is deliverable", drainable(doc).length, 1);
}

// `unknown` must be distinguishable from `none`. Collapsing them is what would
// reintroduce the orphaned-Calendar blindness audit §11.4 describes.
{
  const crashed = { google_event_id: null, operation: "unknown" };
  const noEffect = { google_event_id: null, operation: "none" };
  checkTrue(
    "§5: `unknown` and `none` are distinct, so a consumer can tell 'never observed' from 'no effect'",
    crashed.operation !== noEffect.operation
  );
  checkTrue("§5: `unknown` is in the vocabulary", CALENDAR_OPERATIONS.includes("unknown") && STORE_OUTCOMES.includes("unknown"));
  checkTrue("§5: and `failed` remains separate from both", CALENDAR_OPERATIONS.includes("unknown") && STORE_OUTCOMES.includes("failed"));
}

// ---------------------------------------------------------------------------
// §7E — why the sequence counter is gone
// ---------------------------------------------------------------------------

// The race rev 2 shipped, reproduced. Two writers interleave read -> +1 -> $inc + $push.
// $inc is atomic; knowing what it produced is not.
{
  const doc = { integration_seq: 5, entries: [] };
  const readA = doc.integration_seq;      // A reads 5
  const readB = doc.integration_seq;      // B reads 5, before A writes
  doc.integration_seq += 1;
  doc.entries.push({ event_id: "evt-a", seq: readA + 1 });
  doc.integration_seq += 1;
  doc.entries.push({ event_id: "evt-b", seq: readB + 1 });

  check("§7E: the counter advanced twice", doc.integration_seq, 7);
  check("§7E: but both entries claim the same seq, which is the race", doc.entries[0].seq, doc.entries[1].seq);
  checkTrue(
    "§7E: so no entry's seq corresponds to the counter, which is why the dependence was removed rather than patched",
    doc.entries.every((e) => e.seq !== doc.integration_seq)
  );
}

// What replaced it: the array's own append order, established atomically by the single
// document update, precomputed by nobody.
{
  let doc = newAppointmentDoc("appt-4");
  const order = ["evt-1", "evt-2", "evt-3"];
  order.forEach((eventId, index) => {
    doc = applyCanonicalMutation(doc, {
      eventId,
      eventKind: "appointment_change",
      operation: "status_changed",
      occurredAt: `2026-09-17T23:0${index}:00Z`,
      businessFields: { status: `s${index}` },
      resolvedOutcomes: { stores: { mongo: "written", firestore: "not_attempted" }, calendar: { google_event_id: null, operation: "none" } },
      awaiting: [],
    });
  });

  checkDeep("§7E: append order is mutation order, with no counter", doc.pending_integration_events.map((e) => e.event_id), order);
  checkTrue("§7E: and no entry carries a seq field at all", doc.pending_integration_events.every((e) => !("seq" in e)));
  checkDeep("§7E: the drain preserves that order", drainable(doc).map((e) => e.event_id), order);

  // Drain exclusivity, so removing the counter opens no double-delivery hole.
  claim(doc, "evt-1", "worker-a");
  checkThrows("§7E: a second worker cannot claim the same entry", () => claim(doc, "evt-1", "worker-b"));
  checkDeep("§7E: a claimed entry leaves the drainable set", drainable(doc).map((e) => e.event_id), ["evt-2", "evt-3"]);
  check("§7E: delivery pulls exactly one entry", pullDelivered(doc, "evt-1"), 1);
  check("§7E: pulling an already-pulled entry removes nothing", pullDelivered(doc, "evt-1"), 0);

  // Liveness comes from the array itself, which is what the counter was supposedly for.
  check("§7D: two entries remain outstanding", doc.pending_integration_events.length, 2);
  pullDelivered(doc, "evt-2");
  pullDelivered(doc, "evt-3");
  check("§7D: an empty array is the signal that everything drained", doc.pending_integration_events.length, 0);
}

// ---------------------------------------------------------------------------
// §7F — the case that disproved rev 3's "the drain preserves array order"
//
// A is pending, B is finalized, and B is LATER in the array. Rev 3 claimed append order
// was delivery order; it is not, because drainability is finalized-and-unclaimed. This is
// the realistic shape: a reschedule awaiting its Calendar outcome, then a confirmation
// that finalizes in one write.
// ---------------------------------------------------------------------------

{
  let doc = newAppointmentDoc("appt-order");

  // A: prospect-side reschedule -- Calendar still outstanding.
  doc = applyCanonicalMutation(doc, {
    eventId: "evt-A-reschedule",
    eventKind: "appointment_change",
    operation: "rescheduled",
    occurredAt: "2026-09-18T09:00:00Z",
    businessFields: { date: "2026-09-30" },
    resolvedOutcomes: { stores: { mongo: "written", firestore: "written" }, calendar: { google_event_id: null, operation: "unknown" } },
    awaiting: ["calendar"],
  });

  // B: advisor confirmation -- Mongo-only, so finalized at the canonical write.
  doc = applyCanonicalMutation(doc, {
    eventId: "evt-B-confirm",
    eventKind: "appointment_change",
    operation: "confirmed",
    occurredAt: "2026-09-18T09:00:05Z",
    businessFields: { appointment_status: "confirmed" },
    resolvedOutcomes: { stores: { mongo: "written", firestore: "not_attempted" }, calendar: { google_event_id: null, operation: "none" } },
    awaiting: [],
  });

  checkDeep(
    "§7E: the array records canonical mutation order, A before B",
    doc.pending_integration_events.map((e) => e.event_id),
    ["evt-A-reschedule", "evt-B-confirm"]
  );

  // The load-bearing assertion. If this ever returns both, or A alone, the ADR's §7F
  // reasoning has changed and the record must change with it.
  checkDeep(
    "§7F: B is deliverable while A is not, so append order is NOT delivery order",
    drainable(doc).map((e) => e.event_id),
    ["evt-B-confirm"]
  );
  check("§7F: A is still pending", doc.pending_integration_events[0].state, "pending");
  checkThrows("§7F: and the drain cannot claim it out of turn or otherwise", () => claim(doc, "evt-A-reschedule", "worker-a"));

  // Head-of-line delivery was the rejected alternative. Prove the property it would have
  // given is genuinely absent, rather than merely undocumented.
  claim(doc, "evt-B-confirm", "worker-a");
  pullDelivered(doc, "evt-B-confirm");
  checkTrue(
    "§7F: the later mutation is delivered first, and C1 promises no order within one appointment",
    doc.pending_integration_events.length === 1 && doc.pending_integration_events[0].event_id === "evt-A-reschedule"
  );

  // A finalizes afterwards and is delivered second -- out of mutation order, by design.
  finalizeByWriter(doc, "evt-A-reschedule", { calendar: { google_event_id: "gcal-r", operation: "updated" } }, "2026-09-18T09:01:00Z");
  checkDeep("§7F: A becomes deliverable only after it finalizes", drainable(doc).map((e) => e.event_id), ["evt-A-reschedule"]);
  checkTrue(
    "§7F: consumers must order by occurred_at, not arrival -- A's mutation precedes B's",
    doc.pending_integration_events[0].occurred_at < "2026-09-18T09:00:05Z"
  );
}

// ---------------------------------------------------------------------------
// §7C-bis — the writer/recovery race. Exactly one transition wins, and the loser
// cannot overwrite it.
// ---------------------------------------------------------------------------

function pendingRescheduleDoc(ref, eventId) {
  return applyCanonicalMutation(newAppointmentDoc(ref), {
    eventId,
    eventKind: "appointment_change",
    operation: "rescheduled",
    occurredAt: "2026-09-18T10:00:00Z",
    businessFields: { date: "2026-10-01" },
    resolvedOutcomes: { stores: { mongo: "written", firestore: "written" }, calendar: { google_event_id: null, operation: "unknown" } },
    awaiting: ["calendar"],
  });
}

// Race 1: the writer gets there first. Recovery must be a silent no-op.
{
  const doc = pendingRescheduleDoc("appt-race-1", "evt-race-1");

  const won = finalizeByWriter(doc, "evt-race-1", { calendar: { google_event_id: "gcal-1", operation: "updated" } }, "2026-09-18T10:00:03Z");
  checkTrue("§7C-bis: the writer's transition succeeded", won !== null);

  const lost = finalizeByRecovery(doc, "evt-race-1", "2026-09-18T10:05:00Z");
  check("§7C-bis: recovery matches nothing, which is a no-op and a success", lost, null);

  const entry = doc.pending_integration_events[0];
  check("§7C-bis: the observed outcome survives", entry.payload.calendar_effect.operation, "updated");
  check("§7C-bis: the Calendar id survives", entry.payload.calendar_effect.google_event_id, "gcal-1");
  check("§7C-bis: provenance stays `writer`", entry.finalized_by, "writer");
  check("§7C-bis: recovery did not overwrite the observed outcome with unknown", entry.payload.calendar_effect.operation === "unknown", false);
  check("§7C-bis: and recorded no late observation, having observed nothing", doc.late_outcome_observations.length, 0);
}

// Race 2: recovery ages the entry out first, then the slow writer returns with a REAL
// outcome. It must not overwrite an event that may already have been delivered.
{
  const doc = pendingRescheduleDoc("appt-race-2", "evt-race-2");

  const won = finalizeByRecovery(doc, "evt-race-2", "2026-09-18T10:05:00Z");
  checkTrue("§7C-bis: recovery's transition succeeded", won !== null);
  check("§7C-bis: with unknown and recovery provenance", won.payload.calendar_effect.operation, "unknown");

  // Simulate the event having already gone out, which is the reason overwriting is unsafe:
  // Gu OS dedups on event_id, so a corrected redelivery would be silently dropped.
  claim(doc, "evt-race-2", "worker-a");
  const delivered = JSON.parse(JSON.stringify(doc.pending_integration_events[0]));

  const lost = finalizeByWriter(doc, "evt-race-2", { calendar: { google_event_id: "gcal-2", operation: "updated" } }, "2026-09-18T10:06:00Z");
  check("§7C-bis: the late writer matches nothing", lost, null);

  const entry = doc.pending_integration_events[0];
  check("§7C-bis: the delivered outcome is unchanged", entry.payload.calendar_effect.operation, "unknown");
  check("§7C-bis: no Calendar id was grafted onto a delivered event", entry.payload.calendar_effect.google_event_id, null);
  check("§7C-bis: provenance stays `recovery`, so it still describes what was sent", entry.finalized_by, "recovery");
  check("§7C-bis: and the finalization timestamp is recovery's", entry.finalized_at, "2026-09-18T10:05:00Z");
  checkDeep("§7C-bis: the delivered entry is byte-identical to what went out", entry, delivered);

  // The real outcome is retained -- as diagnostics, not as a mutation and not as an event.
  check("§7C-bis: the late real outcome is recorded separately", doc.late_outcome_observations.length, 1);
  check("§7C-bis: keyed to the event it belongs to", doc.late_outcome_observations[0]?.event_id, "evt-race-2");
  check(
    "§7C-bis: carrying what was actually observed",
    doc.late_outcome_observations[0]?.observed?.calendar?.operation,
    "updated"
  );
  check("§7C-bis: and no second event was emitted for it", doc.pending_integration_events.length, 1);
}

// The invariant, asserted directly against every interleaving of the two callers.
{
  for (const order of [["writer", "recovery"], ["recovery", "writer"]]) {
    const doc = pendingRescheduleDoc(`appt-invariant-${order[0]}`, "evt-invariant");
    const results = order.map((who) =>
      who === "writer"
        ? finalizeByWriter(doc, "evt-invariant", { calendar: { google_event_id: "gcal-i", operation: "updated" } }, "2026-09-18T11:00:00Z")
        : finalizeByRecovery(doc, "evt-invariant", "2026-09-18T11:05:00Z")
    );
    check(`§7C-bis: with ${order.join(" then ")}, exactly one transition succeeds`, results.filter((r) => r !== null).length, 1);
    check(`§7C-bis: with ${order.join(" then ")}, the winner is the first caller`, results[0] !== null, true);
    check(
      `§7C-bis: with ${order.join(" then ")}, provenance matches the winner`,
      doc.pending_integration_events[0].finalized_by,
      order[0]
    );
    check(`§7C-bis: with ${order.join(" then ")}, the entry is finalized exactly once`, doc.pending_integration_events[0].state, "finalized");
  }
}

// §1/§7E: identity is the event_id, and it must be unique within the document.
{
  const doc = applyCanonicalMutation(newAppointmentDoc("appt-5"), {
    eventId: "evt-dup",
    eventKind: "appointment_change",
    operation: "confirmed",
    occurredAt: "2026-09-18T00:00:00Z",
    businessFields: {},
    resolvedOutcomes: { stores: { mongo: "written", firestore: "not_attempted" }, calendar: { google_event_id: null, operation: "none" } },
    awaiting: [],
  });
  checkThrows("§7E: a duplicate event_id in one document is refused", () =>
    applyCanonicalMutation(doc, {
      eventId: "evt-dup",
      eventKind: "appointment_change",
      operation: "confirmed",
      occurredAt: "2026-09-18T00:00:01Z",
      businessFields: {},
      resolvedOutcomes: { stores: { mongo: "written", firestore: "not_attempted" }, calendar: { google_event_id: null, operation: "none" } },
      awaiting: [],
    })
  );
  checkThrows("§1: a mutation without an event_id is refused", () =>
    applyCanonicalMutation(newAppointmentDoc("appt-6"), {
      eventId: null,
      eventKind: "appointment_change",
      operation: "confirmed",
      occurredAt: "2026-09-18T00:00:02Z",
      businessFields: {},
      resolvedOutcomes: { stores: {}, calendar: {} },
      awaiting: [],
    })
  );
}

// §5: the vocabularies are closed, so an out-of-band outcome cannot be smuggled in.
{
  const doc = applyCanonicalMutation(newAppointmentDoc("appt-7"), {
    eventId: "evt-vocab",
    eventKind: "appointment_change",
    operation: "rescheduled",
    occurredAt: "2026-09-18T01:00:00Z",
    businessFields: {},
    resolvedOutcomes: { stores: { mongo: "written" }, calendar: { google_event_id: null, operation: "unknown" } },
    awaiting: ["calendar"],
  });
  checkThrows("§5: an unknown calendar operation is refused", () =>
    finalizeByWriter(doc, "evt-vocab", { calendar: { google_event_id: "x", operation: "probably_fine" } }, "2026-09-18T01:00:01Z")
  );
  checkThrows("§5: an unknown store outcome is refused", () =>
    finalizeByWriter(doc, "evt-vocab", { stores: { firestore: "maybe" } }, "2026-09-18T01:00:01Z")
  );
}

if (failures.length > 0) {
  console.error(`c1 appointment finalization selftest: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`c1 appointment finalization selftest: ${checks} checks passed`);
