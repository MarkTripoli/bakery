import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  ActionAccess,
  type ActionAccess as ActionAccessValue,
  catalogActions,
  type CatalogPermissionKey,
} from "../../packages/contracts/src/contracts.ts";
import { organizationMinimumRole } from "../../apps/server/src/modules/auth/application/authority.ts";
import {
  rolePermissions,
  viewerPermissionExclusions,
} from "../../apps/server/src/modules/auth/application/permissions.ts";

const nonPrincipalAccess = new Set<ActionAccessValue>([
  ActionAccess.Public,
  ActionAccess.EnrollmentToken,
  ActionAccess.Worker,
  ActionAccess.WorkerAndLease,
  ActionAccess.WorkerAndLeaseAndGrant,
  ActionAccess
    .VerifiedGitHubAppRawBodySignatureInstallationResourceRoutesToExistingOrganizationConnection,
  ActionAccess
    .NativeWebhookHMACCoversTimestampDeliveryIDAndRawBodyActiveSourceServiceGrantAndFixedTargetRoute,
  ActionAccess
    .ConfiguredSlackAppHMACOverTimestampAndExactRawBodyVerifiedWorkspaceChannelBindingCurrentLinkedHumanForPrivilegedCommands,
  ActionAccess.BoundBrowserAuthAttempt,
  ActionAccess.BoundBakeryAuthenticatedIdentityLinkAttempt,
]);

const requiredSensitiveViewerExclusions = [
  "auditEvent:read",
  "capabilityBinding:read",
  "event:read",
  "externalIdentityLink:read",
  "integrationGrant:read",
  "job:read",
  "jobAttempt:read",
  "outputStream:read",
  "pluginState:read",
  "secret:read",
  "session:read",
  "sync:read",
  "ticketSource:read",
  "worker:read",
] as const satisfies readonly CatalogPermissionKey[];

Deno.test("permission keys cover every principal catalog action", () => {
  const catalogPermissions = new Set<CatalogPermissionKey>();
  const minimums = new Map<CatalogPermissionKey, Set<string>>();

  for (const action of catalogActions) {
    const expectsNull = nonPrincipalAccess.has(action.access);
    assertEquals(
      action.permission === null,
      expectsNull,
      `${action.action}:${action.access}`,
    );
    if (action.permission === null) continue;
    assertMatch(action.permission, /^[a-z][a-zA-Z]*:[a-z][a-zA-Z]*$/);
    catalogPermissions.add(action.permission);
    const minimum = organizationMinimumRole(action.access) ?? "none";
    const permissionMinimums = minimums.get(action.permission) ?? new Set();
    permissionMinimums.add(minimum);
    minimums.set(action.permission, permissionMinimums);
  }

  for (const [permission, permissionMinimums] of minimums) {
    assertEquals(
      permissionMinimums.size,
      1,
      `${permission}:${[...permissionMinimums].join(",")}`,
    );
  }

  for (const permissions of Object.values(rolePermissions)) {
    assertEquals(new Set(permissions).size, permissions.length);
    for (const permission of permissions) {
      assert(catalogPermissions.has(permission), permission);
    }
  }
});

Deno.test("role permission sets match current minimums and exclude sensitive reads", () => {
  const byMinimum = new Map<string, Set<CatalogPermissionKey>>();
  for (const action of catalogActions) {
    if (action.permission === null) continue;
    const minimum = organizationMinimumRole(action.access);
    if (minimum === undefined) continue;
    const permissions = byMinimum.get(minimum) ?? new Set();
    permissions.add(action.permission);
    byMinimum.set(minimum, permissions);
  }
  const developer = [...(byMinimum.get("developer") ?? [])].sort();
  const admin = [
    ...new Set([
      ...(byMinimum.get("admin") ?? []),
      ...developer,
    ]),
  ].sort();
  assertEquals(rolePermissions.developer, developer);
  assertEquals(rolePermissions.admin, admin);

  const excluded = new Set(
    Object.keys(viewerPermissionExclusions) as CatalogPermissionKey[],
  );
  const viewer = developer.filter((permission) =>
    permission.endsWith(":read") && !excluded.has(permission)
  );
  assertEquals(rolePermissions.viewer, viewer);
  assertEquals(rolePermissions.guest, []);

  for (
    const [permission, reason] of Object.entries(
      viewerPermissionExclusions,
    )
  ) {
    assert(permission.endsWith(":read"), permission);
    assert(reason.length > 0, permission);
    assert(
      !rolePermissions.viewer.includes(permission as CatalogPermissionKey),
    );
  }

  for (const permission of requiredSensitiveViewerExclusions) {
    const reason = viewerPermissionExclusions[permission];
    assert(typeof reason === "string" && reason.length > 0, permission);
    assert(!rolePermissions.viewer.includes(permission), permission);
  }
});
