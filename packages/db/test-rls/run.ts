/**
 * Cross-tenant / RLS negative suite — R1 Relationship Operations.
 *
 * Landed at SL-0 and extended by every Slice that adds a multi-seat surface:
 * SL-2 added `organization_policies` and `source_events`; SL-3 added the
 * M-RESOLUTION-IDENTITY indexes; SL-4 the Case Subjects and wake identity;
 * SL-7 `portfolio_presentation_state` and the Work Portfolio read paths; SL-12
 * the chat tool's Organization resolution and the ranking kill switch; Cycle 3
 * order 5 `tool_calls` as read-own and not user-writable; SL-6
 * `external_conversation_bindings`.
 *
 * Technical Plan §8: "Cross-tenant negative suite (two-orgs fixture, read and
 * write paths) required from SL-0 and gating every multi-seat surface."
 *
 * Why this is a separate runner: every other DB test in this repo runs against
 * an in-memory fake Supabase client, which can simulate a unique constraint or
 * an append-only trigger but CANNOT enforce row-level security. Permissive /
 * restrictive composition, auth.uid() resolution and SECURITY DEFINER behaviour
 * are PostgreSQL semantics — asserting them against a fake would only prove the
 * fake agrees with itself. So this suite applies the real migration chain to a
 * real PostgreSQL and exercises the real policies.
 *
 * Usage:  DATABASE_URL=postgres://... npm run test:rls --workspace @agents/db
 *
 * The target database is DESTROYED and rebuilt on every run. Never point it at
 * anything but a disposable instance; the runner refuses obvious remotes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "supabase", "migrations");
/** Forward-only era (B′) — applied after the frozen legacy chain. */
const FORWARD_DIR = path.resolve(__dirname, "..", "forward", "supabase", "migrations");

const RLS_VIOLATION = "42501";
const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
/** PL/pgSQL RAISE EXCEPTION without an explicit SQLSTATE. */
const RAISE_EXCEPTION = "P0001";

type Role = "anon" | "authenticated" | "service_role";
interface Claims {
  sub?: string;
  role: Role;
}

let passed = 0;
async function t(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ============================================================
// Harness
// ============================================================

function requireDisposableUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Point it at a DISPOSABLE PostgreSQL (pgvector " +
        "image) — this suite drops and rebuilds the schema."
    );
  }
  if (/supabase\.(co|in)|amazonaws\.com|\.render\.com|neon\.tech/i.test(url)) {
    throw new Error(
      "DATABASE_URL looks like a hosted database. Refusing to run: this suite " +
        "drops schemas. Use a local throwaway instance."
    );
  }
  return url;
}

async function applySqlFile(client: Client, file: string): Promise<void> {
  const sql = await fs.readFile(file, "utf8");
  try {
    await client.query(sql);
  } catch (error) {
    throw new Error(
      `Failed applying ${path.basename(file)}: ${(error as Error).message}`
    );
  }
}

async function rebuildSchema(client: Client): Promise<void> {
  await client.query(`
    drop schema if exists public cascade;
    drop schema if exists storage cascade;
    drop schema if exists auth cascade;
    create schema public;
  `);

  await applySqlFile(client, path.join(__dirname, "platform-shim.sql"));

  // Era 1 — the frozen legacy chain, applied by ordered-apply in full-filename
  // order (what disambiguates the duplicated numeric prefixes).
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const migrations = entries.filter((n) => n.endsWith(".sql")).sort();
  for (const name of migrations) {
    await applySqlFile(client, path.join(MIGRATIONS_DIR, name));
  }

  // Era 2 — the forward-only era (B′), applied after it in timestamp order, so
  // a fresh rebuild exercises `legacy → forward` exactly as a real environment
  // composes them. Legitimately empty until the first post-cutover migration;
  // the loop is the contract, not the count.
  let forward: string[] = [];
  try {
    forward = (await fs.readdir(FORWARD_DIR)).filter((n) => n.endsWith(".sql")).sort();
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  for (const name of forward) {
    await applySqlFile(client, path.join(FORWARD_DIR, name));
  }

  await applySqlFile(client, path.join(__dirname, "grants.sql"));
  console.log(
    `  applied platform shim + ${migrations.length} legacy + ${forward.length} forward migrations + grants`
  );
}

/**
 * Run `fn` with the request-scoped JWT claims and PostgreSQL role a real
 * request would carry. `set local role` is mandatory: the connection user is a
 * superuser and would otherwise bypass RLS entirely, making every assertion
 * vacuous. Always rolled back, so cases cannot leak into each other.
 */
async function asRole<T>(
  client: Client,
  claims: Claims,
  fn: () => Promise<T>
): Promise<T> {
  const role = claims.role;
  if (role !== "anon" && role !== "authenticated" && role !== "service_role") {
    throw new Error(`unsupported role: ${String(role)}`);
  }
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await client.query(`set local role ${role}`);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/** SQLSTATE of an expected failure, or null when the call unexpectedly succeeded. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

// ============================================================
// Fixture — two Organizations, an inactive member, a legacy user
// ============================================================

interface Fixture {
  orgA: string;
  orgB: string;
  creatorA: string;
  memberA2: string;
  revokedA: string;
  memberB: string;
  legacyUser: string;
  caseType: string;
  caseTypeId: string;
  orgCaseA: string;
  orgCaseA2: string;
  orgCaseB: string;
  legacyCase: string;
  /**
   * A second legacy Case with NO facts. `case_facts` is append-only by trigger,
   * so deleting a Case that has facts fails on the cascade for a reason that
   * has nothing to do with row-level security — the DELETE assertion needs a
   * Case whose cascade is empty to actually test the policy.
   */
  legacyCaseNoFacts: string;
  /** Seeded by the SL-2 migration; needed by the materialisation-identity checks. */
  leadOpportunityTypeId: string;
}

async function seed(client: Client): Promise<Fixture> {
  const users = {
    creatorA: randomUUID(),
    memberA2: randomUUID(),
    revokedA: randomUUID(),
    memberB: randomUUID(),
    legacyUser: randomUUID(),
  };

  // profiles are created by the handle_new_user trigger on auth.users (00001).
  for (const [name, id] of Object.entries(users)) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      id,
      `${name}@example.test`,
    ]);
  }

  // 00022 moved the case-type primary key to `id` and turned `case_type` into a
  // partial unique index (global types only), so cases carry BOTH the text key
  // and the NOT NULL `case_type_id`. The schema is rebuilt per run, so a plain
  // insert is enough — no conflict target to infer.
  const caseType = "lead_opportunity_rls_fixture";
  const caseTypeId = (
    await client.query<{ id: string }>(
      `insert into public.operational_case_types (case_type, display_name, default_skill_slug)
       values ($1, 'RLS fixture', 'noop')
       returning id`,
      [caseType]
    )
  ).rows[0].id;

  const org = async (name: string) =>
    (
      await client.query<{ id: string }>(
        "insert into public.organizations (name) values ($1) returning id",
        [name]
      )
    ).rows[0].id;

  const orgA = await org("Org A");
  const orgB = await org("Org B");

  const membership = (o: string, u: string, status: string) =>
    client.query(
      `insert into public.organization_memberships (organization_id, user_id, role, status)
       values ($1, $2, 'advisor', $3)`,
      [o, u, status]
    );

  await membership(orgA, users.creatorA, "active");
  await membership(orgA, users.memberA2, "active");
  await membership(orgA, users.revokedA, "inactive");
  await membership(orgB, users.memberB, "active");

  const newCase = async (user: string, organization: string | null) =>
    (
      await client.query<{ id: string }>(
        `insert into public.operational_cases
           (user_id, case_type, case_type_id, organization_id)
         values ($1, $2, $3, $4) returning id`,
        [user, caseType, caseTypeId, organization]
      )
    ).rows[0].id;

  // revokedA is the historical creator of orgCaseA2 — that is what makes the
  // "revoked creator" assertion meaningful rather than incidental.
  const orgCaseA = await newCase(users.creatorA, orgA);
  const orgCaseA2 = await newCase(users.revokedA, orgA);
  const orgCaseB = await newCase(users.memberB, orgB);
  const legacyCase = await newCase(users.legacyUser, null);
  const legacyCaseNoFacts = await newCase(users.legacyUser, null);

  const fact = (caseId: string, userId: string) =>
    client.query(
      `insert into public.case_facts (case_id, user_id, fact_key, value_jsonb, source_kind)
       values ($1, $2, 'opportunity.objective', '{"v":1}'::jsonb, 'derived')`,
      [caseId, userId]
    );
  await fact(orgCaseA, users.creatorA);
  await fact(orgCaseA2, users.revokedA);
  await fact(legacyCase, users.legacyUser);

  await client.query(
    `insert into public.case_relationships
       (organization_id, from_case_id, to_case_id, relationship_type)
     values ($1, $2, $3, 'duplicate_of')`,
    [orgA, orgCaseA, orgCaseA2]
  );

  const leadOpportunityTypeId = (
    await client.query<{ id: string }>(
      `select id from public.operational_case_types
        where case_type = 'lead_opportunity' and user_id is null`
    )
  ).rows[0].id;

  return {
    orgA,
    orgB,
    caseType,
    caseTypeId,
    leadOpportunityTypeId,
    orgCaseA,
    orgCaseA2,
    orgCaseB,
    legacyCase,
    legacyCaseNoFacts,
    ...users,
  };
}

// ============================================================
// Suite
// ============================================================

