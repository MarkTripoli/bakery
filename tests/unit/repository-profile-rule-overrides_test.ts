import { assert, assertEquals, assertThrows } from "@std/assert";
import { deriveRepositoryInspectionConfig } from "../../apps/server/src/modules/projects/repository-inspect.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";
import {
  RepositoryObservedProfileConfigSchema,
  RepositoryVersionedProfileConfigSchema,
} from "../../packages/contracts/src/repository-inspection.ts";
import type { RepositoryRuleOverrides } from "../../packages/contracts/src/repository-rules.ts";
import { titleEntry } from "../helpers/repository-rule-entries.ts";

const base = {
  schemaVersion: 1 as const,
  workflow: { kind: "fixed" as const },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};
const withAgents = {
  ...base,
  agentBindings: {
    "harness.implement": "11111111-1111-4111-8111-111111111111",
  },
};
// Computed on a `git archive origin/main` export (before this field existed).
const ORIGIN_MAIN_DIGESTS = {
  base: "3e2c48e0cbafa1942021aa376d41652156992312e0fff9a695fce6406843f440",
  withAgents:
    "b01d9f7adcb9d7ce843cfa34fc44a95e23212268db30ad3b60879e3a82d49ba7",
};

function overrides(): RepositoryRuleOverrides {
  const { locked: _locked, ...entry } = titleEntry(90);
  return { entries: [entry] } as RepositoryRuleOverrides;
}

async function digestOf(config: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(config));
}

Deno.test("profiles without repositoryRules parse and digest exactly as on origin/main", async () => {
  for (
    const [label, config] of [["base", base], [
      "withAgents",
      withAgents,
    ]] as const
  ) {
    const parsed = RepositoryProfileConfigSchema.parse(config);
    assertEquals("repositoryRules" in parsed, false, label);
    assertEquals(
      await digestOf(parsed),
      ORIGIN_MAIN_DIGESTS[label],
      label,
    );
    // The versioned read parser (v1 | v2 union) keeps the same bytes.
    assertEquals(
      await digestOf(RepositoryVersionedProfileConfigSchema.parse(config)),
      ORIGIN_MAIN_DIGESTS[label],
      label,
    );
  }
});

Deno.test("repositoryRules participates in the digest only when present", async () => {
  const parsed = RepositoryProfileConfigSchema.parse({
    ...base,
    repositoryRules: overrides(),
  });
  assertEquals(parsed.repositoryRules?.entries.length, 1);
  assert((await digestOf(parsed)) !== ORIGIN_MAIN_DIGESTS.base);
  const empty = RepositoryProfileConfigSchema.parse({
    ...base,
    repositoryRules: { entries: [] },
  });
  assert((await digestOf(empty)) !== ORIGIN_MAIN_DIGESTS.base);
});

Deno.test("repositoryRules is strict: locked flags, unknown keys and duplicates are rejected", () => {
  const parse = (repositoryRules: unknown) =>
    RepositoryProfileConfigSchema.safeParse({ ...base, repositoryRules })
      .success;
  assertEquals(parse(overrides()), true);
  assertEquals(parse({ entries: [titleEntry()] }), false);
  assertEquals(parse({ entries: [], extra: 1 }), false);
  assertEquals(
    parse({ entries: [overrides().entries[0], overrides().entries[0]] }),
    false,
  );
  assertEquals(
    parse({
      entries: [{ ...overrides().entries[0], ruleKey: "unknown.rule" }],
    }),
    false,
  );
  assertEquals(
    parse({
      entries: [{
        ...overrides().entries[0],
        explanation: "bad\u0000text",
      }],
    }),
    false,
  );
  assertEquals(
    parse({
      entries: [{
        ...overrides().entries[0],
        explanation: "lone\ud800surrogate",
      }],
    }),
    false,
  );
});

Deno.test("observed v2 derivation preserves baseline overrides and leaves override-free baselines unchanged", async () => {
  const envelope = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    applicationId: "00000000-0000-4000-8000-000000000002",
    repositoryId: "00000000-0000-4000-8000-000000000003",
    source: {
      mappingRevision: "rev-1",
      mappingDigest: "a".repeat(64),
      baseSha: "b".repeat(40),
      manifestDigest: await sha256Hex(canonicalJson([])),
    },
    entries: [],
  };
  const withRules = deriveRepositoryInspectionConfig(
    RepositoryProfileConfigSchema.parse({
      ...base,
      repositoryRules: overrides(),
    }),
    envelope,
  );
  assertEquals(withRules.repositoryRules, overrides());
  assertEquals(
    RepositoryObservedProfileConfigSchema.parse(withRules).repositoryRules,
    overrides(),
  );
  // A v2 baseline that already carries overrides keeps them across re-derivation.
  assertEquals(
    deriveRepositoryInspectionConfig(withRules, envelope).repositoryRules,
    overrides(),
  );
  const without = deriveRepositoryInspectionConfig(
    RepositoryProfileConfigSchema.parse(base),
    envelope,
  );
  assertEquals("repositoryRules" in without, false);
  assertThrows(() =>
    RepositoryObservedProfileConfigSchema.parse({
      ...withRules,
      repositoryRules: { entries: [titleEntry()] },
    })
  );
});
