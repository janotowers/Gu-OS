/**
 * SA-6.9 / SA-6.10 / SA-6.14 — independent oracle and equivalence harness.
 *
 * The oracle is an observation of legacy's sweep, not a Gu OS policy.
 * The resolver is called separately. A recorded divergence writes nothing.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "@agents/db";
import type {
  LegacyConversationAuthority,
  LegacyReadResult,
} from "@agents/types";
import { resolveInteractionAuthority } from "../relationship-authority";
import {
  LEGACY_RESUME_WINDOW_MS,
  observeLegacyTakeover,
  recordAuthorityEquivalence,
  type OracleObservedInputs,
} from "./index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "5215500000001521550000000252155000000003";
const OBSERVED_AT = "2026-09-18T12:00:00.000Z";
const OBSERVED_MS = Date.parse(OBSERVED_AT);

function isoMinutesAgo(minutes: number): string {
  return new Date(OBSERVED_MS - minutes * 60 * 1000).toISOString();
}

function fakeDb(): DbClient {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };
  return { from: () => self } as unknown as DbClient;
}

function currentOf(
  inputs: OracleObservedInputs
): LegacyReadResult<LegacyConversationAuthority> {
  return {
    value: {
      legacyLeadId: LEAD,
      leadTakeoverActive: inputs.leadTakeoverActive,
      lastOwnerInteractionAt: inputs.lastOwnerInteractionAt,
      numberKillSwitchActive: inputs.numberKillSwitchActive,
      guNumberRef: "5215500000003",
    },
    provenance: {
      sourceSystem: "traditional_gu",
      store: "mongo",
      sourcePath: "gu2.users",
      externalId: LEAD,
      capability: "legacy_conversation_authority_get",
      adapter: "bootstrap_direct",
      organizationId: ORG,
      bindingState: "unbound",
      freshness: {
        readAt: inputs.observedAt,
        sourceUpdatedAt: inputs.lastOwnerInteractionAt,
        ageSeconds: null,
        sourceUpdatedAtField: "last_owner_interaction_wba",
      },
    },
  };
}

async function resolverHumanActive(
  inputs: OracleObservedInputs
): Promise<boolean | null> {
  const resolution = await resolveInteractionAuthority({
    ctx: { db: fakeDb(), organizationId: ORG },
    refs: { legacyLeadId: LEAD, threadKind: "gu" },
    readCurrent: async () => currentOf(inputs),
  });
  return resolution.humanActive;
}

function inputs(
  overrides: Partial<OracleObservedInputs> = {}
): OracleObservedInputs {
  return {
    leadTakeoverActive: false,
    lastOwnerInteractionAt: isoMinutesAgo(1),
    numberKillSwitchActive: false,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

async function testAgreementOnCurrentFlag(): Promise<void> {
  const recent = inputs({
    leadTakeoverActive: true,
    lastOwnerInteractionAt: isoMinutesAgo(1),
  });
  const idle = inputs({ leadTakeoverActive: false });
  const unknown = inputs({
    leadTakeoverActive: null,
    lastOwnerInteractionAt: null,
  });

  for (const sample of [recent, idle, unknown]) {
    const oracle = observeLegacyTakeover(sample);
    const resolver = await resolverHumanActive(sample);
    const record = recordAuthorityEquivalence({
      id: `agree-${sample.leadTakeoverActive}`,
      resolverHumanActive: resolver,
      oracle,
      inputs: sample,
    });
    assert.equal(record.agreed, true, `expected agreement for ${record.id}`);
    assert.equal(record.resolverHumanActive, record.oracleHumanActive);
  }
  console.log("  ok  SA-6.9 resolver and oracle agree on current-flag cases");
}

async function testExpiredWindowIsRecordedDivergence(): Promise<void> {
  const stale = inputs({
    leadTakeoverActive: true,
    lastOwnerInteractionAt: isoMinutesAgo(6),
  });
  const oracle = observeLegacyTakeover(stale);
  const resolver = await resolverHumanActive(stale);
  const record = recordAuthorityEquivalence({
    id: "expired-window",
    resolverHumanActive: resolver,
    oracle,
    inputs: stale,
    provenance: { source: "fixture", note: "sweep has not run yet" },
  });
  assert.equal(resolver, true);
  assert.equal(oracle.humanActive, false);
  assert.equal(oracle.windowExpired, true);
  assert.equal(record.agreed, false);
  assert.equal(record.resolverHumanActive, true);
  assert.equal(record.oracleHumanActive, false);
  assert.equal(record.inputs.leadTakeoverActive, true);
  assert.ok(record.provenance.source);
  console.log("  ok  SA-6.10 expired-window divergence is recorded, not repaired");
}

function testKillSwitchNotFolded(): void {
  const pausedNumber = inputs({
    leadTakeoverActive: false,
    numberKillSwitchActive: true,
  });
  const oracle = observeLegacyTakeover(pausedNumber);
  assert.equal(oracle.humanActive, false);
  assert.equal(pausedNumber.numberKillSwitchActive, true);
  console.log("  ok  the oracle does not fold the number kill switch into humanActive");
}

function testExactFiveMinutesStillInsideWindow(): void {
  const edge = inputs({
    leadTakeoverActive: true,
    lastOwnerInteractionAt: new Date(
      OBSERVED_MS - LEGACY_RESUME_WINDOW_MS
    ).toISOString(),
  });
  const oracle = observeLegacyTakeover(edge);
  assert.equal(oracle.humanActive, true);
  assert.equal(oracle.windowExpired, false);
  console.log("  ok  sweep is strictly older-than-five-minutes, not equal");
}

function testCompareWritesNoBusinessTruth(): void {
  const source = readFileSync(path.join(__dirname, "compare.ts"), "utf8");
  assert.equal(/from\s+["']@agents\/db["']/.test(source), false);
  assert.equal(/operational_cases|authority_resolutions|runtime_authority/.test(source), false);
  assert.equal(/resolveInteractionAuthority/.test(source), false);
  console.log("  ok  SA-6.10 comparison writes no business truth");
}

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".selftest.ts")
      ? [full]
      : [];
  });
}

function testOracleSharesNoDecisionCode(): void {
  const oracle = readFileSync(path.join(__dirname, "oracle.ts"), "utf8");
  const resolve = readFileSync(
    path.join(__dirname, "../relationship-authority/resolve.ts"),
    "utf8"
  );
  const persist = readFileSync(
    path.join(__dirname, "../relationship-authority/persist.ts"),
    "utf8"
  );
  const handle = readFileSync(
    path.join(__dirname, "../legacy-authority/handle.ts"),
    "utf8"
  );

  assert.equal(/relationship-authority|resolveInteractionAuthority|verdictFromTakeover/.test(oracle), false);
  assert.equal(/authority-equivalence|observeLegacyTakeover/.test(resolve), false);
  assert.equal(/authority-equivalence|observeLegacyTakeover|LEGACY_RESUME_WINDOW/.test(persist), false);
  assert.equal(/authority-equivalence|observeLegacyTakeover|LEGACY_RESUME_WINDOW/.test(handle), false);
  console.log("  ok  SA-6.9 oracle and resolver share no decision code");
}

function testWindowLivesOnlyInOracle(): void {
  const productRoots = [
    path.join(__dirname, "../relationship-authority"),
    path.join(__dirname, "../legacy-authority"),
    path.join(__dirname, "../legacy-gateway"),
    path.join(__dirname, "../../../../../packages/db/src/queries"),
  ];
  const windowPattern = /five[\s-]?minute|LEGACY_RESUME_WINDOW|5\s*\*\s*60\s*\*\s*1000/i;
  const offenders: string[] = [];
  for (const root of productRoots) {
    for (const file of collectTsFiles(root)) {
      if (file.includes(`${path.sep}authority-equivalence${path.sep}`)) continue;
      const source = readFileSync(file, "utf8");
      if (windowPattern.test(source)) offenders.push(path.relative(process.cwd(), file));
    }
  }
  assert.deepEqual(offenders, []);
  const oracle = readFileSync(path.join(__dirname, "oracle.ts"), "utf8");
  assert.equal(windowPattern.test(oracle), true);
  assert.equal(oracle.includes("8.3"), true);
  console.log("  ok  SA-6.14 the five-minute window exists only inside the oracle");
}

async function main(): Promise<void> {
  console.log("authority equivalence selftest");
  await testAgreementOnCurrentFlag();
  await testExpiredWindowIsRecordedDivergence();
  testKillSwitchNotFolded();
  testExactFiveMinutesStillInsideWindow();
  testCompareWritesNoBusinessTruth();
  testOracleSharesNoDecisionCode();
  testWindowLivesOnlyInOracle();
  console.log("authority equivalence selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
