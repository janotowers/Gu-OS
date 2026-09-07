/**
 * Selftests for the architecture-impact declaration control.
 *
 * This is a blocking CI check, so the rules that decide pass/fail are pinned
 * here. Everything under test is pure: paths and a PR body in, a verdict out.
 *
 * Two boundaries get disproportionate attention because getting them wrong
 * breaks the control in opposite directions:
 *   - a documentation-only PR must NEVER be asked to declare impact (that would
 *     be bureaucracy on the artifact the control exists to protect);
 *   - an unfilled template must NEVER pass (a control that accepts its own
 *     placeholder is worse than no control, because it manufactures evidence).
 */
import assert from "node:assert/strict";
import {
  MIN_REASON_CHARS,
  SECTION_HEADING,
  classifyPaths,
  parseDeclaration,
  requiresDeclaration,
  stripHtmlComments,
  validate,
} from "./architecture-impact.mjs";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

/** A well-formed declaration, parameterised by result/docs/reason. */
function body({
  result = "none",
  docs = "`docs/architecture.md`",
  reason = "Checked the runtime and data-model sections; this change adds no new table, route or runtime path.",
  heading = `## ${SECTION_HEADING}`,
} = {}) {
  return [
    "Some prose about the change.",
    "",
    heading,
    "",
    `- **Result:** \`${result}\``,
    `- **Owning current-state docs reviewed:** ${docs}`,
    `- **Reason:** ${reason}`,
    "",
    "## Verification",
    "",
    "- ci green",
  ].join("\n");
}

