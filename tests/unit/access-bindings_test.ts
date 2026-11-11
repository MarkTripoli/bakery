import { assert, assertEquals } from "@std/assert";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import {
  accessScopeClause,
  accessScopeFor,
  BINDABLE_ACTIONS,
  bindingAllows,
  bindingCovers,
  type ResourceBinding,
} from "../../apps/server/src/modules/auth/application/bindings.ts";
import { rolePermissions } from "../../apps/server/src/modules/auth/application/permissions.ts";

const repoBinding: ResourceBinding = {
  roleKey: "viewer",
  scopeType: "repository",
  scopeId: "r1",
};
const appBinding: ResourceBinding = {
  roleKey: "developer",
  scopeType: "application",
  scopeId: "a1",
};

Deno.test("an application binding covers its repositories and tasks, a repository binding only its own", () => {
  assert(
    bindingCovers(appBinding, { applicationId: "a1", repositoryId: null }),
  );
  assert(
    bindingCovers(appBinding, { applicationId: "a1", repositoryId: "r9" }),
  );
  assert(
    !bindingCovers(appBinding, { applicationId: "a2", repositoryId: "r1" }),
  );

  assert(
    bindingCovers(repoBinding, { applicationId: "a1", repositoryId: "r1" }),
  );
  assert(
    !bindingCovers(repoBinding, { applicationId: "a1", repositoryId: "r2" }),
  );
  // A task with no repository, or the application itself, is not the repository.
  assert(
    !bindingCovers(repoBinding, { applicationId: "a1", repositoryId: null }),
  );
});

Deno.test("a binding grants exactly its role's permissions", () => {
  assert(bindingAllows(repoBinding, "task:read"));
  assert(!bindingAllows(repoBinding, "task:write"));
  assert(bindingAllows(appBinding, "task:write"));
  assert(bindingAllows(appBinding, "run:write"));
  // Developer is not admin: no management of the resource itself.
  assert(!bindingAllows(appBinding, "application:manage"));
  assert(!bindingAllows(appBinding, "repository:manage"));
});

Deno.test("list scope collects only bindings whose role holds the permission", () => {
  assertEquals(accessScopeFor([repoBinding], "task:write"), undefined);
  assertEquals(accessScopeFor([repoBinding, appBinding], "task:write"), {
    applicationIds: ["a1"],
    repositoryIds: [],
  });
  assertEquals(accessScopeFor([repoBinding, appBinding], "task:read"), {
    applicationIds: ["a1"],
    repositoryIds: ["r1"],
  });
});

Deno.test("the scope clause numbers its placeholders and drops a null column", () => {
  const scope = { applicationIds: ["a1"], repositoryIds: ["r1", "r2"] };
  assertEquals(
    accessScopeClause(
      scope,
      { application: "application_id", repository: "repository_id" },
      5,
    ),
    {
      sql:
        "(application_id = any($5::uuid[]) or repository_id = any($6::uuid[]))",
      values: [["a1"], ["r1", "r2"]],
    },
  );
  assertEquals(
    accessScopeClause(scope, { application: "id", repository: null }, 7),
    { sql: "(id = any($7::uuid[]))", values: [["a1"]] },
  );
});

Deno.test("bindable actions are real catalog actions limited to work-resource permissions a developer holds", () => {
  const byName = new Map(catalogActions.map((a) => [a.action, a] as const));
  const allowedResources = new Set([
    "application",
    "repository",
    "task",
    "run",
    "runStep",
  ]);
  for (const [name, kind] of Object.entries(BINDABLE_ACTIONS)) {
    const action = byName.get(name as never);
    assert(action !== undefined, `${name} is not a catalog action`);
    const permission = action.permission!;
    assert(
      allowedResources.has(permission.split(":")[0]),
      `${name} unlocks ${permission}`,
    );
    // Reads and developer writes only: a binding can never confer an admin verb.
    assert(
      (rolePermissions.developer as readonly string[]).includes(permission),
      `${name} needs ${permission}, which a developer does not hold`,
    );
    assert(kind !== undefined);
  }
});
