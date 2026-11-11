import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  EffectiveRepositoryRulesSchema,
  type OrganizationRepositoryRules,
  OrganizationRepositoryRulesSchema,
  REPOSITORY_RULE_KEYS,
  type RepositoryRuleOverrides,
  RepositoryRuleOverridesSchema,
  resolveRepositoryRules as resolveRaw,
  validateRepositoryRuleOverrides,
} from "../../packages/contracts/src/repository-rules.ts";

async function resolveRepositoryRules(
  organization: OrganizationRepositoryRules | null | undefined,
  overrides: RepositoryRuleOverrides,
) {
  return EffectiveRepositoryRulesSchema.parse(
    await resolveRaw(organization, overrides),
  );
}

const commits = (types: string[], extra: Record<string, unknown> = {}) => ({
  ruleKey: "commits.semantic" as const,
  enabled: true,
  mode: "require" as const,
  options: {
    types,
    scope: "optional" as const,
    maxSubjectLength: 72,
    range: "all_commits" as const,
    mergeAndRevertCommits: "exempt" as const,
  },
  ...extra,
});

function org(
  revision: number,
  locked: boolean,
  types = ["feat", "fix"],
): OrganizationRepositoryRules {
  return {
    revision,
    entries: [{
      ...commits(types),
      mode: "warn" as const,
      explanation: "Organization baseline.",
      locked,
    }],
  };
}
const override = (
  types: string[],
  enabled = true,
): RepositoryRuleOverrides => ({
  entries: [{ ...commits(types), enabled }],
});

Deno.test("absent override inherits organization entry", async () => {
  const result = await resolveRepositoryRules(org(3, false), { entries: [] });
  assertEquals(result.organizationRevision, 3);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].provenance, "inherited");
  assertEquals(result.entries[0].organizationRevision, 3);
  const { locked: _locked, ...orgEntry } = org(3, false).entries[0];
  assertEquals(result.entries[0], {
    ...orgEntry,
    provenance: "inherited",
    organizationRevision: 3,
  });
});

Deno.test("unlocked override replaces whole entry; arrays do not merge", async () => {
  const result = await resolveRepositoryRules(
    org(3, false),
    override(["docs"]),
  );
  const entry = result.entries[0];
  assertEquals(entry, {
    ...override(["docs"]).entries[0],
    provenance: "repository_override",
    organizationRevision: 3,
  });
  assertEquals(entry.mode, "require");
  assertEquals("explanation" in entry, false);
  assertEquals(
    (entry.options as { types: string[] }).types,
    ["docs"],
  );
});

Deno.test("locked entry wins, override superseded, lock removal reactivates", async () => {
  const saved = override(["docs"]);
  const locked = await resolveRepositoryRules(org(4, true), saved);
  assertEquals(locked.entries[0].provenance, "locked_by_organization");
  assertEquals(
    (locked.entries[0].options as { types: string[] }).types,
    ["feat", "fix"],
  );
  assertEquals(locked.supersededOverrides.length, 1);
  assertEquals(locked.supersededOverrides[0].ruleKey, "commits.semantic");
  const unlocked = await resolveRepositoryRules(org(5, false), saved);
  assertEquals(unlocked.entries[0].provenance, "repository_override");
  assertEquals(unlocked.supersededOverrides.length, 0);
  assertEquals(
    (unlocked.entries[0].options as { types: string[] }).types,
    ["docs"],
  );
});

Deno.test("disabled override on locked rule is a typed lock conflict", () => {
  const result = validateRepositoryRuleOverrides(
    org(4, true),
    override(["feat"], false),
  );
  assertEquals(result, {
    ok: false,
    conflicts: [{
      ruleKey: "commits.semantic",
      reason: "disables_locked_rule",
    }],
  });
  const replace = validateRepositoryRuleOverrides(
    org(4, true),
    override(["docs"]),
  );
  assert(!replace.ok);
  assertEquals(replace.conflicts[0].reason, "replaces_locked_rule");
  assertEquals(
    validateRepositoryRuleOverrides(org(4, false), override(["docs"])),
    { ok: true },
  );
});

