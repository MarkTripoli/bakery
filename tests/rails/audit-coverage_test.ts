import { assert, assertEquals } from "@std/assert";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import {
  AUDIT_MATRIX_ACTIONS,
  AUDIT_MATRIX_PLUGIN_OPERATIONS,
} from "../helpers/audit-matrix-actions.ts";

/**
 * Permission resource keys that name an authentication or authorization
 * resource. A key matches when it contains one of the stems (case-insensitive)
 * or equals one of the exact resource names.
 */
const AUTH_RESOURCE_STEMS = [
  "organization",
  "member",
  "invitation",
  "installation",
  "setting",
  "licen",
  "grant",
  "token",
  "principal",
  "binding",
  "role",
  "sso",
  "scim",
] as const;
const AUTH_RESOURCE_NAMES = new Set([
  "browsersession",
  "connectedclient",
  "userpreference",
]);

/** Resource keys that contain a stem but are not access control. */
const NOT_AUTH_RESOURCES = new Map([
  ["projectrole", "project roles configure agent workflow, not who may act"],
]);

type CatalogEntry = {
  action: string;
  method: string;
  permission: string | null;
};

/**
 * A resource key matches when one of its camelCase words equals or starts with
 * a stem (`permissionGrant` has the word `grant`; `association` is one word
 * that does not start with `sso`), never on a mid-word substring.
 */
function isAuthResource(permission: string): boolean {
  const name = permission.split(":")[0];
  const resource = name.toLowerCase();
  if (NOT_AUTH_RESOURCES.has(resource)) return false;
  if (AUTH_RESOURCE_NAMES.has(resource)) return true;
  const words = name.split(/(?=[A-Z])/).map((word) => word.toLowerCase());
  return words.some((word) =>
    AUTH_RESOURCE_STEMS.some((stem) => word.startsWith(stem))
  );
}

/**
 * Implemented auth-resource mutations that the audit matrix does not list.
 * Only implemented actions are required, so a new auth-resource mutation
 * becomes required as soon as it is implemented (`principals.*`,
 * `permissionGrants.*` and `accessTokens.*` are). `secrets.*` is
 * outside the stems; its four audit rows go through `appendAudit` in
 * `modules/secrets/postgres.ts` and are covered by the secrets suite.
 */
export function missingAuditMatrixActions(
  catalog: readonly CatalogEntry[],
  implemented: ReadonlySet<string>,
  matrix: ReadonlySet<string>,
): string[] {
  return catalog
    .filter((entry) =>
      entry.method.toUpperCase() !== "GET" && entry.permission !== null &&
      isAuthResource(entry.permission) && implemented.has(entry.action) &&
      !matrix.has(entry.action)
    )
    .map((entry) => entry.action)
    .sort();
}

Deno.test("every implemented auth-resource mutation appears in the audit matrix", () => {
  const missing = missingAuditMatrixActions(
    catalogActions,
    new Set<string>(implementedActions),
    new Set<string>(AUDIT_MATRIX_ACTIONS),
  );
  assertEquals(
    missing,
    [],
    `add these actions to tests/helpers/audit-matrix-actions.ts and cover them in the audit matrix: ${
      missing.join(", ")
    }`,
  );
});

Deno.test("the audit matrix lists only real catalog mutations", () => {
  const known = new Map(catalogActions.map((entry) => [entry.action, entry]));
  for (const action of AUDIT_MATRIX_ACTIONS) {
    const entry = known.get(action);
    assert(entry, `${action} is not a catalog action`);
    assert(entry.method.toUpperCase() !== "GET", `${action} is not a mutation`);
  }
  assertEquals(new Set(AUDIT_MATRIX_ACTIONS).size, AUDIT_MATRIX_ACTIONS.length);
});

Deno.test("the coverage rail reports an unlisted mutation by name", () => {
  const catalog: CatalogEntry[] = [
    { action: "members.add", method: "POST", permission: "member:manage" },
    { action: "members.list", method: "GET", permission: "member:read" },
    { action: "tasks.create", method: "POST", permission: "task:write" },
    {
      action: "assoc.update",
      method: "PATCH",
      permission: "association:manage",
    },
    {
      action: "roles.create",
      method: "POST",
      permission: "projectRole:manage",
    },
  ];
  assertEquals(
    missingAuditMatrixActions(
      catalog,
      new Set(["members.add", "members.list", "tasks.create", "assoc.update"]),
      new Set(),
    ),
    ["members.add"],
  );
  assertEquals(
    missingAuditMatrixActions(
      catalog,
      new Set(["members.add"]),
      new Set(["members.add"]),
    ),
    [],
  );
});

/**
 * Plugin endpoints are not catalog actions, so the catalog scan above cannot
 * see them. Auth plugin modules therefore declare their audit operations in an
 * `operations.ts` as `"auth.…"` string literals; every one must be listed in
 * `AUDIT_MATRIX_PLUGIN_OPERATIONS` (and so is covered by the matrix and the
 * secret scan).
 */
export function missingPluginOperations(
  declared: readonly string[],
  matrix: ReadonlySet<string>,
): string[] {
  return [...new Set(declared)].filter((operation) => !matrix.has(operation))
    .sort();
}

function declaredPluginOperations(source: string): string[] {
  return [...source.matchAll(/"(auth\.[A-Za-z]+(?:\.[A-Za-z]+)+)"/g)].map((m) =>
    m[1]
  );
}

Deno.test("every plugin audit operation declared by an auth plugin is in the audit matrix", async () => {
  const root = new URL("../../apps/server/src/modules/auth/", import.meta.url);
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    const file = new URL(`${entry.name}/operations.ts`, root);
    if (await Deno.stat(file).then(() => true, () => false)) {
      files.push(await Deno.readTextFile(file));
    }
  }
  assert(files.length > 0, "no plugin operations.ts found");
  const declared = files.flatMap(declaredPluginOperations);
  assertEquals(
    missingPluginOperations(declared, new Set(AUDIT_MATRIX_PLUGIN_OPERATIONS)),
    [],
    "add these operations to AUDIT_MATRIX_PLUGIN_OPERATIONS and cover them in runSsoAuditMatrix",
  );
  assertEquals(
    new Set(AUDIT_MATRIX_PLUGIN_OPERATIONS).size,
    AUDIT_MATRIX_PLUGIN_OPERATIONS.length,
  );
});

Deno.test("the plugin coverage rail reports an undeclared operation by name", () => {
  const source =
    'export const OPS = { a: "auth.widget.create", b: "auth.widget.purge" };';
  assertEquals(
    missingPluginOperations(
      declaredPluginOperations(source),
      new Set(["auth.widget.create"]),
    ),
    ["auth.widget.purge"],
  );
  assertEquals(declaredPluginOperations("const x = 'not an op'"), []);
});
