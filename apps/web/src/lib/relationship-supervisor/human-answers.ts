/**
 * What people answered to the supervisor's earlier asks — the Cycle 3 repair
 * (R1 Slice Plan §5 order 2, §6).
 *
 * S2 §8.2 compiles "open / blocked / recent Work" and runs "observe actual
 * result/evidence → continue / replan"; §8.5 replans "after a Tool/human
 * response"; HP-08 says "work resumes when the answer arrives". A person
 * answers one of Gu's targeted asks through the Work Portfolio, which writes
 * the answer to the canonical Work result (`work_items.result_jsonb
 * .human_answer`, R1 SL-7). This module turns those answers into content the
 * judge can read: what was asked, who answered — by role, never an id — when,
 * and what they said.
 *
 * The text is a person's, so it is DATA. It is quoted with JSON escaping, so no
 * line break or quote inside it can end its line or pose as the prompt's own
 * structure, and it is length-bounded. That an answer is information and never
 * an instruction is said to the judge separately (`next-work-judge.ts`).
 */
import type { WorkItem } from "@agents/types";

/** Engineering bounds, not product thresholds: room for a real answer, not a document. */
export const HUMAN_ANSWER_MAX_CHARS = 600;
const QUESTION_MAX_CHARS = 300;

/** Only the most recent answers are compiled; older ones are settled history. */
export const HUMAN_ANSWERS_MAX = 5;

const ROLE_LABELS: Record<string, string> = {
  advisor: "the advisor",
  owner: "the owner",
  org_admin: "an Organization admin",
};

interface StoredAnswer {
  text: string;
  role: string | null;
  answeredAt: string | null;
}

function readAnswer(item: WorkItem): StoredAnswer | null {
  const raw = item.result_jsonb?.human_answer;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (text === "") return null;
  return {
    text,
    role: typeof record.answered_by_role === "string" ? record.answered_by_role : null,
    answeredAt: typeof record.answered_at === "string" ? record.answered_at : null,
  };
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (truncated)`;
}

// Built from code points so no editor or tool can turn them into literal line
// terminators inside this source file.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON-quoted, so control characters and quotes are escaped. The two Unicode
 * line separators are escaped as well: JSON leaves them bare, and a reader may
 * still break a line on them.
 */
function quote(text: string): string {
  return JSON.stringify(text)
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}

function answeredOn(answeredAt: string | null): string {
  if (!answeredAt || Number.isNaN(Date.parse(answeredAt))) return "";
  return ` on ${new Date(answeredAt).toISOString().slice(0, 10)}`;
}

/**
 * One line per answered ask, oldest first, at most `HUMAN_ANSWERS_MAX`.
 *
 * Work that finished without a person's answer contributes nothing here — its
 * status is already in the Work list — and neither does a blank answer.
 */
export function summarizeHumanAnswers(work: readonly WorkItem[]): string[] {
  const answered = work.flatMap((item) => {
    const answer = readAnswer(item);
    return answer ? [{ item, answer }] : [];
  });
  answered.sort((a, b) => (a.answer.answeredAt ?? "").localeCompare(b.answer.answeredAt ?? ""));

  return answered.slice(-HUMAN_ANSWERS_MAX).map(({ item, answer }) => {
    const purpose = item.input_contract_jsonb?.purpose;
    const question =
      typeof purpose === "string" && purpose.trim() !== ""
        ? `: ${quote(bounded(purpose.trim(), QUESTION_MAX_CHARS))}`
        : "";
    const who = (answer.role !== null ? ROLE_LABELS[answer.role] : undefined) ?? "a person in the Organization";
    return (
      `Asked (${item.work_type})${question} — answered by ${who}` +
      `${answeredOn(answer.answeredAt)}: ${quote(bounded(answer.text, HUMAN_ANSWER_MAX_CHARS))}`
    );
  });
}
