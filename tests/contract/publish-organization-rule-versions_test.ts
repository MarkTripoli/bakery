import { assert, assertEquals } from "@std/assert";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import { REPOSITORY_RULE_KEYS } from "../../packages/contracts/src/repository-rules.ts";
import {
  allRuleEntries,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  RepositoryRulesImplementedAction,
  repositoryRulesImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  createRepositoryRulesActionRegistry,
  type RepositoryRulesActionHandlers,
} from "../../apps/server/src/modules/repository-rules/actions.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

const expectedActions = [
  "repositoryRuleVersions.create",
  "repositoryRuleVersions.list",
  "repositoryRules.get",
];

// The preview slice (#474) adds one more organization-path operation.
const registryActions = [
  "repositoryRulePreviews.createForOrganization",
  ...expectedActions,
].sort();

Deno.test("repository rules registry implements exactly the four catalog actions", () => {
  const unavailable = () => Promise.reject(new Error("not called"));
  const registry = createRepositoryRulesActionRegistry(
    {} as PgDatabase,
    {
      getRules: unavailable,
      publishVersion: unavailable,
      listVersions: unavailable,
      previewOrganization: unavailable,
    } as unknown as RepositoryRulesActionHandlers,
  );
  assertEquals(
    registry.list().map(({ name }) => name).sort(),
    registryActions,
  );
  assertEquals([...repositoryRulesImplementedActions].sort(), registryActions);
  assertEquals(
    Object.values(RepositoryRulesImplementedAction).sort(),
    registryActions,
  );
});

Deno.test("catalog declares Admin organization-path operations with the design paths", () => {
  const entries = catalogActions.filter(({ action }) =>
    expectedActions.includes(action)
  );
  assertEquals(entries.length, 3);
  const byAction = Object.fromEntries(
    entries.map((entry) => [entry.action, entry]),
  );
  assertEquals(byAction["repositoryRules.get"]?.method, "GET");
  assertEquals(
    byAction["repositoryRules.get"]?.path,
    "/v1/organizations/{id}/repository-rules",
  );
  assertEquals(byAction["repositoryRuleVersions.create"]?.method, "POST");
  assertEquals(
    byAction["repositoryRuleVersions.create"]?.path,
    "/v1/organizations/{id}/repository-rule-versions",
  );
  assertEquals(byAction["repositoryRuleVersions.list"]?.method, "GET");
  assertEquals(
    byAction["repositoryRuleVersions.list"]?.path,
    "/v1/organizations/{id}/repository-rule-versions",
  );
  for (const entry of entries) {
    assertEquals(entry.access, "Admin");
    assertEquals(entry.organizationContext, "required_authenticated_context");
    assertEquals(
      (entry as { organizationIdParam?: string }).organizationIdParam,
      "id",
    );
  }
  assertEquals(
    byAction["repositoryRules.get"]?.permission,
    "repositoryRule:read",
  );
  assertEquals(
    byAction["repositoryRuleVersions.list"]?.permission,
    "repositoryRule:read",
  );
  assertEquals(
    byAction["repositoryRuleVersions.create"]?.permission,
    "repositoryRule:manage",
  );
  assertEquals(
    byAction["repositoryRuleVersions.create"]?.idempotency,
    "Idempotency-Key required",
  );
  assertEquals(
    byAction["repositoryRuleVersions.create"]?.event,
    "repositoryRules.published",
  );
  assertEquals(byAction["repositoryRules.get"]?.idempotency, "read");
  assertEquals(byAction["repositoryRuleVersions.list"]?.idempotency, "read");
});

