/**
 * Decision logic for the implemented-architecture documentation impact
 * declaration. Pure functions, no I/O — the CLI in
 * `scripts/check-architecture-impact.mjs` supplies the diff and the PR body.
 *
 * WHY THIS EXISTS. The architecture documentation coherence audit (PRs #32–#35)
 * found canonical current-state documents describing a system that had moved on:
 * a component diagram listing twelve tables against 89 migrations, a subsystem
 * architecture with no mention of the migration that added tenancy to its own
 * table, "Stub" next to a shipped HTTP write path, and a code comment asserting
 * RLS semantics the migration contradicts. None of that was caused by a missing
 * rule — `AGENTS.md` §8 already requires updating the artifact that owns changed
 * truth. It was caused by nobody being asked, at a point where the answer was
 * cheap, *which claims this change invalidated*.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. This is deliberately NOT a stale-doc
 * scanner. Deciding whether "X does not exist" is still true requires the
 * semantic judgment the audit itself needed, and a regex that guessed at it
 * would manufacture false confidence — the failure mode being prevented here.
 * So the deterministic claim is narrow and honest:
 *
 *     an architecture-documentation impact assessment was explicitly made
 *
 * and never:
 *
 *     the assessment reached the right answer.
 *
 * Both outcomes pass. `none` is a legitimate, cheap answer — the goal is an
 * accurate assessment of claim impact, not documentation churn.
 */

/** The PR-body heading the declaration lives under. Matched case-insensitively. */
export const SECTION_HEADING = "Implemented architecture documentation impact";

/** The only two legitimate outcomes. */
export const RESULTS = ["updated", "none"];

/**
 * Values that are structurally present but say nothing. Compared after
 * normalization (lowercased, whitespace collapsed, surrounding punctuation and
 * formatting stripped), so this is exact-match against a closed set — not an
 * attempt to judge prose quality.
 */
export const PLACEHOLDERS = new Set([
  "",
  "-",
  "--",
  "...",
  "todo",
  "tbd",
  "n/a",
  "na",
  "none",
  "nothing",
  "no",
  "yes",
  "updated | none",
  "updated / none",
  "updated|none",
]);

/**
 * Floor on the `Reason` field, in characters. This is an anti-emptiness guard,
 * NOT a quality bar: it stops "ok" and "no impact" from satisfying a control
 * whose entire purpose is that somebody actually looked. It is deliberately low
 * enough that an honest one-sentence rationale clears it easily.
 */
export const MIN_REASON_CHARS = 24;

// --------------------------------------------------------------- scope rules

/**
 * Path classes that can change implemented architecture. Kept small on purpose:
 * an elaborate path ontology would rot, and over-triggering is cheap because
 * `none` with a real rationale is a legitimate answer. These are the classes
 * that actually produced the audit's findings.
 */
const IMPLEMENTATION_PATTERNS = [
  // Schema. Either era.
  /(^|\/)migrations\//,
  // DB/runtime primitives, workflow mechanisms, shared types.
  /^packages\/.+\.(ts|tsx|sql)$/,
  // API/route surfaces, agent runtime, integrations and adapters.
  /^apps\/.+\.(ts|tsx|sql)$/,
  // Agent runtime behavior. A playbook is loaded into the system prompt; it is
  // runtime behavior that happens to be authored in Markdown, not documentation.
  /^skills\//,
  // Operational contracts: CI, delivery and the operator-run verifiers.
  /^\.github\/workflows\//,
  /^scripts\/.+\.(ts|mjs|js)$/,
  // Build/runtime composition.
  /^package\.json$/,
  /^turbo\.json$/,
];

/**
 * Never triggers on its own. Documentation is the thing being protected, so a
 * documentation-only PR must not be asked to declare impact on itself. The
 * `skills/` carve-out is why this is checked as an exception rather than a
 * blanket "*.md is docs" rule.
 */
function isDocumentationOnlyPath(filePath) {
  if (filePath.startsWith("skills/")) return false;
  if (filePath.startsWith("docs/")) return true;
  return filePath.toLowerCase().endsWith(".md");
}

/** Split changed paths into the ones that warrant a declaration and the rest. */
export function classifyPaths(paths) {
  const triggering = [];
  const ignored = [];
  for (const filePath of paths) {
    const normalized = String(filePath).trim().replace(/\\/g, "/");
    if (!normalized) continue;
    if (isDocumentationOnlyPath(normalized)) {
      ignored.push(normalized);
      continue;
    }
    if (IMPLEMENTATION_PATTERNS.some((re) => re.test(normalized))) {
      triggering.push(normalized);
    } else {
      ignored.push(normalized);
    }
  }
  return { triggering, ignored };
}