async function main(): Promise<void> {
  const url = requireDisposableUrl();
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    console.log("R1 — cross-tenant / RLS suite\n");
    await rebuildSchema(client);
    const f = await seed(client);
    console.log("  seeded 2 Organizations, 5 users, 4 Cases\n");

    const authed = (sub: string): Claims => ({ sub, role: "authenticated" });
    const service: Claims = { role: "service_role" };

    const countCases = (claims: Claims, id: string) =>
      asRole(client, claims, async () =>
        (
          await client.query(
            "select id from public.operational_cases where id = $1",
            [id]
          )
        ).rowCount
      );

    const countFacts = (claims: Claims, caseId: string) =>
      asRole(client, claims, async () =>
        (
          await client.query(
            "select id from public.case_facts where case_id = $1",
            [caseId]
          )
        ).rowCount
      );

    // ---------------------------------------------------------------
    console.log("operational_cases — read paths");

    await t("active member who is not the creator reads an Organization Case", async () => {
      assert.equal(await countCases(authed(f.memberA2), f.orgCaseA), 1);
    });

    await t("revoked creator is denied on the Case they created", async () => {
      assert.equal(await countCases(authed(f.revokedA), f.orgCaseA2), 0);
    });

    await t("active member of another Organization is denied", async () => {
      assert.equal(await countCases(authed(f.memberB), f.orgCaseA), 0);
    });

    await t("legacy owner still reads their own NULL-Organization Case", async () => {
      assert.equal(await countCases(authed(f.legacyUser), f.legacyCase), 1);
    });

    await t("legacy Case is invisible to an unrelated user", async () => {
      assert.equal(await countCases(authed(f.memberA2), f.legacyCase), 0);
    });

    // ---------------------------------------------------------------
    console.log("\noperational_cases — write paths (membership grants READ only)");

    await t("creator who is an active member cannot UPDATE an Organization Case", async () => {
      const affected = await asRole(client, authed(f.creatorA), async () =>
        (
          await client.query(
            "update public.operational_cases set status = 'paused' where id = $1",
            [f.orgCaseA]
          )
        ).rowCount
      );
      assert.equal(affected, 0);
    });

    await t("creator who is an active member cannot DELETE an Organization Case", async () => {
      const affected = await asRole(client, authed(f.creatorA), async () =>
        (
          await client.query("delete from public.operational_cases where id = $1", [
            f.orgCaseA,
          ])
        ).rowCount
      );
      assert.equal(affected, 0);
    });

    await t("authenticated user cannot INSERT an Organization-owned Case", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query(
            `insert into public.operational_cases
               (user_id, case_type, case_type_id, organization_id)
             values ($1, $2, $3, $4)`,
            [f.creatorA, f.caseType, f.caseTypeId, f.orgA]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("legacy owner retains UPDATE on their own NULL-Organization Case", async () => {
      const affected = await asRole(client, authed(f.legacyUser), async () =>
        (
          await client.query(
            "update public.operational_cases set status = 'paused' where id = $1",
            [f.legacyCase]
          )
        ).rowCount
      );
      assert.equal(affected, 1);
    });

    await t("legacy owner retains DELETE on their own NULL-Organization Case", async () => {
      const affected = await asRole(client, authed(f.legacyUser), async () =>
        (
          await client.query("delete from public.operational_cases where id = $1", [
            f.legacyCaseNoFacts,
          ])
        ).rowCount
      );
      assert.equal(affected, 1);
    });

    await t("legacy owner cannot adopt their Case into an Organization", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.legacyUser), () =>
          client.query(
            "update public.operational_cases set organization_id = $1 where id = $2",
            [f.orgA, f.legacyCase]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("service role can write Organization-owned Cases", async () => {
      const affected = await asRole(client, service, async () =>
        (
          await client.query(
            "update public.operational_cases set status = 'paused' where id = $1",
            [f.orgCaseA]
          )
        ).rowCount
      );
      assert.equal(affected, 1);
    });

    // ---------------------------------------------------------------
    console.log("\nCase child surfaces — resolved through the parent Case");

    await t("active member reads Organization Case facts", async () => {
      assert.equal(await countFacts(authed(f.memberA2), f.orgCaseA), 1);
    });

    await t("revoked creator is denied on the children of their Case", async () => {
      assert.equal(await countFacts(authed(f.revokedA), f.orgCaseA2), 0);
    });

    await t("member of another Organization is denied on children", async () => {
      assert.equal(await countFacts(authed(f.memberB), f.orgCaseA), 0);
    });

    await t("legacy owner still reads their own Case facts", async () => {
      assert.equal(await countFacts(authed(f.legacyUser), f.legacyCase), 1);
    });

    // ---------------------------------------------------------------
    console.log("\ncase_relationships — ADR-109 §9 Organization containment");

    await t("cross-Organization edge is rejected by the database itself", async () => {
      const code = await errorCode(() =>
        client.query(
          `insert into public.case_relationships
             (organization_id, from_case_id, to_case_id, relationship_type)
           values ($1, $2, $3, 'duplicate_of')`,
          [f.orgA, f.orgCaseA, f.orgCaseB]
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("a legacy NULL-Organization Case cannot be an endpoint", async () => {
      const code = await errorCode(() =>
        client.query(
          `insert into public.case_relationships
             (organization_id, from_case_id, to_case_id, relationship_type)
           values ($1, $2, $3, 'duplicate_of')`,
          [f.orgA, f.orgCaseA, f.legacyCase]
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("active member reads edges in their Organization", async () => {
      const rows = await asRole(client, authed(f.memberA2), async () =>
        (await client.query("select id from public.case_relationships")).rowCount
      );
      assert.equal(rows, 1);
    });

    await t("member of another Organization sees no edges", async () => {
      const rows = await asRole(client, authed(f.memberB), async () =>
        (await client.query("select id from public.case_relationships")).rowCount
      );
      assert.equal(rows, 0);
    });

    await t("authenticated user cannot write an edge", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query(
            `insert into public.case_relationships
               (organization_id, from_case_id, to_case_id, relationship_type)
             values ($1, $2, $3, 'split_from')`,
            [f.orgA, f.orgCaseA, f.orgCaseA2]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    // ---------------------------------------------------------------
    console.log("\nSL-2 organization_policies — TD-2 / ADR-108");

    // published_by is populated deliberately: without it the provenance
    // immutability checks and the FK check below would both pass vacuously.
    await client.query(
      `insert into public.organization_policies
         (organization_id, policy_type, version, status, policy_jsonb,
          nl_intent_source, published_by, published_at)
       values ($1, 'relationship_admission', 1, 'published',
               '{"excluded_categories":[],"auto_admit_clear_objectives":true,"trusted_sources":[]}'::jsonb,
               'admitimos compras y rentas residenciales', $2, now())`,
      [f.orgA, f.memberA2]
    );

    const countPolicies = (claims: Claims) =>
      asRole(client, claims, async () =>
        (await client.query("select id from public.organization_policies")).rowCount
      );

    await t("active member reads their Organization policy", async () => {
      assert.equal(await countPolicies(authed(f.memberA2)), 1);
    });

    await t("member of another Organization reads no policy", async () => {
      assert.equal(await countPolicies(authed(f.memberB)), 0);
    });

    await t("revoked member reads no policy", async () => {
      assert.equal(await countPolicies(authed(f.revokedA)), 0);
    });

    await t("authenticated user cannot write a policy", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query(
            `insert into public.organization_policies
               (organization_id, policy_type, version, status)
             values ($1, 'relationship_admission', 9, 'draft')`,
            [f.orgA]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("a second published policy of the same type is rejected", async () => {
      // Exactly one effective policy per (Organization, type) at every instant.
      const code = await errorCode(() =>
        client.query(
          `insert into public.organization_policies
             (organization_id, policy_type, version, status, published_at)
           values ($1, 'relationship_admission', 2, 'published', now())`,
          [f.orgA]
        )
      );
      assert.equal(code, UNIQUE_VIOLATION);
    });

    // ADR-108 §4: published versions are immutable. A disposition that
    // attributed this version must keep meaning what it meant, so the pinned
    // set includes publication PROVENANCE, not only the policy body.
    const immutableColumns: Array<[string, string]> = [
      [
        "policy_jsonb",
        `policy_jsonb = '{"excluded_categories":["land"],"auto_admit_clear_objectives":false,"trusted_sources":[]}'::jsonb`,
      ],
      ["nl_intent_source", "nl_intent_source = 'rewritten intent'"],
      ["published_by", "published_by = null"],
      ["published_at", "published_at = now() + interval '1 day'"],
      ["created_at", "created_at = now() - interval '1 year'"],
      ["version", "version = 99"],
      ["policy_type", "policy_type = 'relationship_admission'::text"],
      ["status back to draft", "status = 'draft'"],
    ];

    for (const [label, assignment] of immutableColumns) {
      await t(`a published policy cannot change ${label}`, async () => {
        const code = await errorCode(() =>
          client.query(
            `update public.organization_policies
                set ${assignment}
              where organization_id = $1 and status = 'published'`,
            [f.orgA]
          )
        );
        assert.equal(code, RAISE_EXCEPTION);
      });
    }

    await t("deleting the profile that published a policy is refused", async () => {
      // `on delete set null` would let a profile deletion silently rewrite the
      // publication provenance of a row ADR-108 declares immutable. NO ACTION
      // refuses instead, matching workflow_definitions (00065).
      //
      // memberA2 is used because they own no Cases: deleting a Case-owning
      // profile trips the append-only case_facts trigger on the cascade first,
      // which would make this assertion pass for the wrong reason.
      const code = await errorCode(() =>
        client.query("delete from auth.users where id = $1", [f.memberA2])
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("a published policy cannot be deleted", async () => {
      const code = await errorCode(() =>
        client.query(
          "delete from public.organization_policies where organization_id = $1 and status = 'published'",
          [f.orgA]
        )
      );
      assert.equal(code, RAISE_EXCEPTION);
    });

    await t("a published policy CAN be archived", async () => {
      await client.query(
        `update public.organization_policies
            set status = 'archived'
          where organization_id = $1 and status = 'published'`,
        [f.orgA]
      );
      const { rowCount } = await client.query(
        "select id from public.organization_policies where organization_id = $1 and status = 'archived'",
        [f.orgA]
      );
      assert.equal(rowCount, 1);
    });

    // ---------------------------------------------------------------
    // SL-2 claim fencing — PostgreSQL semantics the FakeDb cannot prove.
    //
    // The module selftests drive the real executor against an in-memory client,
    // which is faithful for sequential behaviour but single-threaded: two
    // conditional UPDATEs racing for one row, and a UNIQUE index rejecting the
    // loser of a concurrent INSERT, are database properties. Simulating them
    // would only prove the fake agrees with itself — the same reason this suite
    // exists for RLS.
    //
    // Each statement below is the exact conditional write the query helpers
    // issue, so what passes here is what the application does.
    // ---------------------------------------------------------------
    console.log("\nSL-2 source_events — claim fencing and lease ownership");

    const newEvent = async (organization: string, key: string) =>
      (
        await client.query<{ id: string }>(
          `insert into public.source_events
             (organization_id, source_system, event_kind, dedup_key, status, claim_epoch)
           values ($1, 'traditional_gu', 'inbound_prospect_message', $2, 'pending', 0)
           returning id`,
          [organization, key]
        )
      ).rows[0].id;

    /** claimSourceEvent: pending + observed epoch. */
    const claim = (
      eventId: string,
      worker: string,
      observedEpoch: number,
      leaseSeconds: number
    ) =>
      client.query(
        `update public.source_events
            set status = 'processing',
                claim_epoch = $3 + 1,
                claimed_at = now(),
                claimed_by = $2,
                claim_expires_at = now() + make_interval(secs => $4)
          where id = $1
            and status = 'pending'
            and claim_epoch = $3
          returning claim_epoch`,
        [eventId, worker, observedEpoch, leaseSeconds]
      );

    /** reclaimSourceEvent, expired-lease branch. */
    const reclaim = (
      eventId: string,
      worker: string,
      observedEpoch: number,
      leaseSeconds: number
    ) =>
      client.query(
        `update public.source_events
            set status = 'processing',
                claim_epoch = $3 + 1,
                claimed_at = now(),
                claimed_by = $2,
                claim_expires_at = now() + make_interval(secs => $4)
          where id = $1
            and status = 'processing'
            and claim_epoch = $3
            and claim_expires_at <= now()
          returning claim_epoch`,
        [eventId, worker, observedEpoch, leaseSeconds]
      );

    /** Every fenced write: epoch + status = 'processing'. */
    const fenced = (eventId: string, epoch: number, assignment: string) =>
      client.query(
        `update public.source_events
            set ${assignment}
          where id = $1
            and status = 'processing'
            and claim_epoch = $2
          returning id`,
        [eventId, epoch]
      );

    await t("two workers racing for one pending event produce one winner", async () => {
      const eventId = await newEvent(f.orgA, "fence:race");
      const [first, second] = await Promise.all([
        claim(eventId, "worker-a", 0, 300),
        claim(eventId, "worker-b", 0, 300),
      ]);
      assert.equal(
        (first.rowCount ?? 0) + (second.rowCount ?? 0),
        1,
        "exactly one claim may win"
      );
      const { rows } = await client.query<{ claim_epoch: number }>(
        "select claim_epoch from public.source_events where id = $1",
        [eventId]
      );
      assert.equal(rows[0].claim_epoch, 1, "the fence advanced exactly once");
    });

    await t("a live claim cannot be reclaimed", async () => {
      const eventId = await newEvent(f.orgA, "fence:live");
      await claim(eventId, "worker-a", 0, 300);
      const stolen = await reclaim(eventId, "worker-b", 1, 300);
      assert.equal(stolen.rowCount, 0, "a live lease is not reclaimable");
    });

    await t("an expired claim is reclaimable and bumps the fence", async () => {
      const eventId = await newEvent(f.orgA, "fence:expired");
      await claim(eventId, "worker-a", 0, 0);
      const reclaimed = await reclaim(eventId, "worker-b", 1, 300);
      assert.equal(reclaimed.rowCount, 1);
      assert.equal(reclaimed.rows[0].claim_epoch, 2);
    });

    /**
     * The blocker: a stale owner resuming after losing the lease. Each of its
     * durable writes must match zero rows.
     */
    const staleOwnerFixture = async (key: string) => {
      const eventId = await newEvent(f.orgA, key);
      await claim(eventId, "worker-a", 0, 0); // A owns epoch 1, already expired
      await reclaim(eventId, "worker-b", 1, 300); // B owns epoch 2
      return eventId;
    };

    await t("a stale owner cannot record a decision after reclaim", async () => {
      const eventId = await staleOwnerFixture("fence:stale-decide");
      const stale = await fenced(
        eventId,
        1,
        `decision_jsonb = '{"disposition":"not_admitted"}'::jsonb`
      );
      assert.equal(stale.rowCount, 0);
      const { rows } = await client.query<{ decision_jsonb: unknown }>(
        "select decision_jsonb from public.source_events where id = $1",
        [eventId]
      );
      assert.equal(rows[0].decision_jsonb, null);
    });

    await t("a stale owner cannot link a Case after reclaim", async () => {
      const eventId = await staleOwnerFixture("fence:stale-link");
      const stale = await fenced(eventId, 1, `admitted_case_id = '${f.orgCaseA}'`);
      assert.equal(stale.rowCount, 0);
      const { rows } = await client.query<{ admitted_case_id: string | null }>(
        "select admitted_case_id from public.source_events where id = $1",
        [eventId]
      );
      assert.equal(rows[0].admitted_case_id, null);
    });

    await t("a stale owner cannot settle after reclaim", async () => {
      const eventId = await staleOwnerFixture("fence:stale-settle");
      const stale = await fenced(
        eventId,
        1,
        `status = 'completed', completed_at = now(),
         decision_jsonb = '{"disposition":"not_admitted"}'::jsonb`
      );
      assert.equal(stale.rowCount, 0);
      const { rows } = await client.query<{ status: string }>(
        "select status from public.source_events where id = $1",
        [eventId]
      );
      assert.equal(rows[0].status, "processing", "B still owns a live claim");
    });

    await t("a stale owner cannot fail the new owner's row", async () => {
      const eventId = await staleOwnerFixture("fence:stale-fail");
      const stale = await fenced(
        eventId,
        1,
        `status = 'failed', processing_error = 'stale worker'`
      );
      assert.equal(stale.rowCount, 0);
      const { rows } = await client.query<{
        status: string;
        processing_error: string | null;
      }>(
        "select status, processing_error from public.source_events where id = $1",
        [eventId]
      );
      assert.equal(rows[0].status, "processing");
      assert.equal(rows[0].processing_error, null);
    });

    await t("the new owner completes normally after the stale attempts", async () => {
      const eventId = await staleOwnerFixture("fence:new-owner-wins");
      await fenced(eventId, 1, `status = 'failed'`); // stale, no-op
      const settled = await fenced(
        eventId,
        2,
        `status = 'completed', completed_at = now(),
         decision_jsonb = '{"disposition":"not_admitted"}'::jsonb`
      );
      assert.equal(settled.rowCount, 1, "the current owner's write applies");
    });

    await t("a completed event cannot be reverted by any worker", async () => {
      const eventId = await staleOwnerFixture("fence:no-revert");
      await fenced(
        eventId,
        2,
        `status = 'completed', completed_at = now(),
         decision_jsonb = '{"disposition":"not_admitted"}'::jsonb`
      );
      // Neither the stale epoch nor the settling epoch may reopen it: every
      // fenced write also requires status = 'processing'.
      for (const epoch of [1, 2]) {
        const revert = await fenced(eventId, epoch, `status = 'failed'`);
        assert.equal(revert.rowCount, 0, `epoch ${epoch} must not revert it`);
      }
      const { rows } = await client.query<{ status: string }>(
        "select status from public.source_events where id = $1",
        [eventId]
      );
      assert.equal(rows[0].status, "completed");
    });

    await t("a completed event must carry its decision", async () => {
      // Structural, so it holds for every service-role writer — including the
      // C1 ingestion path that will write this same inbox later.
      const eventId = await newEvent(f.orgA, "fence:settled-shape");
      const code = await errorCode(() =>
        client.query(
          "update public.source_events set status = 'completed', completed_at = now() where id = $1",
          [eventId]
        )
      );
      assert.equal(code, CHECK_VIOLATION);
    });

    await t("a completed ADMITTED event must carry its Case", async () => {
      const eventId = await newEvent(f.orgA, "fence:settled-admitted");
      const code = await errorCode(() =>
        client.query(
          `update public.source_events
              set status = 'completed',
                  completed_at = now(),
                  decision_jsonb = '{"disposition":"admitted"}'::jsonb
            where id = $1`,
          [eventId]
        )
      );
      assert.equal(code, CHECK_VIOLATION);
    });

    await t("two workers cannot materialise two Cases for one source event", async () => {
      // The fence stops a stale worker writing to the inbox, but not one that
      // is already past it from INSERTing a Case. This index is what makes
      // "one source event admits at most one Opportunity" structural.
      const eventId = await newEvent(f.orgA, "fence:one-case");
      const insertCase = () =>
        client.query(
          `insert into public.operational_cases
             (user_id, case_type, case_type_id, organization_id, context_jsonb)
           values ($1, 'lead_opportunity', $2, $3, jsonb_build_object('source_event_id', $4::text))`,
          [f.creatorA, f.leadOpportunityTypeId, f.orgA, eventId]
        );
      await insertCase();
      const code = await errorCode(insertCase);
      assert.equal(code, UNIQUE_VIOLATION);

      const { rowCount } = await client.query(
        `select id from public.operational_cases
          where organization_id = $1
            and context_jsonb ->> 'source_event_id' = $2`,
        [f.orgA, eventId]
      );
      assert.equal(rowCount, 1, "exactly one Opportunity survives");
    });

    await t("a different source event may still materialise its own Case", async () => {
      const other = await newEvent(f.orgA, "fence:other-case");
      await client.query(
        `insert into public.operational_cases
           (user_id, case_type, case_type_id, organization_id, context_jsonb)
         values ($1, 'lead_opportunity', $2, $3, jsonb_build_object('source_event_id', $4::text))`,
        [f.creatorA, f.leadOpportunityTypeId, f.orgA, other]
      );
      const { rowCount } = await client.query(
        `select id from public.operational_cases
          where organization_id = $1 and context_jsonb ? 'source_event_id'`,
        [f.orgA]
      );
      assert.equal(rowCount, 2, "the index constrains the identity, not the type");
    });

    await t("concurrent workers cannot write two admission evidence rows", async () => {
      // The Case index stops a second Opportunity; it does nothing for the
      // Case's CHILDREN. Two workers inside materialisation at once — one whose
      // lease expired mid-run, one that reclaimed — can both reach the fact
      // writes, and a read-then-insert would let both observe "missing".
      const eventId = await newEvent(f.orgA, "artifact:facts");
      const insertFact = () =>
        client.query(
          `insert into public.case_facts
             (case_id, user_id, fact_key, value_jsonb, source_kind, source_ref)
           values ($1, $2, 'admission.disposition', '{"disposition":"admitted"}'::jsonb,
                   'derived', 'source_events:' || $3::text)`,
          [f.orgCaseA, f.creatorA, eventId]
        );
      const [first, second] = await Promise.allSettled([
        insertFact(),
        insertFact(),
      ]);
      const rejected = [first, second].filter((r) => r.status === "rejected");
      assert.equal(rejected.length, 1, "exactly one insert survives");
      assert.equal(
        (rejected[0] as PromiseRejectedResult).reason.code,
        UNIQUE_VIOLATION
      );

      const { rowCount } = await client.query(
        `select id from public.case_facts
          where case_id = $1
            and fact_key = 'admission.disposition'
            and source_ref = 'source_events:' || $2::text`,
        [f.orgCaseA, eventId]
      );
      assert.equal(rowCount, 1);
    });

    await t("a different writer's fact for the same key is unaffected", async () => {
      // The identity is (case, key, source_ref), NOT (case, key): a later
      // legitimate correction with its own provenance must still be writable,
      // and must not be blocked by admission's evidence.
      const eventId = await newEvent(f.orgA, "artifact:coexist");
      await client.query(
        `insert into public.case_facts
           (case_id, user_id, fact_key, value_jsonb, source_kind, source_ref)
         values ($1, $2, 'opportunity.objective', '{"objective":"comprar"}'::jsonb,
                 'derived', 'source_events:' || $3::text)`,
        [f.orgCaseA, f.creatorA, eventId]
      );
      await client.query(
        `insert into public.case_facts
           (case_id, user_id, fact_key, value_jsonb, source_kind, source_ref)
         values ($1, $2, 'opportunity.objective', '{"objective":"rentar"}'::jsonb,
                 'user', 'advisor_correction')`,
        [f.orgCaseA, f.creatorA]
      );
      // The fixture already seeds an opportunity.objective on this Case, so
      // count the two provenances this check wrote rather than the whole key.
      const { rows } = await client.query<{ source_ref: string | null }>(
        `select source_ref from public.case_facts
          where case_id = $1
            and fact_key = 'opportunity.objective'
            and source_ref is not null
          order by source_ref`,
        [f.orgCaseA]
      );
      assert.deepEqual(
        rows.map((r) => r.source_ref),
        ["advisor_correction", `source_events:${eventId}`],
        "both provenances coexist"
      );
    });

    await t("the free-form source_ref of other domains stays unconstrained", async () => {
      // The index is partial on `source_ref like 'source_events:%'`. Existing
      // writers reuse values such as 'readiness_owner_simulation', and must
      // keep being able to.
      for (let i = 0; i < 2; i += 1) {
        await client.query(
          `insert into public.case_facts
             (case_id, user_id, fact_key, value_jsonb, source_kind, source_ref)
           values ($1, $2, 'property.bedrooms', '3'::jsonb, 'user',
                   'readiness_owner_simulation')`,
          [f.orgCaseA, f.creatorA]
        );
      }
      const { rowCount } = await client.query(
        `select id from public.case_facts
          where case_id = $1 and source_ref = 'readiness_owner_simulation'`,
        [f.orgCaseA]
      );
      assert.equal(rowCount, 2, "non-admission provenance is not deduplicated");
    });

    await t("concurrent workers cannot narrate one admission twice", async () => {
      const eventId = await newEvent(f.orgA, "artifact:timeline");
      const insertEvent = () =>
        client.query(
          `insert into public.operational_case_events
             (case_id, event_type, actor, payload_jsonb)
           values ($1, 'state_changed', 'system',
                   jsonb_build_object('kind', 'admission_disposition',
                                      'source_event_id', $2::text))`,
          [f.orgCaseA, eventId]
        );
      const [first, second] = await Promise.allSettled([
        insertEvent(),
        insertEvent(),
      ]);
      const rejected = [first, second].filter((r) => r.status === "rejected");
      assert.equal(rejected.length, 1, "exactly one narration survives");
      assert.equal(
        (rejected[0] as PromiseRejectedResult).reason.code,
        UNIQUE_VIOLATION
      );
    });

    await t("other Case timeline events are unconstrained", async () => {
      // The index is partial on kind = 'admission_disposition'. The append-only
      // timeline must stay append-only for everything else.
      for (let i = 0; i < 2; i += 1) {
        await client.query(
          `insert into public.operational_case_events
             (case_id, event_type, actor, payload_jsonb)
           values ($1, 'state_changed', 'system',
                   jsonb_build_object('kind', 'step_completed'))`,
          [f.orgCaseA]
        );
      }
      const { rowCount } = await client.query(
        `select id from public.operational_case_events
          where case_id = $1 and payload_jsonb ->> 'kind' = 'step_completed'`,
        [f.orgCaseA]
      );
      assert.equal(rowCount, 2);
    });

    await t("a source event cannot point at another Organization's Case", async () => {
      const eventId = await newEvent(f.orgA, "fence:containment");
      await claim(eventId, "worker-a", 0, 300);
      const code = await errorCode(() =>
        fenced(eventId, 1, `admitted_case_id = '${f.orgCaseB}'`)
      );
      // Composite FK (admitted_case_id, organization_id), same shape as
      // case_relationships: a cross-tenant pointer is structurally impossible.
      assert.equal(code, FK_VIOLATION);
    });

    // ---------------------------------------------------------------
    console.log("\nSL-2 source_events — M-SOURCE-EVENTS");

    await client.query(
      `insert into public.source_events
         (organization_id, source_system, event_kind, dedup_key)
       values ($1, 'traditional_gu', 'inbound_prospect_message', 'traditional_gu:msg:lead-a:one')`,
      [f.orgA]
    );

    await t("the same dedup_key cannot be recorded twice for one Organization", async () => {
      // S1 AC-05 is a schema guarantee, not application discipline.
      const code = await errorCode(() =>
        client.query(
          `insert into public.source_events
             (organization_id, source_system, event_kind, dedup_key)
           values ($1, 'traditional_gu', 'inbound_prospect_message', 'traditional_gu:msg:lead-a:one')`,
          [f.orgA]
        )
      );
      assert.equal(code, UNIQUE_VIOLATION);
    });

    await t("two Organizations may carry the same dedup_key independently", async () => {
      await client.query(
        `insert into public.source_events
           (organization_id, source_system, event_kind, dedup_key)
         values ($1, 'traditional_gu', 'inbound_prospect_message', 'traditional_gu:msg:lead-a:one')`,
        [f.orgB]
      );
      const { rowCount } = await client.query(
        "select id from public.source_events where dedup_key = 'traditional_gu:msg:lead-a:one'"
      );
      assert.equal(rowCount, 2);
    });

    await t("source_events is unreadable from any authenticated JWT, member or not", async () => {
      // TD-1 access matrix: operational internals, service-role only in BOTH
      // directions. Even an active member of the owning Organization sees none.
      const asMember = await asRole(client, authed(f.memberA2), async () =>
        (await client.query("select id from public.source_events")).rowCount
      );
      const asOther = await asRole(client, authed(f.memberB), async () =>
        (await client.query("select id from public.source_events")).rowCount
      );
      assert.equal(asMember, 0);
      assert.equal(asOther, 0);
    });

    await t("authenticated user cannot write a source event", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query(
            `insert into public.source_events
               (organization_id, source_system, event_kind, dedup_key)
             values ($1, 'traditional_gu', 'advisor_activity', 'forged')`,
            [f.orgA]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    // ---------------------------------------------------------------
    console.log("\nSL-3 resolution artifacts — M-RESOLUTION-IDENTITY");

    // What this section proves is exactly what the in-memory fake CANNOT: the
    // partial unique indexes under real concurrency, and the ended-vs-active
    // semantics of the lineage index. The fake enforces the same indexes, but a
    // fake agreeing with itself is not evidence about PostgreSQL.
    //
    // The fixture already seeds one ACTIVE `duplicate_of` edge orgCaseA -> orgCaseA2.

    const seededEdge = (
      await client.query<{ id: string }>(
        `select id from public.case_relationships
          where from_case_id = $1 and to_case_id = $2
            and relationship_type = 'duplicate_of' and status = 'active'`,
        [f.orgCaseA, f.orgCaseA2]
      )
    ).rows[0].id;

    const closure = (caseId: string, userId: string, edgeId: string, outcome: string) =>
      client.query(
        `insert into public.case_facts
           (case_id, user_id, fact_key, value_jsonb, source_kind, source_ref)
         values ($1, $2, 'opportunity.closure',
                 jsonb_build_object('outcome', $4::text),
                 'derived', 'case_relationships:' || $3::text)`,
        [caseId, userId, edgeId, outcome]
      );

    const narrate = (caseId: string, edgeId: string) =>
      client.query(
        `insert into public.operational_case_events
           (case_id, event_type, actor, payload_jsonb)
         values ($1, 'state_changed', 'system',
                 jsonb_build_object('kind', 'case_relationship',
                                    'relationship_id', $2::text))`,
        [caseId, edgeId]
      );

    await t("SA-3.7 a second ACTIVE edge of the same (from, to, type) conflicts", async () => {
      const code = await errorCode(() =>
        client.query(
          `insert into public.case_relationships
             (organization_id, from_case_id, to_case_id, relationship_type)
           values ($1, $2, $3, 'duplicate_of')`,
          [f.orgA, f.orgCaseA, f.orgCaseA2]
        )
      );
      assert.equal(code, UNIQUE_VIOLATION);
    });

    await t("an ENDED edge does not block a new active one", async () => {
      // Edges are ended rather than deleted so lineage stays reconstructible
      // (ADR-109 §7). The index has to allow re-relating afterwards, or ending
      // an edge would silently become a permanent prohibition.
      await client.query(
        `insert into public.case_relationships
           (organization_id, from_case_id, to_case_id, relationship_type,
            status, ended_at)
         values ($1, $2, $3, 'superseded_by', 'ended', now())`,
        [f.orgA, f.orgCaseA, f.orgCaseA2]
      );
      await client.query(
        `insert into public.case_relationships
           (organization_id, from_case_id, to_case_id, relationship_type)
         values ($1, $2, $3, 'superseded_by')`,
        [f.orgA, f.orgCaseA, f.orgCaseA2]
      );
      const { rowCount } = await client.query(
        `select id from public.case_relationships
          where from_case_id = $1 and to_case_id = $2
            and relationship_type = 'superseded_by'`,
        [f.orgCaseA, f.orgCaseA2]
      );
      assert.equal(rowCount, 2, "one ended, one active — history intact");
    });

    await t("SA-3.12 concurrent closures for one resolution: exactly one survives", async () => {
      // Two workers retrying the same resolution at once. A read-then-write
      // guard would let both through; the partial unique index does not.
      const results = await Promise.allSettled([
        closure(f.orgCaseA, f.creatorA, seededEdge, "duplicate"),
        closure(f.orgCaseA, f.creatorA, seededEdge, "duplicate"),
      ]);
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(rejected.length, 1, "one writer must lose");
      assert.equal(
        (rejected[0] as PromiseRejectedResult).reason.code,
        UNIQUE_VIOLATION
      );
      const { rowCount } = await client.query(
        `select id from public.case_facts
          where case_id = $1 and fact_key = 'opportunity.closure'
            and source_ref = 'case_relationships:' || $2::text`,
        [f.orgCaseA, seededEdge]
      );
      assert.equal(rowCount, 1);
    });

    await t("a DIFFERENT resolution's closure on the same Case coexists", async () => {
      // Identity is (case, key, edge), not (case, key). A correction arriving
      // through its own governed determination must be writable, and the
      // earlier closure stays as history rather than being blocked or erased.
      const otherEdge = (
        await client.query<{ id: string }>(
          `select id from public.case_relationships
            where from_case_id = $1 and to_case_id = $2
              and relationship_type = 'superseded_by' and status = 'active'`,
          [f.orgCaseA, f.orgCaseA2]
        )
      ).rows[0].id;
      await closure(f.orgCaseA, f.creatorA, otherEdge, "superseded");
      const { rowCount } = await client.query(
        `select id from public.case_facts
          where case_id = $1 and fact_key = 'opportunity.closure'`,
        [f.orgCaseA]
      );
      assert.equal(rowCount, 2, "both closures coexist; neither is discarded");
    });

    await t("the closure index does not constrain other case_facts writers", async () => {
      // Scoped by the `case_relationships:` prefix. A closure recorded through
      // some other provenance — or any other key — is untouched by it.
      await client.query(
        `insert into public.case_facts
           (case_id, user_id, fact_key, value_jsonb, source_kind, source_ref)
         values ($1, $2, 'opportunity.closure', '{"outcome":"lost"}'::jsonb,
                 'user', 'advisor_manual_closure')`,
        [f.orgCaseA, f.creatorA]
      );
      await client.query(
        `insert into public.case_facts
           (case_id, user_id, fact_key, value_jsonb, source_kind, source_ref)
         values ($1, $2, 'opportunity.closure', '{"outcome":"lost"}'::jsonb,
                 'user', 'advisor_manual_closure_2')`,
        [f.orgCaseA, f.creatorA]
      );
      const { rowCount } = await client.query(
        `select id from public.case_facts
          where case_id = $1 and fact_key = 'opportunity.closure'
            and source_ref not like 'case_relationships:%'`,
        [f.orgCaseA]
      );
      assert.equal(rowCount, 2);
    });

    await t("SA-3.5 concurrent narrations of one edge on one Case: exactly one survives", async () => {
      const results = await Promise.allSettled([
        narrate(f.orgCaseA, seededEdge),
        narrate(f.orgCaseA, seededEdge),
      ]);
      assert.equal(
        results.filter((r) => r.status === "rejected").length,
        1,
        "the timeline is append-only with no identity of its own — the index is it"
      );
      const { rowCount } = await client.query(
        `select id from public.operational_case_events
          where case_id = $1
            and payload_jsonb ->> 'kind' = 'case_relationship'
            and payload_jsonb ->> 'relationship_id' = $2`,
        [f.orgCaseA, seededEdge]
      );
      assert.equal(rowCount, 1);
    });

    await t("SA-3.5 the SAME edge is narrated once on EACH Case", async () => {
      // Two rows, two distinct case_id values, one logical narration each.
      // Per (Case, edge) is the identity — per edge would silence one side.
      await narrate(f.orgCaseA2, seededEdge);
      const { rowCount } = await client.query(
        `select id from public.operational_case_events
          where payload_jsonb ->> 'kind' = 'case_relationship'
            and payload_jsonb ->> 'relationship_id' = $1`,
        [seededEdge]
      );
      assert.equal(rowCount, 2, "both endpoints narrated");
    });

    await t("the narration index does not constrain other timeline writers", async () => {
      // Scoped by kind. SL-2's admission narration and every ordinary event
      // stay outside it.
      await client.query(
        `insert into public.operational_case_events
           (case_id, event_type, actor, payload_jsonb)
         values ($1, 'state_changed', 'system', '{"kind":"something_else"}'::jsonb)`,
        [f.orgCaseA]
      );
      await client.query(
        `insert into public.operational_case_events
           (case_id, event_type, actor, payload_jsonb)
         values ($1, 'state_changed', 'system', '{"kind":"something_else"}'::jsonb)`,
        [f.orgCaseA]
      );
      const { rowCount } = await client.query(
        `select id from public.operational_case_events
          where case_id = $1 and payload_jsonb ->> 'kind' = 'something_else'`,
        [f.orgCaseA]
      );
      assert.equal(rowCount, 2, "unconstrained, as before this Slice");
    });

    // ---------------------------------------------------------------
    console.log("\nSL-4 Case Subjects — M-SUBJECTS (TD-14)");

    // Technical Plan §8 names the case this section owes: "a Subject/external-ref
    // cross-attachment case (a `case_subjects` row cannot be created under
    // another Case, and a `case_subject_external_refs` row cannot attach to a
    // Subject of another Case or Organization)".
    //
    // The point of proving it HERE rather than in the module selftest is that
    // TD-14's containment is structural, not procedural: it is a composite
    // foreign key, and a composite FK's MATCH SIMPLE semantics — including the
    // fact that a NULL subject_id skips the check entirely — are PostgreSQL
    // behaviour. A fake client asserting them would only agree with itself.

    const subject = async (caseId: string, kind: "commitment" | "visit") =>
      (
        await client.query<{ id: string }>(
          `insert into public.case_subjects (case_id, subject_kind, source_kind, label)
           values ($1, $2, 'derived', 'fixture subject') returning id`,
          [caseId, kind]
        )
      ).rows[0].id;

    const commitmentA = await subject(f.orgCaseA, "commitment");
    const commitmentA2 = await subject(f.orgCaseA, "commitment");
    const commitmentB = await subject(f.orgCaseB, "commitment");

    await t("tenancy is derived: case_subjects carries no organization column at all", async () => {
      // Not a style check. TD-14 removes the mismatch SURFACE — a table with no
      // organization_id cannot disagree with its parent Case about the tenant,
      // so there is no second tenancy mechanism to keep in sync.
      const { rows } = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public'
            and table_name in ('case_subjects', 'case_subject_external_refs')
            and column_name = 'organization_id'`
      );
      assert.equal(rows.length, 0);
    });

    await t("a subject fact cannot point at another Case's subject (composite FK)", async () => {
      const code = await errorCode(() =>
        client.query(
          `insert into public.case_facts
             (case_id, user_id, fact_key, value_jsonb, source_kind, subject_id)
           values ($1, $2, 'commitment.due', '{"v":1}'::jsonb, 'derived', $3)`,
          [f.orgCaseA, f.creatorA, commitmentB]
        )
      );
      assert.equal(code, FK_VIOLATION, "cross-Case, and therefore cross-Organization, is unreachable");
    });

    await t("an external ref cannot attach to a Subject of another Case or Organization", async () => {
      const code = await errorCode(() =>
        client.query(
          `insert into public.case_subject_external_refs
             (subject_id, case_id, source_system, ref_kind, external_ref, source_kind)
           values ($1, $2, 'legacy_gu', 'legacy_appointment', 'opaque-1', 'integration')`,
          [commitmentB, f.orgCaseA]
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("SA-4.4 two same-key facts under DIFFERENT subjects coexist as current", async () => {
      // The identity TD-14 point 1 establishes is (case_id, fact_key, subject_id).
      // Two Commitments both carrying `commitment.due` must not collapse into
      // one another — losing a promise the brokerage made is exactly the risk
      // the Slice contract names.
      const due = (subjectId: string, value: string) =>
        client.query(
          `insert into public.case_facts
             (case_id, user_id, fact_key, value_jsonb, source_kind, subject_id)
           values ($1, $2, 'commitment.due', to_jsonb($3::text), 'derived', $4)`,
          [f.orgCaseA, f.creatorA, value, subjectId]
        );
      await due(commitmentA, "2026-09-11");
      await due(commitmentA2, "2026-09-12");
      const { rows } = await client.query<{ subject_id: string }>(
        `select subject_id from public.case_facts
          where case_id = $1 and fact_key = 'commitment.due'
            and superseded_by is null and subject_id is not null`,
        [f.orgCaseA]
      );
      assert.equal(rows.length, 2, "no structural collapse; supersession stays code-managed per subject");
      assert.equal(new Set(rows.map((r) => r.subject_id)).size, 2);
    });

    await t("SA-4.10 a case-level fact is unaffected — NULL subject skips the FK entirely", async () => {
      // MATCH SIMPLE: with subject_id NULL the composite constraint is not
      // checked. That is what makes this column additive for every existing
      // caller rather than a migration they all have to learn about.
      await client.query(
        `insert into public.case_facts
           (case_id, user_id, fact_key, value_jsonb, source_kind)
         values ($1, $2, 'opportunity.viability', '{"v":"viable"}'::jsonb, 'derived')`,
        [f.orgCaseA, f.creatorA]
      );
      const { rows } = await client.query<{ subject_id: string | null }>(
        `select subject_id from public.case_facts
          where case_id = $1 and fact_key = 'opportunity.viability' and superseded_by is null`,
        [f.orgCaseA]
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].subject_id, null);
    });

    await t("case_subjects rows are structurally immutable — no UPDATE, no DELETE", async () => {
      assert.equal(
        await errorCode(() =>
          client.query("update public.case_subjects set label = 'edited' where id = $1", [commitmentA])
        ),
        RAISE_EXCEPTION,
        "lifecycle belongs in subject-scoped facts, not in the identity row"
      );
      assert.equal(
        await errorCode(() =>
          client.query("delete from public.case_subjects where id = $1", [commitmentA])
        ),
        RAISE_EXCEPTION
      );
    });

    await t("external-ref attachment is idempotent and append-only", async () => {
      const attach = () =>
        client.query(
          `insert into public.case_subject_external_refs
             (subject_id, case_id, source_system, ref_kind, external_ref, source_kind)
           values ($1, $2, 'legacy_gu', 'legacy_appointment', 'opaque-2', 'integration')`,
          [commitmentA, f.orgCaseA]
        );
      await attach();
      assert.equal(await errorCode(attach), UNIQUE_VIOLATION, "re-discovery is a no-op conflict, not a duplicate row");
      assert.equal(
        await errorCode(() =>
          client.query(
            "update public.case_subject_external_refs set external_ref = 'x' where subject_id = $1",
            [commitmentA]
          )
        ),
        RAISE_EXCEPTION
      );
    });

    await t("cross-tenant read: subjects follow the parent Case, in all four directions", async () => {
      const visible = async (user: string, caseId: string) =>
        (
          await asRole(client, { sub: user, role: "authenticated" }, () =>
            client.query("select id from public.case_subjects where case_id = $1", [caseId])
          )
        ).rowCount;

      assert.equal(await visible(f.creatorA, f.orgCaseA), 2, "an active Org A member reads Org A subjects");
      assert.equal(await visible(f.memberA2, f.orgCaseA), 2, "a second active Org A member too");
      assert.equal(await visible(f.memberB, f.orgCaseA), 0, "an Org B member cannot");
      assert.equal(await visible(f.revokedA, f.orgCaseA), 0, "a revoked Org A member cannot");
      assert.equal(await visible(f.legacyUser, f.orgCaseA), 0, "a non-member cannot");
      assert.equal(await visible(f.creatorA, f.orgCaseB), 0, "and Org A cannot reach Org B");
    });

    await t("a user JWT cannot write a subject or an external ref", async () => {
      // Subjects are created by the Supervisor through a service-role helper.
      // Membership grants READ; every write stays server-authorized (00081).
      const insertCode = await asRole(client, { sub: f.creatorA, role: "authenticated" }, () =>
        errorCode(() =>
          client.query(
            `insert into public.case_subjects (case_id, subject_kind, source_kind)
             values ($1, 'commitment', 'derived')`,
            [f.orgCaseA]
          )
        )
      );
      assert.equal(insertCode, RLS_VIOLATION);

      const refCode = await asRole(client, { sub: f.creatorA, role: "authenticated" }, () =>
        errorCode(() =>
          client.query(
            `insert into public.case_subject_external_refs
               (subject_id, case_id, source_system, ref_kind, external_ref, source_kind)
             values ($1, $2, 'legacy_gu', 'calendar_event', 'opaque-3', 'integration')`,
            [commitmentA, f.orgCaseA]
          )
        )
      );
      assert.equal(refCode, RLS_VIOLATION);
    });

    // ---------------------------------------------------------------
    console.log("\nSL-4 wake identity — M-WAKE-IDENTITY (SA-4.6)");

    // SA-4.6: a redelivered wake must not become a second reconsideration. The
    // executor claims a wake by inserting its reconsideration first, and the
    // partial unique index on (case_id, payload_jsonb ->> 'wake_key') WHERE
    // kind = 'supervisor_reconsidered' is what turns a duplicate into a conflict
    // it converges on. The module selftest drives that conflict path against a
    // test double that EMULATES the index; whether PostgreSQL enforces it — the
    // expression, the predicate, the error code — can only be shown here. Same
    // shape as SA-3.5's narration identity above.

    const claimWake = (caseId: string, wakeKey: string, kind = "supervisor_reconsidered") =>
      client.query(
        `insert into public.operational_case_events
           (case_id, event_type, actor, payload_jsonb)
         values ($1, 'state_changed', 'agent',
                 jsonb_build_object('kind', $3::text, 'wake_key', $2::text))`,
        [caseId, wakeKey, kind]
      );

    const claimsOf = async (caseId: string, wakeKey: string, kind = "supervisor_reconsidered") =>
      (
        await client.query(
          `select id from public.operational_case_events
            where case_id = $1
              and payload_jsonb ->> 'wake_key' = $2
              and payload_jsonb ->> 'kind' = $3`,
          [caseId, wakeKey, kind]
        )
      ).rowCount;

    await t("SA-4.6 two claims of one wake on one Case: exactly one survives, as a unique violation", async () => {
      const results = await Promise.allSettled([
        claimWake(f.orgCaseA, "scheduled:2026-09-09"),
        claimWake(f.orgCaseA, "scheduled:2026-09-09"),
      ]);
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      assert.equal(rejected.length, 1, "the index is the wake's identity — without it both would land");
      assert.equal((rejected[0].reason as { code?: string }).code, UNIQUE_VIOLATION);
      assert.equal(await claimsOf(f.orgCaseA, "scheduled:2026-09-09"), 1);
    });

    await t("SA-4.6 the same wake key on ANOTHER Case, and another day on this Case, are new claims", async () => {
      // Per (Case, wake) is the identity: every Case woken on a day shares its key.
      await claimWake(f.orgCaseA2, "scheduled:2026-09-09");
      await claimWake(f.orgCaseA, "scheduled:2026-09-10");
      assert.equal(await claimsOf(f.orgCaseA2, "scheduled:2026-09-09"), 1);
      assert.equal(await claimsOf(f.orgCaseA, "scheduled:2026-09-10"), 1);
    });

    await t("the wake index is scoped to supervisor claims, not to other writers on the timeline", async () => {
      // Scoped by kind, as SA-3.5's is. A settlement carries the same key but is
      // written only after its claim succeeded, so its uniqueness is procedural.
      await claimWake(f.orgCaseA, "scheduled:2026-09-09", "supervisor_reconsideration_settled");
      await claimWake(f.orgCaseA, "scheduled:2026-09-09", "supervisor_reconsideration_settled");
      assert.equal(
        await claimsOf(f.orgCaseA, "scheduled:2026-09-09", "supervisor_reconsideration_settled"),
        2
      );
    });

    // ---------------------------------------------------------------
    console.log("\nSL-7 Work Portfolio — M-PRESENTATION (SA-7.6, SA-7.11, SA-7.12)");

    // SL-7 is the first multi-seat surface the Technical Plan §8 gate actually
    // binds, and `portfolio_presentation_state` is the only table in R1 an
    // authenticated user writes directly. So its write policy IS the security
    // boundary, not a backstop behind a server route — and only a real
    // PostgreSQL can say whether it holds.

    const presentationRow = (
      claims: Claims,
      userId: string,
      organizationId: string,
      caseId: string,
      extra: { snoozeUntil?: string; updatedAt?: string } = {}
    ) =>
      asRole(client, claims, () =>
        client.query<{ id: string; snooze_until: string | null; updated_at: string }>(
          `insert into public.portfolio_presentation_state
             (user_id, organization_id, subject_kind, subject_id, snooze_until, updated_at)
           values ($1, $2, 'case', $3, $4::timestamptz, coalesce($5::timestamptz, now()))
           returning id, snooze_until, updated_at`,
          [userId, organizationId, caseId, extra.snoozeUntil ?? null, extra.updatedAt ?? null]
        )
      );

    await t("SA-7.12 an active member writes their own presentation state for an Organization Case", async () => {
      const { rowCount } = await presentationRow(authed(f.memberA2), f.memberA2, f.orgA, f.orgCaseA);
      assert.equal(rowCount, 1);
    });

    await t("SA-7.12 a member cannot write another user's presentation state", async () => {
      const code = await errorCode(() =>
        presentationRow(authed(f.memberA2), f.creatorA, f.orgA, f.orgCaseA)
      );
      assert.equal(code, RLS_VIOLATION, "user_id = auth.uid() is enforced on the write");
    });

    await t("SA-7.11 a revoked member, a non-member and another Organization's member cannot write", async () => {
      assert.equal(
        await errorCode(() => presentationRow(authed(f.revokedA), f.revokedA, f.orgA, f.orgCaseA2)),
        RLS_VIOLATION,
        "revoked: user_id = auth.uid() alone is insufficient (TD-1)"
      );
      assert.equal(
        await errorCode(() => presentationRow(authed(f.legacyUser), f.legacyUser, f.orgA, f.orgCaseA)),
        RLS_VIOLATION,
        "non-member"
      );
      assert.equal(
        await errorCode(() => presentationRow(authed(f.memberB), f.memberB, f.orgA, f.orgCaseA)),
        RLS_VIOLATION,
        "member of another Organization, naming Org A"
      );
    });

    await t("a row cannot pair an Organization with another Organization's Case (composite FK)", async () => {
      // The Org B member passes the RLS check for their own Organization, so what
      // refuses this is structural: (Org A's Case, Org B) does not exist.
      const code = await errorCode(() =>
        presentationRow(authed(f.memberB), f.memberB, f.orgB, f.orgCaseA)
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("a legacy NULL-Organization Case can never be a presentation subject, even for the service role", async () => {
      const code = await errorCode(() =>
        presentationRow(service, f.legacyUser, f.orgA, f.legacyCase)
      );
      assert.equal(code, FK_VIOLATION);
    });

    // Rows the read and update checks below observe. Written by the superuser
    // outside any request role, so they persist across the rolled-back cases.
    const seedPresentation = async (userId: string, organizationId: string, caseId: string) =>
      (
        await client.query<{ id: string }>(
          `insert into public.portfolio_presentation_state
             (user_id, organization_id, subject_kind, subject_id, hidden_at)
           values ($1, $2, 'case', $3, now())
           returning id`,
          [userId, organizationId, caseId]
        )
      ).rows[0].id;
    const rowCreatorA = await seedPresentation(f.creatorA, f.orgA, f.orgCaseA);
    await seedPresentation(f.memberA2, f.orgA, f.orgCaseA2);
    // A row the member wrote while they were still active: SA-7.11 requires
    // that, once revoked, they read nothing through it.
    await seedPresentation(f.revokedA, f.orgA, f.orgCaseA);

    const visiblePresentation = (userId: string) =>
      asRole(client, authed(userId), async () =>
        (
          await client.query<{ user_id: string }>(
            "select user_id from public.portfolio_presentation_state"
          )
        ).rows
      );

    await t("SA-7.12 presentation state is personal: a member reads only their own rows", async () => {
      const rows = await visiblePresentation(f.memberA2);
      assert.equal(rows.length, 1);
      assert.ok(rows.every((r) => r.user_id === f.memberA2));
    });

    await t("SA-7.11 a revoked member reads nothing, not even the rows they wrote while active", async () => {
      assert.equal((await visiblePresentation(f.revokedA)).length, 0);
      assert.equal((await visiblePresentation(f.legacyUser)).length, 0, "non-member");
      assert.equal((await visiblePresentation(f.memberB)).length, 0, "another Organization's member");
    });

    await t("SA-7.12 a member cannot update another user's row, nor re-point their own", async () => {
      const affected = await asRole(client, authed(f.memberA2), async () =>
        (
          await client.query(
            "update public.portfolio_presentation_state set pinned = true where id = $1",
            [rowCreatorA]
          )
        ).rowCount
      );
      assert.equal(affected, 0, "another user's row is invisible to the update");

      const repoint = await asRole(client, authed(f.creatorA), () =>
        errorCode(() =>
          client.query(
            "update public.portfolio_presentation_state set user_id = $2 where id = $1",
            [rowCreatorA, f.memberA2]
          )
        )
      );
      // The stamp trigger runs BEFORE the policy's WITH CHECK, so it is what
      // answers; the policy would refuse the same write if the trigger did not.
      assert.equal(repoint, RAISE_EXCEPTION, "a row keeps the person it was written for");

      const moveSubject = await asRole(client, authed(f.creatorA), () =>
        errorCode(() =>
          client.query(
            "update public.portfolio_presentation_state set subject_id = $2 where id = $1",
            [rowCreatorA, f.orgCaseA2]
          )
        )
      );
      assert.equal(moveSubject, RAISE_EXCEPTION, "a row keeps the subject it was written for");
    });

    await t("an authenticated user cannot delete presentation state (clearing is an update)", async () => {
      const affected = await asRole(client, authed(f.creatorA), async () =>
        (
          await client.query("delete from public.portfolio_presentation_state where id = $1", [
            rowCreatorA,
          ])
        ).rowCount
      );
      assert.equal(affected, 0);
    });

    await t("SA-7.6 D6 cap: a snooze longer than 14 days is clamped to 14 days from the write", async () => {
      const {
        rows: [row],
      } = await presentationRow(authed(f.memberA2), f.memberA2, f.orgA, f.orgCaseA, {
        snoozeUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      });
      const capMs = new Date(row.updated_at).getTime() + 14 * 86_400_000;
      assert.equal(new Date(row.snooze_until as string).getTime(), capMs);
    });

    await t("SA-7.6 the write time is the database's: a caller-supplied updated_at cannot move the cap", async () => {
      const farFuture = new Date(Date.now() + 365 * 86_400_000).toISOString();
      const {
        rows: [row],
      } = await presentationRow(authed(f.memberA2), f.memberA2, f.orgA, f.orgCaseA, {
        updatedAt: farFuture,
        snoozeUntil: farFuture,
      });
      assert.ok(
        new Date(row.updated_at).getTime() < Date.now() + 60_000,
        "updated_at is stamped from now(), not taken from the caller"
      );
      assert.ok(new Date(row.snooze_until as string).getTime() <= Date.now() + 14 * 86_400_000 + 60_000);
    });

    await t("SA-7.6 a presentation write has no path to business truth: its only trigger stamps its own row", async () => {
      const { rows } = await client.query<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = 'public.portfolio_presentation_state'::regclass
            and not tgisinternal
          order by tgname`
      );
      assert.deepEqual(
        rows.map((r) => r.tgname),
        ["trg_portfolio_presentation_state_stamp"]
      );
    });

    // ---------------------------------------------------------------
    console.log("\nSL-7 Work Portfolio — read paths (SA-7.2, SA-7.11)");

    // The Portfolio reads case-level truth under the actor's own JWT, so the
    // candidate set is whatever these policies return — an unauthorized Case
    // never reaches application code to be filtered afterwards (AC-9 §14.2).
    // These are the exact shapes the projection issues (packages/db
    // `work-portfolio.ts`). Work Items are read with the service role, keyed
    // only by the Case ids these reads returned; that half is proven by the
    // module selftest, because RLS cannot see it.
    const portfolioReads = (userId: string, organizationId: string) =>
      asRole(client, authed(userId), async () => {
        const cases = await client.query<{ id: string }>(
          `select id from public.operational_cases where organization_id = $1`,
          [organizationId]
        );
        const ids = cases.rows.map((r) => r.id);
        // Reading children for EVERY Case of the Organization — not only the
        // ids returned above — is the adversarial form: a projection bug that
        // leaked an id into the child reads must still get nothing back.
        const allIds = (
          await client.query<{ id: string }>("select id from public.operational_cases")
        ).rows.map((r) => r.id);
        const every = [...new Set([...ids, ...allIds, f.orgCaseA, f.orgCaseA2])];
        const count = async (sql: string) =>
          (await client.query(sql, [every])).rowCount ?? 0;
        return {
          cases: ids.length,
          caseIds: ids,
          facts: await count(
            "select id from public.case_facts where case_id = any($1) and superseded_by is null"
          ),
          subjects: await count("select id from public.case_subjects where case_id = any($1)"),
          events: await count("select id from public.operational_case_events where case_id = any($1)"),
          approvals: await count("select id from public.case_approvals where case_id = any($1)"),
        };
      });

    await t("SA-7.11 the Portfolio read paths return Organization truth to an active member", async () => {
      const reads = await portfolioReads(f.memberA2, f.orgA);
      assert.ok(reads.caseIds.includes(f.orgCaseA), "a Case the member did not create");
      assert.ok(reads.caseIds.includes(f.orgCaseA2), "a Case whose creator was revoked");
      assert.ok(!reads.caseIds.includes(f.orgCaseB) && !reads.caseIds.includes(f.legacyCase));
      assert.ok(reads.facts > 0 && reads.subjects > 0 && reads.events > 0);
    });

    await t("SA-7.11 the Portfolio read paths return NOTHING of Org A to a revoked member, a non-member or an Org B member", async () => {
      for (const [who, userId] of [
        ["revoked member", f.revokedA],
        ["non-member", f.legacyUser],
        ["Org B member", f.memberB],
      ] as const) {
        const reads = await portfolioReads(userId, f.orgA);
        assert.equal(reads.cases, 0, `${who}: candidate Cases`);
        // Each of them may legitimately see child rows of their OWN Cases (the
        // non-member's legacy Cases, the Org B member's Organization), so the
        // assertion that matters is scoped to Org A's Cases explicitly.
        const orgAChildren = await asRole(client, authed(userId), async () =>
          (
            await client.query(
              `select 1 from public.case_facts where case_id = any($1)
               union all select 1 from public.case_subjects where case_id = any($1)
               union all select 1 from public.operational_case_events where case_id = any($1)
               union all select 1 from public.case_approvals where case_id = any($1)`,
              [[f.orgCaseA, f.orgCaseA2]]
            )
          ).rowCount
        );
        assert.equal(orgAChildren, 0, `${who}: no child row of an Org A Case`);
      }
    });

    // ---------------------------------------------------------------
    console.log("\nSL-12 Work Portfolio v2 — the ranking pass and the chat tool (SA-12.11)");

    // Neither new surface adds a read shape. The ranking pass reads only the
    // snapshots SL-7's loader built (the read paths above; the module selftest
    // proves it reads nothing else) plus its Organization's flag, with the
    // service role. The chat tool resolves the Organization from memberships,
    // then runs that same loader under the person's own JWT. What the database
    // must still guarantee: the resolution yields ACTIVE memberships only, and
    // the ranking kill switch is not a member's to read across tenants or flip.
    const resolveOrganizations = (userId: string) =>
      asRole(client, service, async () =>
        (
          await client.query<{ organization_id: string }>(
            // `listActiveOrganizationIdsForUser` — the chat tool's resolution.
            `select organization_id from public.organization_memberships
              where user_id = $1 and status = 'active'`,
            [userId]
          )
        ).rows.map((r) => r.organization_id)
      );

    await t("SA-12.11 the chat tool resolves ACTIVE memberships only: none for a revoked member or a non-member, Org B alone for an Org B member", async () => {
      assert.deepEqual(await resolveOrganizations(f.revokedA), []);
      assert.deepEqual(await resolveOrganizations(f.legacyUser), []);
      assert.deepEqual(await resolveOrganizations(f.memberB), [f.orgB]);
      assert.deepEqual(await resolveOrganizations(f.memberA2), [f.orgA]);
    });

    await t("SA-12.11 through the Organization it resolves, an Org B member's Portfolio holds no Org A Case", async () => {
      const [resolved] = await resolveOrganizations(f.memberB);
      const reads = await portfolioReads(f.memberB, resolved);
      assert.ok(reads.caseIds.includes(f.orgCaseB), "their own Organization's Case");
      assert.ok(!reads.caseIds.includes(f.orgCaseA) && !reads.caseIds.includes(f.orgCaseA2));
    });

    await t("SA-12.11 the ranking kill switch: invisible across tenants, and no user session can write it", async () => {
      // Persisted for this check only (the connection user bypasses RLS), and
      // removed at the end so later sections see the fixture unchanged.
      await client.query(
        `insert into public.organization_feature_flags (organization_id, flag_key, enabled)
         values ($1, 'portfolio_contextual_ranking', false)`,
        [f.orgA]
      );
      try {
        const visible = (userId: string) =>
          asRole(client, authed(userId), async () =>
            (
              await client.query(
                `select 1 from public.organization_feature_flags
                  where organization_id = $1 and flag_key = 'portfolio_contextual_ranking'`,
                [f.orgA]
              )
            ).rowCount
          );
        assert.equal(await visible(f.memberA2), 1, "an active member may read their Organization's flag");
        for (const userId of [f.revokedA, f.memberB, f.legacyUser]) {
          assert.equal(await visible(userId), 0, "nothing of Org A's flags");
        }

        for (const [who, userId] of [
          ["active member", f.memberA2],
          ["revoked member", f.revokedA],
          ["Org B member", f.memberB],
          ["non-member", f.legacyUser],
        ] as const) {
          const insert = await errorCode(() =>
            asRole(client, authed(userId), () =>
              client.query(
                `insert into public.organization_feature_flags (organization_id, flag_key, enabled)
                 values ($1, 'portfolio_contextual_ranking_probe', true)`,
                [f.orgA]
              )
            )
          );
          assert.equal(insert, "42501", `${who}: insert refused`);
          // An UPDATE is either refused outright or matches no row the policies
          // let it touch — both leave the flag as it was.
          let updated = 0;
          const update = await errorCode(async () => {
            updated = await asRole(client, authed(userId), async () =>
              (
                await client.query(
                  `update public.organization_feature_flags set enabled = true
                    where organization_id = $1 and flag_key = 'portfolio_contextual_ranking'`,
                  [f.orgA]
                )
              ).rowCount ?? 0
            );
          });
          assert.ok(update === "42501" || (update === null && updated === 0), `${who}: update had no effect`);
        }
        const after = await client.query<{ enabled: boolean }>(
          `select enabled from public.organization_feature_flags
            where organization_id = $1 and flag_key = 'portfolio_contextual_ranking'`,
          [f.orgA]
        );
        assert.deepEqual(after.rows.map((r) => r.enabled), [false], "the switch is still off");
      } finally {
        await client.query(
          `delete from public.organization_feature_flags
            where organization_id = $1 and flag_key = 'portfolio_contextual_ranking'`,
          [f.orgA]
        );
      }
    });

    // ---------------------------------------------------------------
    console.log("\nscope — the Work Plane must be untouched by SL-0");

    await t("work_items / work_item_attempts / artifact_inputs keep exactly their CURRENT policies", async () => {
      const { rows } = await client.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname
           from pg_policies
          where schemaname = 'public'
            and tablename in ('work_items', 'work_item_attempts', 'artifact_inputs')
          order by tablename, policyname`
      );
      assert.deepEqual(
        rows.map((r) => `${r.tablename}: ${r.policyname}`),
        [
          "artifact_inputs: Service role manages artifact inputs",
          "artifact_inputs: Users view own artifact inputs",
          "work_item_attempts: Service role manages work item attempts",
          "work_item_attempts: Users view own work item attempts",
          "work_items: Service role manages work items",
          "work_items: Users view own work items",
        ]
      );
    });

    await t("external_identity_bindings is unreadable from any authenticated JWT", async () => {
      const rows = await asRole(client, authed(f.creatorA), async () =>
        (await client.query("select id from public.external_identity_bindings")).rowCount
      );
      assert.equal(rows, 0);
    });

    await t("organization_tool_secrets is unreadable from any authenticated JWT", async () => {
      const rows = await asRole(client, authed(f.creatorA), async () =>
        (await client.query("select id from public.organization_tool_secrets")).rowCount
      );
      assert.equal(rows, 0);
    });

    // ---------------------------------------------------------------
    console.log("\nfunction hardening");

    const fnMeta = async (name: string) =>
      (
        await client.query<{
          prosecdef: boolean;
          proconfig: string[] | null;
          public_exec: boolean;
          authenticated_exec: boolean;
          service_exec: boolean;
        }>(
          `select p.prosecdef,
                  p.proconfig,
                  has_function_privilege('public', p.oid, 'execute')        as public_exec,
                  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
                  has_function_privilege('service_role', p.oid, 'execute')  as service_exec
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [name]
        )
      ).rows[0];

    await t("is_active_org_member is SECURITY DEFINER with a fixed search_path and no PUBLIC execute", async () => {
      const meta = await fnMeta("is_active_org_member");
      assert.equal(meta.prosecdef, true, "must be SECURITY DEFINER");
      assert.ok(
        (meta.proconfig ?? []).some((c) => c.startsWith("search_path=")),
        "must pin search_path"
      );
      assert.equal(meta.public_exec, false, "PUBLIC must not hold EXECUTE");
      assert.equal(meta.authenticated_exec, true, "policies need it from authenticated");
    });

    await t("bootstrap_organization is SECURITY INVOKER, executable only by service_role", async () => {
      const meta = await fnMeta("bootstrap_organization");
      assert.equal(meta.prosecdef, false, "must NOT be SECURITY DEFINER");
      assert.equal(meta.public_exec, false);
      assert.equal(meta.authenticated_exec, false);
      assert.equal(meta.service_exec, true);
    });

    await t("the superseded two-argument bootstrap signature no longer exists", async () => {
      // 00084 replaced the signature. CREATE OR REPLACE with a different arity
      // would have left the old contract reachable as an overload, letting a
      // caller store an un-normalized key; it must have been dropped instead.
      const { rows } = await client.query<{ args: string }>(
        `select pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'bootstrap_organization'
          order by args`
      );
      assert.equal(rows.length, 1, "exactly one bootstrap_organization overload");
      assert.equal(
        rows[0].args,
        "p_legacy_organization_key text, p_raw_legacy_source text, p_org_name text",
        "the surviving signature must separate the normalized key from its raw source"
      );
    });

    await t("an authenticated JWT cannot execute bootstrap_organization", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query("select public.bootstrap_organization($1)", ["k-denied"])
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("service_role can execute bootstrap_organization", async () => {
      const id = await asRole(client, service, async () =>
        (
          await client.query<{ bootstrap_organization: string }>(
            "select public.bootstrap_organization($1, $2, $3)",
            ["k-service", "users/k-service", "Service Org"]
          )
        ).rows[0].bootstrap_organization
      );
      assert.match(id, /^[0-9a-f-]{36}$/);
    });

    // ---------------------------------------------------------------
    console.log("\nbootstrap convergence");

    const bootstrap = async (key: string, rawSource?: string | null, name?: string) =>
      (
        await client.query<{ bootstrap_organization: string }>(
          "select public.bootstrap_organization($1, $2, $3)",
          [key, rawSource ?? null, name ?? null]
        )
      ).rows[0].bootstrap_organization;

    await t("the raw legacy representation is persisted as provenance, not as the key", async () => {
      const orgId = await bootstrap("uid-prov", "users/uid-prov", "Provenance Org");
      const { rows } = await client.query<{
        external_id: string;
        raw_legacy_source: string | null;
        source: string | null;
      }>(
        `select b.external_id,
                b.provenance_jsonb ->> 'raw_legacy_source' as raw_legacy_source,
                b.provenance_jsonb ->> 'source'            as source
           from public.external_identity_bindings b
          where b.organization_id = $1
            and b.binding_kind = 'legacy_organization_key'`,
        [orgId]
      );
      assert.equal(rows.length, 1);
      // The routing key is the normalized value; the raw path is provenance.
      assert.equal(rows[0].external_id, "uid-prov");
      assert.equal(rows[0].raw_legacy_source, "users/uid-prov");
      assert.equal(rows[0].source, "bootstrap_organization");

      // The raw path must never itself be resolvable as an organization key.
      const { rows: byRaw } = await client.query(
        `select 1 from public.external_identity_bindings
          where binding_kind = 'legacy_organization_key' and external_id = $1`,
        ["users/uid-prov"]
      );
      assert.equal(byRaw.length, 0, "raw path must not be a routing key");
    });

    await t("omitting the raw source stores no empty provenance placeholder", async () => {
      const orgId = await bootstrap("uid-noraw");
      const { rows } = await client.query<{ keys: string | null }>(
        `select (select string_agg(k, ',' order by k)
                   from jsonb_object_keys(b.provenance_jsonb) k) as keys
           from public.external_identity_bindings b
          where b.organization_id = $1
            and b.binding_kind = 'legacy_organization_key'`,
        [orgId]
      );
      assert.equal(rows[0].keys, "source", "nulls must be stripped, not stored");
    });

    await t("bootstrap creates no membership: identity inputs are not membership inputs", async () => {
      const orgId = await bootstrap("uid-nomember", "users/uid-nomember", "No Member Org");
      const { rows } = await client.query<{ n: string }>(
        "select count(*)::text as n from public.organization_memberships where organization_id = $1",
        [orgId]
      );
      assert.equal(
        rows[0].n,
        "0",
        "the profile a legacy identity is discovered on must never become a member"
      );
    });

    await t("platform authority is not an Organization role", async () => {
      // A profile flagged is_ungga_admin holds independent platform authority.
      // It grants nothing inside an Organization: without an explicit active
      // membership the org-owned Case stays invisible, and the flag is never
      // consulted by is_active_org_member.
      await client.query("update public.profiles set is_ungga_admin = true where id = $1", [
        f.legacyUser,
      ]);
      assert.equal(await countCases(authed(f.legacyUser), f.orgCaseA), 0);

      // Conversely, holding an Organization role does not imply platform
      // authority: memberships carry no is_ungga_admin coupling at all.
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n
           from information_schema.columns
          where table_name = 'organization_memberships'
            and column_name = 'is_ungga_admin'`
      );
      assert.equal(rows[0].n, "0", "membership must not carry platform authority");
    });

    await t("re-running bootstrap returns the same Organization and creates no duplicate", async () => {
      const first = await bootstrap("legacy-key-1", "users/legacy-key-1", "Pilot");
      const second = await bootstrap("legacy-key-1", "users/legacy-key-1", "A Different Name");
      assert.equal(second, first, "must converge on the same Organization");

      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n
           from public.external_identity_bindings
          where binding_kind = 'legacy_organization_key' and external_id = 'legacy-key-1'`
      );
      assert.equal(rows[0].n, "1", "binding must not be duplicated");
      // A different name must not have created a second Organization.
      const orgs = await client.query<{ n: string }>(
        "select count(*)::text as n from public.organizations where name = 'A Different Name'"
      );
      assert.equal(orgs.rows[0].n, "0", "identity is the binding, never the name");
    });

    await t("concurrent bootstrap runs converge on one Organization", async () => {
      const other = new Client({ connectionString: url });
      await other.connect();
      try {
        await client.query("begin");
        const winner = (
          await client.query<{ bootstrap_organization: string }>(
            "select public.bootstrap_organization($1, $2, $3)",
            ["legacy-key-race", "users/legacy-key-race", "Racer"]
          )
        ).rows[0].bootstrap_organization;

        // Blocks on the global routing unique index until the first run commits.
        const contender = other.query<{ bootstrap_organization: string }>(
          "select public.bootstrap_organization($1, $2)",
          ["legacy-key-race", "Racer"]
        );
        await new Promise((r) => setTimeout(r, 250));
        await client.query("commit");

        const loser = (await contender).rows[0].bootstrap_organization;
        assert.equal(loser, winner, "the losing run must return the existing Organization");

        const { rows } = await client.query<{ n: string }>(
          `select count(*)::text as n
             from public.external_identity_bindings
            where external_id = 'legacy-key-race'`
        );
        assert.equal(rows[0].n, "1", "no orphan Organization or duplicate binding");
      } finally {
        await other.end();
      }
    });

    await t("bootstrap re-run never revives a deactivated membership", async () => {
      const orgId = await bootstrap(
        "legacy-key-lifecycle",
        "users/legacy-key-lifecycle",
        "Lifecycle Org"
      );
      const upsert = () =>
        client.query(
          `insert into public.organization_memberships
             (organization_id, user_id, role, status)
           values ($1, $2, 'advisor', 'active')
           on conflict (organization_id, user_id) do nothing`,
          [orgId, f.memberA2]
        );

      await upsert();
      await client.query(
        `update public.organization_memberships set status = 'inactive'
          where organization_id = $1 and user_id = $2`,
        [orgId, f.memberA2]
      );

      await upsert(); // the re-run

      const { rows } = await client.query<{ status: string; role: string }>(
        `select status, role from public.organization_memberships
          where organization_id = $1 and user_id = $2`,
        [orgId, f.memberA2]
      );
      assert.equal(rows.length, 1, "must not create a second membership");
      assert.equal(rows[0].status, "inactive", "reactivation must be explicit");
      assert.equal(rows[0].role, "advisor");
    });

    // ---------------------------------------------------------------
    console.log("\nCycle 3 order 5 — tool_calls is read-own, not user-writable (Slice Plan §8 Q9)");

    // Since 00001 the table's only policy was FOR ALL over the rows of the
    // user's own sessions: it granted every user write authority over their own
    // audit rows. The Accountable decided on 2026-09-15 that the subject of an
    // audit record reads it but never creates, alters or erases it; writes stay
    // with the service role, which the application uses for every tool_calls
    // write. Rows below are written by the superuser outside any request role,
    // so they persist across the rolled-back cases.
    const sessionOf = async (userId: string) =>
      (
        await client.query<{ id: string }>(
          "insert into public.agent_sessions (user_id) values ($1) returning id",
          [userId]
        )
      ).rows[0].id;
    const auditRowIn = async (sessionId: string, toolName: string) =>
      (
        await client.query<{ id: string }>(
          `insert into public.tool_calls (session_id, tool_name, arguments_json, status)
           values ($1, $2, '{}'::jsonb, 'executed') returning id`,
          [sessionId, toolName]
        )
      ).rows[0].id;
    const sessionCreatorA = await sessionOf(f.creatorA);
    const sessionMemberB = await sessionOf(f.memberB);
    const ownAuditRow = await auditRowIn(sessionCreatorA, "calendar_list_events");
    const otherAuditRow = await auditRowIn(sessionMemberB, "gmail_send_email");

    const visibleAuditRows = (claims: Claims) =>
      asRole(client, claims, async () =>
        (await client.query<{ id: string }>("select id from public.tool_calls")).rows.map((r) => r.id)
      );

    await t("Q9 a user reads the audit rows of their own sessions", async () => {
      assert.deepEqual(await visibleAuditRows(authed(f.creatorA)), [ownAuditRow]);
    });

    await t("Q9 another user's audit rows are invisible, and anon reads none", async () => {
      assert.deepEqual(await visibleAuditRows(authed(f.memberB)), [otherAuditRow], "each user sees only their own");
      assert.deepEqual(await visibleAuditRows({ role: "anon" }), []);
    });

    await t("Q9 a user cannot INSERT an audit row, not even for their own session", async () => {
      const code = await asRole(client, authed(f.creatorA), () =>
        errorCode(() =>
          client.query(
            "insert into public.tool_calls (session_id, tool_name) values ($1, 'forged_tool')",
            [sessionCreatorA]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION, "no policy grants a user write authority over audit rows");
    });

    await t("Q9 a user cannot UPDATE their own audit row", async () => {
      const affected = await asRole(client, authed(f.creatorA), async () =>
        (
          await client.query(
            `update public.tool_calls set status = 'failed', result_json = '{"forged":true}'::jsonb
              where id = $1`,
            [ownAuditRow]
          )
        ).rowCount
      );
      assert.equal(affected, 0, "readable, but not updatable");
      const { rows } = await client.query<{ status: string; result_json: unknown }>(
        "select status, result_json from public.tool_calls where id = $1",
        [ownAuditRow]
      );
      assert.equal(rows[0].status, "executed");
      assert.equal(rows[0].result_json, null, "unchanged");
    });

    await t("Q9 a user cannot DELETE their own audit row", async () => {
      const affected = await asRole(client, authed(f.creatorA), async () =>
        (await client.query("delete from public.tool_calls where id = $1", [ownAuditRow])).rowCount
      );
      assert.equal(affected, 0);
      const { rowCount } = await client.query("select 1 from public.tool_calls where id = $1", [ownAuditRow]);
      assert.equal(rowCount, 1, "still there");
    });

    await t("Q9 the authorized writer, the service role, still opens and closes audit rows", async () => {
      await asRole(client, service, async () => {
        const opened = await client.query<{ id: string }>(
          `insert into public.tool_calls (session_id, tool_name, status, requires_confirmation)
           values ($1, 'legacy_lead_get_context', 'approved', false) returning id`,
          [sessionCreatorA]
        );
        assert.equal(opened.rowCount, 1);
        const closed = await client.query(
          `update public.tool_calls set status = 'executed', result_json = '{"status":"ok"}'::jsonb
            where id = $1`,
          [opened.rows[0].id]
        );
        assert.equal(closed.rowCount, 1);
      });
    });

    // ---------------------------------------------------------------
    console.log("\nSL-6 external_conversation_bindings — TD-4 / SA-6.1 / SA-6.2 / SA-6.13");

    const contactA = (
      await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, display_name) values ($1, 'Contact A') returning id",
        [f.orgA]
      )
    ).rows[0].id;
    const contactB = (
      await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, display_name) values ($1, 'Contact B') returning id",
        [f.orgB]
      )
    ).rows[0].id;
    const channelA = (
      await client.query<{ id: string }>(
        `insert into public.external_identity_bindings
           (organization_id, source_system, binding_kind, external_id, ref_organization_id)
         values ($1, 'traditional_gu', 'gu_whatsapp_number', '+5211111111', $1)
         returning id`,
        [f.orgA]
      )
    ).rows[0].id;
    const channelB = (
      await client.query<{ id: string }>(
        `insert into public.external_identity_bindings
           (organization_id, source_system, binding_kind, external_id, ref_organization_id)
         values ($1, 'traditional_gu', 'gu_whatsapp_number', '+5222222222', $1)
         returning id`,
        [f.orgB]
      )
    ).rows[0].id;

    const persistedBinding = (
      await client.query<{ id: string }>(
        `insert into public.external_conversation_bindings
           (organization_id, case_id, contact_id, provider, external_conversation_ref,
            thread_kind, gu_channel_identity_binding_id)
         values ($1, $2, $3, 'whatsapp_business', 'lead-persisted', 'gu', $4)
         returning id`,
        [f.orgA, f.orgCaseA, contactA, channelA]
      )
    ).rows[0].id;

    await t("external_conversation_bindings is unreadable from any authenticated JWT", async () => {
      const member = await asRole(client, authed(f.creatorA), async () =>
        (await client.query("select id from public.external_conversation_bindings")).rowCount
      );
      const other = await asRole(client, authed(f.memberB), async () =>
        (await client.query("select id from public.external_conversation_bindings")).rowCount
      );
      const anon = await asRole(client, { role: "anon" }, async () =>
        (await client.query("select id from public.external_conversation_bindings")).rowCount
      );
      assert.equal(member, 0);
      assert.equal(other, 0);
      assert.equal(anon, 0);
    });

    await t("an authenticated member cannot insert an external conversation binding", async () => {
      const code = await asRole(client, authed(f.creatorA), () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
             values ($1, $2, $3, 'whatsapp_business', 'forged', 'gu')`,
            [f.orgA, f.orgCaseA, contactA]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("service_role writes a gu-thread binding with conversation authority", async () => {
      await asRole(client, service, async () => {
        const { rowCount } = await client.query(
          `insert into public.external_conversation_bindings
             (organization_id, case_id, contact_id, provider, external_conversation_ref,
              thread_kind, conversation_authority, last_human_activity_at, authority_source)
           values ($1, $2, $3, 'whatsapp_business', 'lead-gu-owned', 'gu',
                   'human_active', now(), 'legacy_conversation_authority_get')`,
          [f.orgA, f.orgCaseA, contactA]
        );
        assert.equal(rowCount, 1);
      });
    });

    await t("advisor_wa with conversation_authority is rejected by CHECK", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref,
                thread_kind, conversation_authority)
             values ($1, $2, $3, 'whatsapp_business', 'advisor-bad-auth', 'advisor_wa', 'human_active')`,
            [f.orgA, f.orgCaseA, contactA]
          )
        )
      );
      assert.equal(code, CHECK_VIOLATION);
    });

    await t("advisor_wa with last_human_activity_at is rejected by CHECK", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref,
                thread_kind, last_human_activity_at)
             values ($1, $2, $3, 'whatsapp_business', 'advisor-bad-ts', 'advisor_wa', now())`,
            [f.orgA, f.orgCaseA, contactA]
          )
        )
      );
      assert.equal(code, CHECK_VIOLATION);
    });

    await t("advisor_wa with authority_source is rejected by CHECK", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref,
                thread_kind, authority_source)
             values ($1, $2, $3, 'whatsapp_business', 'advisor-bad-src', 'advisor_wa', 'c1_event')`,
            [f.orgA, f.orgCaseA, contactA]
          )
        )
      );
      assert.equal(code, CHECK_VIOLATION);
    });

    await t("advisor_wa with all authority columns null is accepted", async () => {
      await asRole(client, service, async () => {
        const { rowCount } = await client.query(
          `insert into public.external_conversation_bindings
             (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
           values ($1, $2, $3, 'whatsapp_business', 'advisor-ok', 'advisor_wa')`,
          [f.orgA, f.orgCaseA, contactA]
        );
        assert.equal(rowCount, 1);
      });
    });

    await t("a second active binding for the same (case, provider, ref) is rejected", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
             values ($1, $2, $3, 'whatsapp_business', 'lead-persisted', 'gu')`,
            [f.orgA, f.orgCaseA, contactA]
          )
        )
      );
      assert.equal(code, UNIQUE_VIOLATION);
    });

    await t("ending the active binding frees the triple for a new active row", async () => {
      await asRole(client, service, async () => {
        await client.query(
          `update public.external_conversation_bindings
              set status = 'ended', ended_at = now(), updated_at = now()
            where id = $1`,
          [persistedBinding]
        );
        const { rowCount } = await client.query(
          `insert into public.external_conversation_bindings
             (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
           values ($1, $2, $3, 'whatsapp_business', 'lead-persisted', 'gu')`,
          [f.orgA, f.orgCaseA, contactA]
        );
        assert.equal(rowCount, 1);
      });
    });

    await t("a Case from another Organization cannot be bound (composite FK)", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
             values ($1, $2, $3, 'whatsapp_business', 'cross-case', 'gu')`,
            [f.orgA, f.orgCaseB, contactA]
          )
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("a contact from another Organization cannot be bound (composite FK)", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
             values ($1, $2, $3, 'whatsapp_business', 'cross-contact', 'gu')`,
            [f.orgA, f.orgCaseA, contactB]
          )
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("a Gu-channel identity from another Organization cannot be bound", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref,
                thread_kind, gu_channel_identity_binding_id)
             values ($1, $2, $3, 'whatsapp_business', 'cross-channel', 'gu', $4)`,
            [f.orgA, f.orgCaseA, contactA, channelB]
          )
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("a legacy NULL-Organization Case cannot be bound", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
             values ($1, $2, $3, 'whatsapp_business', 'legacy-case', 'gu')`,
            [f.orgA, f.legacyCase, contactA]
          )
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("org members can read their Organization's authority_resolutions", async () => {
      await asRole(client, service, async () => {
        await client.query(
          `insert into public.authority_resolutions
             (organization_id, case_id, external_conversation_ref, state, detected_at)
           values ($1, $2, 'lead-opaque', 'unknown', now())`,
          [f.orgA, f.orgCaseA]
        );
      });
      const memberCount = await asRole(client, authed(f.creatorA), async () =>
        (await client.query("select id from public.authority_resolutions")).rowCount
      );
      const otherCount = await asRole(client, authed(f.memberB), async () =>
        (await client.query("select id from public.authority_resolutions")).rowCount
      );
      assert.ok((memberCount ?? 0) >= 1);
      assert.equal(otherCount, 0);
    });

    await t("an authenticated member cannot insert an authority_resolution", async () => {
      const code = await asRole(client, authed(f.creatorA), () =>
        errorCode(() =>
          client.query(
            `insert into public.authority_resolutions
               (organization_id, case_id, state, detected_at)
             values ($1, $2, 'unknown', now())`,
            [f.orgA, f.orgCaseA]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("a confident conversation state is rejected by CHECK", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.authority_resolutions
               (organization_id, case_id, state, detected_at)
             values ($1, $2, 'human_active', now())`,
            [f.orgA, f.orgCaseA]
          )
        )
      );
      assert.equal(code, CHECK_VIOLATION);
    });

    await t("a Case from another Organization cannot own a resolution (composite FK)", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.authority_resolutions
               (organization_id, case_id, state, detected_at)
             values ($1, $2, 'unknown', now())`,
            [f.orgA, f.orgCaseB]
          )
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("an empty external_conversation_ref is rejected", async () => {
      const code = await asRole(client, service, () =>
        errorCode(() =>
          client.query(
            `insert into public.external_conversation_bindings
               (organization_id, case_id, contact_id, provider, external_conversation_ref, thread_kind)
             values ($1, $2, $3, 'whatsapp_business', '   ', 'gu')`,
            [f.orgA, f.orgCaseA, contactA]
          )
        )
      );
      assert.equal(code, CHECK_VIOLATION);
    });

    console.log(`\nRLS suite ok — ${passed} checks passed`);
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(`\nRLS suite FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