// ------------------------------------------------ 1. docs-only ⇒ not required
{
  const paths = [
    "docs/architecture.md",
    "docs/manuals/architecture-manual.md",
    "README.md",
    "AGENTS.md",
  ];
  assert.equal(requiresDeclaration(paths), false);
  const r = validate({ paths, body: "" });
  assert.equal(r.required, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  ok("documentation-only change requires no declaration, even with an empty body");
}
{
  // The control must not fire on its own PR template either.
  const r = validate({ paths: [".github/pull_request_template.md"], body: "" });
  assert.equal(r.required, false);
  ok("the PR template itself is documentation, not implementation");
}

// ------------------------------------- 2. implementation + missing ⇒ fail
{
  const paths = ["packages/db/src/queries/operational-cases.ts"];
  assert.equal(requiresDeclaration(paths), true);
  const r = validate({ paths, body: "Fixed a thing.\n\n## Verification\n\n- ci green" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /no "## Implemented architecture documentation impact" section/);
  ok("implementation change with no declaration fails closed");
}
{
  const r = validate({ paths: ["packages/db/src/queries/x.ts"], body: "" });
  assert.equal(r.ok, false);
  ok("an empty PR body on an implementation change fails closed");
}

// ---------------------------------- 3. implementation + placeholder ⇒ fail
{
  // The shipped template verbatim: guidance lives in HTML comments, so after
  // stripping them the fields are empty. This is THE case that decides whether
  // the control is real.
  const shipped = [
    `## ${SECTION_HEADING}`,
    "",
    "<!--",
    "Required when this PR changes implementation, schema, runtime, config or workflows.",
    "Identify the owning artifact through docs/README.md.",
    "-->",
    "",
    "- **Result:** `updated` | `none`",
    "- **Owning current-state docs reviewed:** <!-- e.g. docs/architecture.md -->",
    "- **Reason:** <!-- what claim changed and where the correction landed -->",
  ].join("\n");
  const r = validate({ paths: ["apps/web/src/app/api/chat/route.ts"], body: shipped });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3, "result, docs and reason all fail");
  assert.match(r.errors.join(" "), /Result must be exactly/);
  assert.match(r.errors.join(" "), /Owning current-state docs reviewed.*placeholder/);
  assert.match(r.errors.join(" "), /Reason.*placeholder/);
  ok("the UNFILLED shipped template fails on all three fields");
}
{
  const r = validate({
    paths: ["packages/agent/src/graph.ts"],
    body: body({ reason: "TODO" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /Reason.*placeholder/);
  ok("`TODO` as a reason is rejected");
}
{
  const r = validate({ paths: ["packages/agent/src/graph.ts"], body: body({ reason: "n/a" }) });
  assert.equal(r.ok, false);
  ok("`n/a` as a reason is rejected");
}
{
  const r = validate({ paths: ["packages/agent/src/graph.ts"], body: body({ reason: "no impact" }) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /too short/);
  assert.ok("no impact".length < MIN_REASON_CHARS);
  ok("a reason below the anti-emptiness floor is rejected");
}
{
  const r = validate({ paths: ["packages/agent/src/graph.ts"], body: body({ docs: "none" }) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /placeholder/);
  ok("`none` as the reviewed-docs field is a placeholder, not an artifact");
}
{
  const r = validate({
    paths: ["packages/agent/src/graph.ts"],
    body: body({ docs: "the architecture manual" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /must name at least one document path/);
  ok("naming an artifact in prose without a path is rejected");
}
{
  const r = validate({ paths: ["packages/agent/src/graph.ts"], body: body({ result: "maybe" }) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /Result must be exactly/);
  ok("a result outside {updated, none} is rejected");
}

// ------------------------------------ 4. implementation + `updated` ⇒ pass
{
  const r = validate({
    paths: [
      "packages/db/forward/supabase/migrations/20260908_add_thing.sql",
      "docs/architecture.md",
    ],
    body: body({
      result: "updated",
      docs: "`docs/architecture.md`, `docs/operational-cases/architecture.md`",
      reason:
        "The new table made the Modelo de datos migration list incomplete; the corrected list landed in this PR.",
    }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.result, "updated");
  ok("`updated` with a named owning artifact and a real rationale passes");
}

// ----------------------- 5. implementation + `none` + rationale ⇒ pass
{
  const r = validate({
    paths: ["apps/web/src/lib/relationship-admission/policy.ts"],
    body: body({
      result: "none",
      docs: "`docs/architecture.md`, `docs/manuals/architecture-manual.md`",
      reason:
        "Both describe admission as implemented but not route/cron wired; this change alters neither the wiring nor the schema.",
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.result, "none");
  ok("`none` with a substantive rationale passes — no documentation churn required");
}
{
  // Formatting must not be load-bearing: plain fields, no bullets, no emphasis.
  const plain = [
    `### ${SECTION_HEADING}`,
    "Result: none",
    "Owning current-state docs reviewed: docs/architecture.md",
    "Reason: Inspected the runtime diagram and the data-model section; nothing this PR changes appears in either.",
  ].join("\n");
  const r = validate({ paths: ["packages/types/src/index.ts"], body: plain });
  assert.equal(r.ok, true);
  ok("an unbulleted, unemphasised declaration under an h3 parses and passes");
}

// ------------------------------------------ 6. push / non-PR context handled
{
  // The CLI decides push-vs-PR; the pure layer's contract is that an absent
  // body is only a failure when a path actually triggered. Both halves pinned.
  assert.equal(validate({ paths: ["docs/architecture.md"], body: undefined }).ok, true);
  assert.equal(validate({ paths: [], body: undefined }).ok, true);
  assert.equal(validate({ paths: ["packages/agent/src/graph.ts"], body: undefined }).ok, false);
  ok("an absent body is fine unless a path triggered (push handling lives in the CLI)");
}

// ------------------------------------------------- path classification edges
{
  const { triggering, ignored } = classifyPaths([
    "packages/db/supabase/migrations/00085_x.sql",
    "packages/db/forward/supabase/migrations/20260908_y.sql",
    "packages/agent/src/graph.ts",
    "apps/web/src/app/api/cron/heartbeat/route.ts",
    "skills/global/company-data/SKILL.md",
    ".github/workflows/ci.yml",
    "scripts/verify-admission.ts",
    "package.json",
    "turbo.json",
  ]);
  assert.equal(ignored.length, 0);
  assert.equal(triggering.length, 9);
  ok("every implementation class the audit implicated triggers");
}
{
  const { triggering, ignored } = classifyPaths([
    "docs/architecture.md",
    "docs/product/roadmap-increments/r1-relationship-operations-v1/slice-plan.md",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "docs/development/templates/slice-plan-template.md",
  ]);
  assert.equal(triggering.length, 0);
  assert.equal(ignored.length, 6);
  ok("documentation and governance Markdown never triggers");
}
{
  // A SKILL.md is a playbook loaded into the system prompt — runtime behavior
  // authored in Markdown. It must NOT be swept up by the "*.md is docs" rule.
  assert.equal(requiresDeclaration(["skills/global/company-data/SKILL.md"]), true);
  assert.equal(requiresDeclaration(["docs/architecture.md"]), false);
  ok("skills/**/*.md triggers while docs/**/*.md does not");
}
{
  // Mixed PR: one implementation file among many docs still triggers.
  const { triggering } = classifyPaths([
    "docs/architecture.md",
    "docs/manuals/architecture-manual.md",
    "packages/db/src/queries/operational-cases.ts",
  ]);
  assert.deepEqual(triggering, ["packages/db/src/queries/operational-cases.ts"]);
  ok("a single implementation file among documentation changes still triggers");
}
{
  // Windows-style separators from a git wrapper must not defeat classification.
  assert.equal(requiresDeclaration(["packages\\agent\\src\\graph.ts"]), true);
  ok("backslash separators are normalised before matching");
}
{
  // Non-source assets under packages/ are not implementation by this rule.
  const { triggering, ignored } = classifyPaths([
    "packages/agent/README.md",
    "packages/db/notes.txt",
  ]);
  assert.equal(triggering.length, 0);
  assert.equal(ignored.length, 2);
  ok("a package README and a stray text file do not trigger");
}

// ------------------------------------------------------- workspace manifests
{
  // This is an npm workspaces monorepo: a workspace manifest can change
  // dependencies, integrations, runtime scripts or composition without touching
  // a single .ts file. Matching only the root manifest let that bypass the
  // assessment entirely.
  const { triggering, ignored } = classifyPaths([
    "package.json",
    "package-lock.json",
    "apps/web/package.json",
    "packages/agent/package.json",
    "packages/workflows/package.json",
    "turbo.json",
  ]);
  assert.equal(ignored.length, 0);
  assert.equal(triggering.length, 6);
  ok("root, workspace and lockfile manifests all trigger");
}
{
  assert.equal(requiresDeclaration(["apps/web/package.json"]), true);
  assert.equal(requiresDeclaration(["packages/db/package.json"]), true);
  assert.equal(requiresDeclaration(["package-lock.json"]), true);
  ok("each manifest class triggers on its own, not only in combination");
}
{
  // The manifest rule must stay a manifest rule. It is scoped to files LITERALLY
  // named package.json / package-lock.json / turbo.json — not to config-shaped
  // JSON in general, which is where a small rule turns into an ontology.
  const { triggering, ignored } = classifyPaths([
    "apps/web/README.md",
    "apps/web/tsconfig.json",
    "packages/agent/tsconfig.json",
    "packages/agent/src/usage/catalogs/openrouter-2026-08.json",
    "apps/web/.eslintrc.json",
    "docs/architecture.md",
  ]);
  assert.equal(triggering.length, 0, `unexpected trigger: ${triggering.join(", ")}`);
  assert.equal(ignored.length, 6);
  ok("a workspace README, tsconfig, lint config and JSON data asset do NOT trigger");
}
{
  // Build output is gitignored so it never reaches a diff, but the rule is
  // scoped to one directory level anyway, so a stray nested manifest cannot
  // sneak in through a build artifact path.
  assert.equal(requiresDeclaration(["apps/web/.next/package.json"]), false);
  ok("a nested build-output manifest does not trigger");
}

// ------------------------------------------------------------ parser details
{
  assert.equal(stripHtmlComments("a <!-- b --> c"), "a  c");
  assert.equal(stripHtmlComments("a <!--\nmulti\nline\n--> c"), "a  c");
  ok("HTML comments are stripped, including multi-line ones");
}
{
  assert.equal(parseDeclaration("no heading here"), null);
  ok("a body without the heading parses as absent, not as malformed");
}
{
  // The section must stop at the next heading, so a later "Reason:" in an
  // unrelated section cannot be borrowed to satisfy this one.
  const b = [
    `## ${SECTION_HEADING}`,
    "- **Result:** `none`",
    "- **Owning current-state docs reviewed:** docs/architecture.md",
    "## Something else",
    "- **Reason:** borrowed from the wrong section entirely",
  ].join("\n");
  const parsed = parseDeclaration(b);
  assert.equal(parsed.reason, null);
  assert.equal(validate({ paths: ["packages/agent/src/graph.ts"], body: b }).ok, false);
  ok("the section ends at the next heading — fields cannot be borrowed from below");
}
{
  // Heading matching is case-insensitive and tolerant of level.
  for (const h of ["# " + SECTION_HEADING, "###### " + SECTION_HEADING, "## " + SECTION_HEADING.toUpperCase()]) {
    assert.notEqual(parseDeclaration(body({ heading: h })), null, h);
  }
  ok("the heading matches at any level, case-insensitively");
}

console.log(`architecture-impact selftest: ${passed} checks passed`);
