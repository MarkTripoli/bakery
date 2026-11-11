import { assertEquals } from "@std/assert";
import { changedRetainedFields } from "../../apps/server/src/modules/projects/rules-retention.ts";
import type { RepositoryVersionedProfileConfig } from "../../packages/contracts/src/repository-inspection.ts";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";
import { baseProfileConfig } from "../helpers/repository-rule-entries.ts";

const policy = {
  schemaVersion: 1,
  commands: [{ id: "test.required", argv: ["pnpm", "test"] }],
  allowedEffects: ["artifact_only"],
  lockedConfiguration: { branches: true, worktree: true, checker: true },
  decisions: [{ commandId: "test.required", mode: "require" }],
};
const next = (extra: Record<string, unknown> = {}) =>
  RepositoryProfileConfigSchema.parse({ ...baseProfileConfig, ...extra });
const active = (extra: Record<string, unknown> = {}) =>
  ({
    ...baseProfileConfig,
    schemaVersion: 2,
    ...extra,
  }) as unknown as RepositoryVersionedProfileConfig;

Deno.test("retained fields compare canonically and name only the changed ones", () => {
  assertEquals(changedRetainedFields(active(), next()), []);
  // Key order is irrelevant.
  assertEquals(
    changedRetainedFields(
      active({ branches: { allowedPatterns: ["feature/*"], base: "main" } }),
      next(),
    ),
    [],
  );
  assertEquals(
    changedRetainedFields(
      active(),
      next({ branches: { base: "main", allowedPatterns: ["x/*"] } }),
    ),
    ["branches"],
  );
  assertEquals(
    changedRetainedFields(
      active(),
      next({
        worktree: { root: ".o" },
        agentBindings: {
          "harness.implement": "11111111-1111-4111-8111-111111111111",
        },
      }),
    ),
    ["worktree", "agentBindings"],
  );
});

Deno.test("an active fixed policy must be carried; presence is all the guard checks", () => {
  const trusted = {
    ...policy,
    trustedChecker: {
      kind: "repository-inspection",
      configDigest: "a".repeat(64),
    },
  };
  assertEquals(
    changedRetainedFields(active({ fixedPolicy: trusted }), next()),
    ["fixedPolicy"],
  );
  assertEquals(changedRetainedFields(active(), next()), []);
  // A config carrying its own fixedPolicy takes the fixed-policy path and
  // never reaches the guard, so its content is deliberately not compared.
  assertEquals(
    changedRetainedFields(
      active({ fixedPolicy: trusted }),
      next({ fixedPolicy: policy }),
    ),
    [],
  );
});