Deno.test("resolving a lock conflict never weakens the lock", async () => {
  const result = await resolveRepositoryRules(
    org(4, true),
    override(["feat"], false),
  );
  assertEquals(result.entries[0].enabled, true);
  assertEquals(result.entries[0].provenance, "locked_by_organization");
});

Deno.test("no organization revision is an empty baseline; repository-only", async () => {
  for (const baseline of [null, undefined]) {
    const result = await resolveRepositoryRules(baseline, override(["feat"]));
    assertEquals(result.organizationRevision, 0);
    assertEquals(result.entries[0].provenance, "repository_only");
    assertEquals(result.entries[0].organizationRevision, null);
  }
  const empty = await resolveRepositoryRules(null, { entries: [] });
  assertEquals(empty.entries, []);
});

Deno.test("disabled override differs from absent override", async () => {
  const absent = await resolveRepositoryRules(org(2, false), { entries: [] });
  const disabled = await resolveRepositoryRules(
    org(2, false),
    override(["feat", "fix"], false),
  );
  assertEquals(disabled.entries[0].enabled, false);
  assertEquals(disabled.entries[0].provenance, "repository_override");
  assert(absent.digest !== disabled.digest);
});

Deno.test("digest is stable, sensitive to effective data, blind to superseded", async () => {
  const a = await resolveRepositoryRules(org(3, false), override(["docs"]));
  const b = await resolveRepositoryRules(org(3, false), override(["docs"]));
  assertEquals(a.digest, b.digest);
  assert(/^[0-9a-f]{64}$/.test(a.digest));
  const otherEntry = await resolveRepositoryRules(
    org(3, false),
    override(["docs", "ci"]),
  );
  assert(otherEntry.digest !== a.digest);
  const otherRevision = await resolveRepositoryRules(
    org(4, false),
    override(["docs"]),
  );
  assert(otherRevision.digest !== a.digest);
  const lockedA = await resolveRepositoryRules(
    org(4, true),
    override(["docs"]),
  );
  const lockedB = await resolveRepositoryRules(org(4, true), override(["ci"]));
  assertEquals(lockedA.digest, lockedB.digest);
});

Deno.test("schemas are strict, unique and bounded", async () => {
  assertThrows(() =>
    OrganizationRepositoryRulesSchema.parse({
      ...org(1, false),
      extra: true,
    })
  );
  assertThrows(() =>
    RepositoryRuleOverridesSchema.parse({
      entries: [override(["a"]).entries[0], override(["b"]).entries[0]],
    })
  );
  assertThrows(() =>
    OrganizationRepositoryRulesSchema.parse({ revision: 0, entries: [] })
  );
  await assertRejects(() =>
    resolveRepositoryRules(null, {
      entries: [{ ...commits(["x"]), bogus: 1 }],
    } as unknown as RepositoryRuleOverrides)
  );
  assertEquals(REPOSITORY_RULE_KEYS.length, 5);
});

Deno.test("locked entry equals the whole organization entry", async () => {
  const result = await resolveRepositoryRules(org(4, true), override(["docs"]));
  const { locked: _locked, ...orgEntry } = org(4, true).entries[0];
  assertEquals(result.entries[0], {
    ...orgEntry,
    provenance: "locked_by_organization",
    organizationRevision: 4,
  });
});

Deno.test("revision zero is rejected; empty baseline is null", () => {
  assertThrows(() =>
    OrganizationRepositoryRulesSchema.parse({ revision: 0, entries: [] })
  );
});

Deno.test("digest covers revision and provenance", async () => {
  const r3 = await resolveRepositoryRules(
    { revision: 3, entries: [] },
    { entries: [] },
  );
  const r4 = await resolveRepositoryRules(
    { revision: 4, entries: [] },
    { entries: [] },
  );
  assert(r3.digest !== r4.digest);
  const unlocked = await resolveRepositoryRules(org(3, false), { entries: [] });
  const locked = await resolveRepositoryRules(org(3, true), { entries: [] });
  assertEquals(
    { ...unlocked.entries[0], provenance: "x" },
    { ...locked.entries[0], provenance: "x" },
  );
  assert(unlocked.digest !== locked.digest);
});
