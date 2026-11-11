import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";
import { clientManifest } from "../../packages/contracts/generated/client-manifest.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";

const APPLICATION_ID = "00000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000003";
const CREATED_BY = "00000000-0000-4000-8000-000000000004";
const PROFILE_ID = "00000000-0000-4000-8000-000000000005";
const TIMESTAMP = "2024-01-01T00:00:00.000Z";

const VALID_PROFILE_CONFIG = {
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};

function baseTask(): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000006",
    applicationId: APPLICATION_ID,
    repositoryId: REPOSITORY_ID,
    conversationId: CONVERSATION_ID,
    parentTaskId: null,
    title: "Fix the widget",
    description: "The widget is broken.",
    taskType: "bug",
    status: "draft",
    priority: 1,
    createdBy: CREATED_BY,
    currentRunId: null,
    archivedAt: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    version: 1,
  };
}

Deno.test("TaskCreate accepts a described expected repository profile precondition", () => {
  const field = clientManifest.schemas.TaskCreate.properties
    .repositoryProfileId;
  assertEquals(field.description.length > 20, true);
  assertEquals(
    contractSchemas.TaskCreate.safeParse({
      applicationId: APPLICATION_ID,
      repositoryId: REPOSITORY_ID,
      repositoryProfileId: PROFILE_ID,
      taskType: "feature",
      title: "Create repository profile UI",
    }).success,
    true,
  );
});

Deno.test("RepositoryUpdate accepts selecting an active profile", () => {
  assertEquals(
    contractSchemas.RepositoryUpdate.safeParse({ activeProfileId: PROFILE_ID })
      .success,
    true,
  );
});

Deno.test("Task parses with the repository profile pin present, absent, or explicitly null", () => {
  assertEquals(contractSchemas.Task.safeParse(baseTask()).success, true);
  assertEquals(
    contractSchemas.Task.safeParse({
      ...baseTask(),
      repositoryProfileId: null,
      repositoryProfileRevision: null,
      repositoryProfileDigest: null,
    }).success,
    true,
  );
});

Deno.test("RepositoryProfileConfigSchema accepts a valid version 1 fixed-workflow config", () => {
  assertEquals(
    RepositoryProfileConfigSchema.safeParse(VALID_PROFILE_CONFIG).success,
    true,
  );
});

Deno.test("RepositoryProfileConfigSchema preserves absent selectors and canonicalizes bounded immutable agent selectors", () => {
  const absent = RepositoryProfileConfigSchema.parse(VALID_PROFILE_CONFIG);
  assertEquals(absent, VALID_PROFILE_CONFIG);
  assertEquals(canonicalJson(absent), canonicalJson(VALID_PROFILE_CONFIG));

  const first = "00000000-0000-4000-8000-000000000011";
  const second = "00000000-0000-4000-8000-000000000012";
  const left = RepositoryProfileConfigSchema.parse({
    ...VALID_PROFILE_CONFIG,
    agentBindings: {
      "quality.check": second,
      "harness.implement": first,
    },
  });
  const right = RepositoryProfileConfigSchema.parse({
    ...VALID_PROFILE_CONFIG,
    agentBindings: {
      "harness.implement": first,
      "quality.check": second,
    },
  });
  assertEquals(canonicalJson(left), canonicalJson(right));
});

Deno.test("RepositoryProfileConfigSchema rejects invalid or over-limit agent selectors", () => {
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...VALID_PROFILE_CONFIG,
      agentBindings: { quality: "not-an-immutable-version" },
    }).success,
    false,
  );
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...VALID_PROFILE_CONFIG,
      agentBindings: Object.fromEntries(
        Array.from({ length: 18 }, (_, index) => [
          `quality.check${index}`,
          `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        ]),
      ),
    }).success,
    false,
  );
});

Deno.test("RepositoryProfileConfigSchema rejects an unsupported schema version", () => {
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...VALID_PROFILE_CONFIG,
      schemaVersion: 2,
    }).success,
    false,
  );
});

Deno.test("RepositoryProfileConfigSchema rejects a non-fixed workflow kind", () => {
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...VALID_PROFILE_CONFIG,
      workflow: { kind: "dynamic" },
    }).success,
    false,
  );
});

Deno.test("RepositoryProfileConfigSchema rejects an empty allowed branch pattern list", () => {
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...VALID_PROFILE_CONFIG,
      branches: { base: "main", allowedPatterns: [] },
    }).success,
    false,
  );
});

Deno.test("RepositoryProfileConfigSchema rejects more than 32 allowed branch patterns", () => {
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...VALID_PROFILE_CONFIG,
      branches: {
        base: "main",
        allowedPatterns: Array.from(
          { length: 33 },
          (_, index) => `feature/${index}`,
        ),
      },
    }).success,
    false,
  );
});

Deno.test("RepositoryProfileConfigSchema rejects an escaping or absolute worktree root", () => {
  for (const root of ["../x", "/abs", "a/../b"]) {
    assertEquals(
      RepositoryProfileConfigSchema.safeParse({
        ...VALID_PROFILE_CONFIG,
        worktree: { root },
      }).success,
      false,
      `expected worktree root ${root} to be rejected`,
    );
  }
});

Deno.test("RepositoryProfileConfigSchema rejects an extra top-level key", () => {
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...VALID_PROFILE_CONFIG,
      extra: "unexpected",
    }).success,
    false,
  );
});
