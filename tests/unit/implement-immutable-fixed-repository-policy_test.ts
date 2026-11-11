import { assertEquals, assertRejects } from "@std/assert";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import {
  enforceWorkerFixedPolicy,
  NativeExecutorError,
} from "../../apps/worker/src/executor.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";

const draft = {
  schemaVersion: 1 as const,
  commands: [
    { id: "format.guide", argv: ["pnpm", "fmt"] },
    { id: "lint.warn", argv: ["pnpm", "lint"] },
    { id: "test.required", argv: ["pnpm", "test"] },
  ],
  allowedEffects: ["evidence_only"] as const,
  lockedConfiguration: { branches: true, worktree: true, checker: true },
  decisions: [
    { commandId: "format.guide", mode: "guide" as const },
    { commandId: "lint.warn", mode: "warn" as const },
    { commandId: "test.required", mode: "require" as const },
  ],
};
const checkPolicy = {
  schemaVersion: 1 as const,
  platform: "linux" as const,
  tools: [{ tool: "git" as const, required: true }],
  checks: [{
    id: "source.integrity",
    template: "source.integrity.v1" as const,
    tool: null,
    paths: [],
    required: true,
  }],
};

async function assignment(checks: string[]): Promise<JobAssignment> {
  const fixedPolicy = {
    ...draft,
    trustedChecker: {
      kind: "repository-inspection" as const,
      configDigest: await sha256Hex(canonicalJson(checkPolicy)),
    },
  };
  const config = {
    schemaVersion: 2 as const,
    workflow: { kind: "fixed" as const },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    checkPolicy,
    fixedPolicy,
  };
  return {
    action: "quality.check",
    input: {
      checks,
      // Fixed-policy admission binds a check to one exact commit.
      revision: "1".repeat(40),
      repositoryProfile: {
        organizationId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        repositoryId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        revision: 2,
        digest: await sha256Hex(canonicalJson(config)),
        config,
        observationId: crypto.randomUUID(),
        observationDigest: "a".repeat(64),
        baseSha: "b".repeat(40),
        fixedPolicyDigest: await sha256Hex(canonicalJson(fixedPolicy)),
        trustedCheckerConfigDigest: fixedPolicy.trustedChecker.configDigest,
      },
    },
  } as unknown as JobAssignment;
}

Deno.test("fixed policy draft rejects imported checker authority and weakening", () => {
  const profile = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    fixedPolicy: draft,
  };
  assertEquals(RepositoryProfileConfigSchema.safeParse(profile).success, true);
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...profile,
      fixedPolicy: {
        ...draft,
        lockedConfiguration: { ...draft.lockedConfiguration, checker: false },
      },
    }).success,
    false,
  );
  assertEquals(
    RepositoryProfileConfigSchema.safeParse({
      ...profile,
      fixedPolicy: {
        ...draft,
        trustedChecker: {
          kind: "repository-inspection",
          configDigest: "0".repeat(64),
        },
      },
    }).success,
    false,
  );
});

Deno.test("worker enforces fixed commands and guide warn require decisions", async () => {
  await enforceWorkerFixedPolicy(await assignment(["test.required"]));
  for (const checks of [["lint.warn"], ["test.required", "caller.command"]]) {
    await assertRejects(
      async () => await enforceWorkerFixedPolicy(await assignment(checks)),
      NativeExecutorError,
      "FIXED_REPOSITORY_POLICY_REJECTED",
    );
  }
});

Deno.test("worker denies missing or unauthorized trusted checker configuration", async () => {
  for (const defect of ["missing", "unauthorized"] as const) {
    const value = await assignment(["test.required"]);
    const input = value.input as Record<string, unknown>;
    const context = input.repositoryProfile as Record<string, unknown>;
    const config = context.config as Record<string, unknown>;
    const policy = config.fixedPolicy as Record<string, unknown>;
    if (defect === "missing") delete policy.trustedChecker;
    else {
      (policy.trustedChecker as Record<string, unknown>).configDigest = "0"
        .repeat(64);
    }
    await assertRejects(
      () => enforceWorkerFixedPolicy(value),
      NativeExecutorError,
      "FIXED_REPOSITORY_POLICY_REJECTED",
    );
  }
});