/** True when at least one changed path can change implemented architecture. */
export function requiresDeclaration(paths) {
  return classifyPaths(paths).triggering.length > 0;
}

// ------------------------------------------------------- declaration parsing

/**
 * Removes HTML comments before parsing. The shipped template carries its
 * guidance inside comments, so stripping them first is what makes an unfilled
 * template fail: the fields collapse to empty rather than passing on their own
 * instructions.
 */
export function stripHtmlComments(text) {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
}

/** Lowercased, whitespace-collapsed, stripped of Markdown emphasis and code ticks. */
function normalizeValue(raw) {
  return String(raw ?? "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-–—\s]+|[.\s]+$/g, "")
    .toLowerCase();
}

/** Pull `- **Label:** value` (or `Label: value`) out of a section body. */
function readField(sectionText, label) {
  const pattern = new RegExp(
    `^[\\s>]*[-*+]?\\s*[*_\`]*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[*_\`]*\\s*:\\s*(.*)$`,
    "im"
  );
  const match = sectionText.match(pattern);
  return match ? match[1] : null;
}

/**
 * Extracts the declaration section from a PR body.
 * Returns `null` when the heading is absent.
 */
export function parseDeclaration(body) {
  const text = stripHtmlComments(body);
  const headingPattern = new RegExp(
    `^\\s{0,3}#{1,6}\\s*${SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "im"
  );
  const heading = text.match(headingPattern);
  if (!heading) return null;

  const start = heading.index + heading[0].length;
  const rest = text.slice(start);
  // The section ends at the next heading of any level, or at end of body.
  const nextHeading = rest.match(/^\s{0,3}#{1,6}\s+\S/m);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;

  return {
    section,
    result: readField(section, "Result"),
    docsReviewed: readField(section, "Owning current-state docs reviewed"),
    reason: readField(section, "Reason"),
  };
}

/** `docs/architecture.md` — at least one Markdown path must be named. */
function namesMarkdownPath(value) {
  return /[\w./-]+\.md\b/i.test(String(value ?? ""));
}

function isPlaceholder(value) {
  return PLACEHOLDERS.has(normalizeValue(value));
}

/**
 * Validates a PR body against the changed-path set.
 *
 * Returns `{ required, ok, errors, result }`. When no changed path warrants a
 * declaration the body is not inspected at all — a documentation-only PR is
 * never asked to declare impact on documentation.
 */
export function validate({ paths = [], body = "" } = {}) {
  const { triggering, ignored } = classifyPaths(paths);
  if (triggering.length === 0) {
    return { required: false, ok: true, errors: [], result: null, triggering, ignored };
  }

  const errors = [];
  const declaration = parseDeclaration(body);

  if (!declaration) {
    errors.push(
      `PR body has no "## ${SECTION_HEADING}" section. ` +
        "Add it (see .github/pull_request_template.md) and identify the owning " +
        "artifact through docs/README.md."
    );
    return { required: true, ok: false, errors, result: null, triggering, ignored };
  }

  const result = normalizeValue(declaration.result);
  if (!RESULTS.includes(result)) {
    errors.push(
      declaration.result === null
        ? "declaration has no `Result:` field."
        : `Result must be exactly \`updated\` or \`none\` (found: "${String(declaration.result).trim()}").`
    );
  }

  // Both outcomes have to name the artifact. Outcome A says where the corrected
  // truth landed; outcome B says what was inspected before concluding nothing
  // was invalidated. A result with no artifact named is not an assessment.
  if (isPlaceholder(declaration.docsReviewed)) {
    errors.push("`Owning current-state docs reviewed:` is empty or a placeholder.");
  } else if (!namesMarkdownPath(declaration.docsReviewed)) {
    errors.push(
      "`Owning current-state docs reviewed:` must name at least one document path " +
        "(e.g. `docs/architecture.md`). Use docs/README.md to identify the owner."
    );
  }

  const reason = String(declaration.reason ?? "").trim();
  if (isPlaceholder(reason)) {
    errors.push("`Reason:` is empty or a placeholder.");
  } else if (normalizeValue(reason).length < MIN_REASON_CHARS) {
    errors.push(
      `\`Reason:\` is too short to be an assessment (needs ≥ ${MIN_REASON_CHARS} characters).`
    );
  }

  return {
    required: true,
    ok: errors.length === 0,
    errors,
    result: RESULTS.includes(result) ? result : null,
    triggering,
    ignored,
  };
}
