/**
 * Commitments as Case Subjects — R1 SL-4, SA-4.4.
 *
 * S2 §8.13 draws a line this module has to keep: a **commitment** remembers
 * what someone is relying on; a **scheduled reconsideration** remembers when to
 * think again. They are not the same thing and one does not imply the other, so
 * nothing here creates a wake and nothing in the wake path creates a commitment.
 *
 * The representation is TD-14's, and the reason it is not four columns on a row
 * is S2 §8.15: a commitment can be changed, cancelled, superseded, fulfilled or
 * left unresolved, and "history/provenance should remain reconstructible". A
 * status column overwrites; a superseding fact does not. So the subject row is
 * the identity — created once, structurally immutable — and every one of those
 * transitions is a new `commitment.status` fact under it, with the previous
 * value preserved as history.
 *
 * The keys are clean (`commitment.due`, not `commitment.<uuid>.due`) because
 * the identity lives in `subject_id`. That is the whole point of SA-4.4, and it
 * is why enumerating a Case's commitments is a query rather than a prefix scan
 * over parsed strings.
 *
 * DETECTION IS SEMANTIC; RECORDING IS NOT. Whether someone made a promise is a
 * judgment the model makes. What happens to it afterwards — identity,
 * de-duplication, provenance, immutability — is entirely deterministic and
 * lives here.
 */
import {
  createCaseSubject,
  insertCaseFact,
  type DbClient,
  type SubjectWithFacts,
} from "@agents/db";
import {
  COMMITMENT_FACT_KEYS,
  type CommitmentActor,
  type CommitmentDueFactValue,
  type CommitmentStatusFactValue,
} from "@agents/types";

/** One commitment the judge observed in the evidence. */
export interface ProposedCommitment {
  expected_outcome: string;
  actor: CommitmentActor;
  due_at: string | null;
  due_stated: boolean;
  /** Stable across wake-ups for the SAME promise. */
  key: string;
}

export interface RecordedCommitment {
  subjectId: string;
  key: string;
  /** False when the commitment already existed and was left as it was. */
  created: boolean;
}

/**
 * `attrs_jsonb` key holding the judge's stable commitment key.
 *
 * On the subject row rather than in a fact, because it is at-creation identity
 * and never changes — which is exactly TD-14's rule for what may live in
 * `attrs_jsonb`. It is what makes recording idempotent across wake-ups without
 * hashing content: two advisors promising the same thing twice are two
 * commitments, and collapsing them on content would silently lose one.
 */
export const COMMITMENT_KEY_ATTR = "commitment_key";

function existingKeys(existing: readonly SubjectWithFacts[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of existing) {
    const key = entry.subject.attrs_jsonb?.[COMMITMENT_KEY_ATTR];
    if (typeof key === "string" && key !== "") keys.add(key);
  }
  return keys;
}

/**
 * Records the commitments this reconsideration observed.
 *
 * Idempotent by the judge's stable key: a commitment already tracked on this
 * Case is **left exactly as it is**, not re-created and not re-stated. A
 * re-run of the same wake therefore adds nothing, which is half of what SA-4.6
 * promises for durable work — the other half being the wake claim itself.
 *
 * Deliberately does NOT update or resolve an existing commitment. Satisfaction
 * requires evidence that the expected outcome occurred (S2 §8.15) — not a
 * passed deadline, not a Work Item that ran, and certainly not a later
 * reconsideration having a different opinion. Reconciling a commitment against
 * outcome evidence is S3/SL-8 behavior, and inventing it here would let SL-4
 * mark promises fulfilled it never verified.
 */
export async function recordCommitments(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  existing: readonly SubjectWithFacts[];
  proposed: readonly ProposedCommitment[];
  /** Provenance: which reconsideration observed the commitment. */
  wakeKey: string;
  now: Date;
}): Promise<RecordedCommitment[]> {
  const known = existingKeys(params.existing);
  const recorded: RecordedCommitment[] = [];

  for (const commitment of params.proposed) {
    const key = commitment.key.trim().toLowerCase();
    if (key === "") continue;

    if (known.has(key)) {
      const match = params.existing.find(
        (entry) => entry.subject.attrs_jsonb?.[COMMITMENT_KEY_ATTR] === key
      );
      if (match) {
        recorded.push({ subjectId: match.subject.id, key, created: false });
      }
      continue;
    }

    const subject = await createCaseSubject(params.db, {
      userId: params.userId,
      caseId: params.caseId,
      kind: "commitment",
      label: commitment.expected_outcome.slice(0, 200),
      attrs: { [COMMITMENT_KEY_ATTR]: key },
      // The commitment was inferred from evidence by the supervisor, which is
      // what `derived` means in the CURRENT source vocabulary.
      sourceKind: "derived",
      sourceRef: `supervisor_wake:${params.wakeKey}`,
      actorKind: "agent",
      provenance: { observed_by: "case_supervisor", wake_key: params.wakeKey },
    });
    known.add(key);

    const fact = (factKey: string, value: unknown) =>
      insertCaseFact(params.db, {
        userId: params.userId,
        caseId: params.caseId,
        factKey,
        value,
        sourceKind: "derived",
        sourceRef: `supervisor_wake:${params.wakeKey}`,
        subjectId: subject.id,
      });

    await fact(COMMITMENT_FACT_KEYS.expectedOutcome, {
      expected_outcome: commitment.expected_outcome,
    });
    await fact(COMMITMENT_FACT_KEYS.actor, { actor: commitment.actor });

    if (commitment.due_at) {
      const due: CommitmentDueFactValue = {
        due_at: commitment.due_at,
        basis: commitment.due_stated ? "stated" : "inferred_from_context",
      };
      await fact(COMMITMENT_FACT_KEYS.due, due);
    }

    // `open` with no evidence, which is the honest starting state: nothing has
    // been verified yet, and S2 §8.15 requires evidence before `fulfilled`.
    const status: CommitmentStatusFactValue = {
      status: "open",
      evidence_refs: [],
      note: null,
    };
    await fact(COMMITMENT_FACT_KEYS.status, status);

    recorded.push({ subjectId: subject.id, key, created: true });
  }

  return recorded;
}

/**
 * One line per open commitment, for the judge's context.
 *
 * Only commitments that are still open are shown. A fulfilled or cancelled one
 * is history the replay can reconstruct, and putting it in front of the model
 * would invite it to act on a promise already settled.
 */
export function summarizeOpenCommitments(
  commitments: readonly SubjectWithFacts[]
): string[] {
  const lines: string[] = [];
  for (const entry of commitments) {
    const statusValue = entry.facts.get(COMMITMENT_FACT_KEYS.status)?.value_jsonb as
      | CommitmentStatusFactValue
      | undefined;
    if (statusValue && statusValue.status !== "open") continue;

    const outcome = entry.facts.get(COMMITMENT_FACT_KEYS.expectedOutcome)
      ?.value_jsonb as { expected_outcome?: string } | undefined;
    const actor = entry.facts.get(COMMITMENT_FACT_KEYS.actor)?.value_jsonb as
      | { actor?: string }
      | undefined;
    const due = entry.facts.get(COMMITMENT_FACT_KEYS.due)?.value_jsonb as
      | CommitmentDueFactValue
      | undefined;

    const parts = [outcome?.expected_outcome ?? entry.subject.label ?? "(unnamed)"];
    if (actor?.actor) parts.push(`actor: ${actor.actor}`);
    if (due?.due_at) parts.push(`due: ${due.due_at}`);
    lines.push(parts.join(" — "));
  }
  return lines;
}
