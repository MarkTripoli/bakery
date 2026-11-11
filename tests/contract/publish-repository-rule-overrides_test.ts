import { assert, assertEquals } from "@std/assert";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import { REPOSITORY_RULE_KEYS } from "../../packages/contracts/src/repository-rules.ts";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  ProjectsImplementedAction,
  projectsImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  createProjectsActionRegistry,
  type ProjectsActionHandlers,
} from "../../apps/server/src/modules/projects/actions.ts";
import { resolveRepositoryRules } from "../../packages/contracts/src/repository-rules.ts";
import {
  allRuleEntries,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";

const digest = "a".repeat(64);
const config = {
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};

Deno.test("projects registry mounts repositoryRules.getEffective beside the profiles", () => {
  const unavailable = () => Promise.reject(new Error("not called"));
  const handlers = new Proxy({}, { get: () => unavailable });
  const registry = createProjectsActionRegistry(
    handlers as unknown as ProjectsActionHandlers,
  );
  const action = registry.list().find(({ name }) =>
    name === "repositoryRules.getEffective"
  );
  assert(action);
  assertEquals(action.method, "GET");
  assertEquals(action.path, "/v1/repositories/:id/rules");
  assertEquals(
    ProjectsImplementedAction.RepositoryRulesGetEffective,
    "repositoryRules.getEffective",
  );
  assert(
    projectsImplementedActions.includes("repositoryRules.getEffective"),
  );
});

Deno.test("catalog declares the Developer repository read with its own permission", () => {
  const entry = catalogActions.find(({ action }) =>
    action === "repositoryRules.getEffective"
  );
  assert(entry);
  assertEquals(entry.method, "GET");
  assertEquals(entry.path, "/v1/repositories/{id}/rules");
  assertEquals(entry.access, "Developer");
  assertEquals(entry.permission, "repositoryEffectiveRule:read");
  assertEquals(entry.idempotency, "read");
  assertEquals(entry.input, "IdPath");
  assertEquals(entry.output, "RepositoryEffectiveRules");
  assertEquals(entry.mcp, "bakery_repositoryRules_getEffective");
  // S2's Admin read keeps its own key: one permission key, one minimum role.
  const adminRead = catalogActions.find(({ action }) =>
    action === "repositoryRules.get"
  );
  assertEquals(adminRead?.permission, "repositoryRule:read");
  assertEquals(adminRead?.access, "Admin");
  assert(
    !catalogActions.some((other) =>
      other.action !== "repositoryRules.getEffective" &&
      other.permission === "repositoryEffectiveRule:read"
    ),
  );
});

Deno.test("RepositoryProfileCreate stays additive: optional expectedOrganizationRulesRevision", () => {
  const schema = contractSchemas.RepositoryProfileCreate;
  const body = { revision: 1, config, digest };
  assertEquals(schema.safeParse(body).success, true);
  assertEquals(
    schema.safeParse({ ...body, expectedOrganizationRulesRevision: 0 })
      .success,
    true,
  );
  assertEquals(
    schema.safeParse({ ...body, expectedOrganizationRulesRevision: 7 }).success,
    true,
  );
  for (const invalid of [-1, 1.5, "1", null]) {
    assertEquals(
      schema.safeParse({ ...body, expectedOrganizationRulesRevision: invalid })
        .success,
      false,
      String(invalid),
    );
  }
  assertEquals(
    schema.safeParse({ ...body, unexpected: true }).success,
    false,
  );
});

Deno.test("effective output is typed with all five rule keys and provenance", async () => {
  const schema = contractSchemas.RepositoryEffectiveRules;
  const resolved = await resolveRepositoryRules(
    { revision: 3, entries: allRuleEntries() as never },
    { entries: [] },
  );
  const body = {
    repositoryId: crypto.randomUUID(),
    profileId: crypto.randomUUID(),
    profileRevision: 2,
    ...resolved,
  };
  assertEquals(resolved.entries.map(({ ruleKey }) => ruleKey), [
    ...REPOSITORY_RULE_KEYS,
  ]);
  assertEquals(schema.safeParse(body).success, true);
  assertEquals(
    schema.safeParse({ ...body, profileId: null, profileRevision: null })
      .success,
    true,
  );
  assertEquals(schema.safeParse({ ...body, extra: 1 }).success, false);
  for (const key of ["profileId", "profileRevision", "digest", "entries"]) {
    const { [key]: _removed, ...partial } = body as Record<string, unknown>;
    assertEquals(schema.safeParse(partial).success, false, key);
  }
  assertEquals(
    schema.safeParse({ ...body, digest: "ABC" }).success,
    false,
  );
  // Entries are typed, not opaque json.
  assertEquals(
    schema.safeParse({ ...body, entries: [{ ruleKey: "bogus.rule" }] })
      .success,
    false,
  );
  assertEquals(
    schema.safeParse({
      ...body,
      entries: [{ ...resolved.entries[0], provenance: "invented" }],
    }).success,
    false,
  );
  assertEquals(
    schema.safeParse({
      ...body,
      entries: [{ ...resolved.entries[0], locked: true }],
    }).success,
    false,
  );
  const tooMany = Array.from({ length: 6 }, () => resolved.entries[0]);
  assertEquals(schema.safeParse({ ...body, entries: tooMany }).success, false);
  // NUL and lone surrogates in free text are refused on the wire.
  for (const text of ["bad\u0000", "lone\ud800"]) {
    const entry = {
      ...resolved.entries[2],
      options: {
        ...(resolved.entries[2] as { options: object }).options,
        template: text,
      },
    };
    assertEquals(
      schema.safeParse({ ...body, entries: [entry] }).success,
      false,
    );
  }
  const override = { ...titleEntry(90) } as Record<string, unknown>;
  delete override.locked;
  const superseded = {
    ruleKey: "changeRequest.semanticTitle",
    reason: "locked_by_organization",
    override,
  };
  assertEquals(
    schema.safeParse({ ...body, supersededOverrides: [superseded] }).success,
    true,
  );
  assertEquals(
    schema.safeParse({
      ...body,
      supersededOverrides: [{ ...superseded, reason: "other" }],
    }).success,
    false,
  );
  assertEquals(
    schema.safeParse({
      ...body,
      supersededOverrides: [{ ...superseded, override: titleEntry(90) }],
    }).success,
    false,
  );
});

Deno.test("generated JSON schema types every effective rule key with descriptions", async () => {
  const generated = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../packages/contracts/generated/contracts.json",
        import.meta.url,
      ),
    ),
  ) as { schemas: Record<string, Record<string, unknown>> };
  const schema = generated.schemas.RepositoryEffectiveRules as {
    properties: Record<
      string,
      {
        type?: string;
        maxItems?: number;
        items?: { oneOf: Record<string, unknown>[] };
      }
    >;
  };
  const entries = schema.properties.entries;
  assertEquals(entries.type, "array");
  assertEquals(entries.maxItems, REPOSITORY_RULE_KEYS.length);
  const keys = entries.items!.oneOf.map((variant) =>
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
  walk(schema.properties, "RepositoryEffectiveRules");
  assertEquals(defects, []);
  const create = generated.schemas.RepositoryProfileCreate as {
    properties: Record<string, { description?: string; minimum?: number }>;
    required: string[];
  };
  const expected = create.properties.expectedOrganizationRulesRevision;
  assertEquals(expected?.minimum, 0);
  assert(!create.required.includes("expectedOrganizationRulesRevision"));
  assertEquals(
    descriptionDefectKind(
      expected?.description,
      "RepositoryProfileCreate.expectedOrganizationRulesRevision",
    ),
    undefined,
  );
});