Deno.test("publication input carries expectedRevision and entries, never a revision", () => {
  const schema = contractSchemas.RepositoryRuleVersionCreate;
  assertEquals(
    schema.safeParse({ expectedRevision: 0, entries: [] }).success,
    true,
  );
  for (
    const invalid of [
      {},
      { entries: [] },
      { expectedRevision: 0 },
      { expectedRevision: -1, entries: [] },
      { expectedRevision: 1.5, entries: [] },
      { expectedRevision: 0, entries: [], revision: 1 },
    ]
  ) {
    assertEquals(
      schema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

Deno.test("read outputs expose the version, digest and author", () => {
  const digest = "a".repeat(64);
  const read = {
    organizationId: crypto.randomUUID(),
    revision: 0,
    entries: [],
    digest,
    createdAt: null,
    createdBy: null,
  };
  assertEquals(
    contractSchemas.OrganizationRepositoryRulesRead.safeParse(read).success,
    true,
  );
  assertEquals(
    contractSchemas.OrganizationRepositoryRuleVersion.safeParse({
      ...read,
      id: crypto.randomUUID(),
      revision: 1,
      createdAt: new Date().toISOString(),
      createdBy: crypto.randomUUID(),
    }).success,
    true,
  );
});

Deno.test("generated JSON schema types every rule key option with descriptions", async () => {
  const generated = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../packages/contracts/generated/contracts.json",
        import.meta.url,
      ),
    ),
  ) as { schemas: Record<string, Record<string, unknown>> };
  const schema = generated.schemas.RepositoryRuleVersionCreate as {
    properties: {
      entries: {
        type: string;
        maxItems: number;
        items: { oneOf: Record<string, unknown>[] };
      };
    };
  };
  assertEquals(schema.properties.entries.type, "array");
  assertEquals(schema.properties.entries.maxItems, REPOSITORY_RULE_KEYS.length);
  const variants = schema.properties.entries.items.oneOf;
  const keys = variants.map((variant) =>
    (variant.properties as Record<string, { const: string }>).ruleKey.const
  );
  assertEquals([...keys].sort(), [...REPOSITORY_RULE_KEYS].sort());
  const defects: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (
      ("type" in record || "oneOf" in record || "anyOf" in record ||
        "const" in record) &&
      descriptionDefectKind(record.description, path) !== undefined
    ) defects.push(path);
    for (const [key, child] of Object.entries(record)) {
      if (key === "required" || key === "enum") continue;
      walk(child, `${path}.${key}`);
    }
  };
  walk(schema.properties.entries, "entries");
  assertEquals(defects, []);
  for (const variant of variants) {
    const options =
      (variant.properties as Record<string, { additionalProperties?: unknown }>)
        .options;
    assertEquals(options.additionalProperties, false);
  }
});

Deno.test("publication input validates every rule key and rejects loose options", () => {
  const schema = contractSchemas.RepositoryRuleVersionCreate;
  const entries = allRuleEntries();
  assertEquals(entries.map((entry) => entry.ruleKey), [
    ...REPOSITORY_RULE_KEYS,
  ]);
  for (const entry of entries) {
    assertEquals(
      schema.safeParse({ expectedRevision: 0, entries: [entry] }).success,
      true,
      entry.ruleKey,
    );
  }
  assertEquals(
    schema.safeParse({ expectedRevision: 0, entries }).success,
    true,
  );
  for (const entry of entries) {
    const unknownOption = {
      ...entry,
      options: { ...entry.options, surprise: true },
    };
    const wrongType = {
      ...entry,
      options: { ...entry.options, ...wrongTyped(entry.ruleKey) },
    };
    for (const bad of [unknownOption, wrongType]) {
      assert(
        !schema.safeParse({ expectedRevision: 0, entries: [bad] }).success,
        entry.ruleKey,
      );
    }
  }
  assert(
    !schema.safeParse({
      expectedRevision: 0,
      entries: [{ ...titleEntry(), ruleKey: "unknown.rule" }],
    }).success,
  );
});

function wrongTyped(ruleKey: string): Record<string, unknown> {
  switch (ruleKey) {
    case "changeRequest.description":
      return { requiredSections: "Summary" };
    case "code.magicNumbers":
      return { allowedNumbers: ["one"] };
    case "code.magicStrings":
      return { checkBinding: 7 };
    default:
      return { maxSubjectLength: "long" };
  }
}

Deno.test("publication input rejects NUL and unpaired surrogates in free text", () => {
  const schema = contractSchemas.RepositoryRuleVersionCreate;
  const [, , description] = allRuleEntries();
  for (const template of ["bad\u0000text", "lone\ud800surrogate"]) {
    assert(
      !schema.safeParse({
        expectedRevision: 0,
        entries: [{
          ...description,
          options: { ...description.options, template },
        }],
      }).success,
    );
  }
  assert(
    schema.safeParse({
      expectedRevision: 0,
      entries: [{
        ...description,
        options: { ...description.options, template: "pair \ud83d\ude00" },
      }],
    }).success,
  );
});
