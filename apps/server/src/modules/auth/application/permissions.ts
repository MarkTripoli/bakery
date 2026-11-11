import {
  ActionAccess,
  type ActionAccess as ActionAccessValue,
  catalogActions,
  type CatalogPermissionKey,
  OrganizationRole,
  type OrganizationRole as OrganizationRoleValue,
} from "@bakery/contracts/contracts";

export type SystemRole = OrganizationRoleValue;

const minimumRoleByAccess = new Map<
  ActionAccessValue,
  OrganizationRoleValue
>([
  [ActionAccess.Admin, OrganizationRole.Admin],
  [ActionAccess.Developer, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperOrWorkerPinnedVersionAndCurrentLease,
    OrganizationRole.Developer,
  ],
  [ActionAccess.DeveloperAndActionGrant, OrganizationRole.Developer],
  [ActionAccess.AuthorizedOwnerMember, OrganizationRole.Developer],
  [
    ActionAccess.AuthorizedOwnerMemberAndInstallGrant,
    OrganizationRole.Developer,
  ],
  [ActionAccess.CurrentMember, OrganizationRole.Developer],
  [ActionAccess.CurrentMemberLinkingSelf, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperForPersonalAdminForOrganization,
    OrganizationRole.Admin,
  ],
  [ActionAccess.DeveloperAndAdmissionAuthority, OrganizationRole.Developer],
  [ActionAccess.DeveloperAndDeployGrant, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperAndExactExternalActionGrant,
    OrganizationRole.Developer,
  ],
  [ActionAccess.DeveloperAndResourceRead, OrganizationRole.Developer],
  [
    ActionAccess.DeveloperAndSourceAndDestinationRead,
    OrganizationRole.Developer,
  ],
  [ActionAccess.DeveloperAndSourceRead, OrganizationRole.Developer],
  [ActionAccess.ExactActionReadGrant, OrganizationRole.Developer],
  [ActionAccess.InitiatingPrincipalOrAdmin, OrganizationRole.Developer],
  [ActionAccess.LinkedPrincipalOrAdmin, OrganizationRole.Developer],
  [ActionAccess.OrganizationMember, OrganizationRole.Developer],
  [ActionAccess.OwnerForPersonalAdminForOrganization, OrganizationRole.Admin],
]);

const minimumRoleByPermission = new Map<
  CatalogPermissionKey,
  OrganizationRoleValue
>();

for (const action of catalogActions) {
  const minimum = minimumRoleByAccess.get(action.access);
  if (action.permission === null || minimum === undefined) continue;
  const existing = minimumRoleByPermission.get(action.permission);
  if (existing !== undefined && existing !== minimum) {
    throw new Error(`PERMISSION_MINIMUM_ROLE_CONFLICT:${action.permission}`);
  }
  minimumRoleByPermission.set(action.permission, minimum);
}

const developerPermissions = [...minimumRoleByPermission]
  .filter(([, minimum]) => minimum === OrganizationRole.Developer)
  .map(([permission]) => permission)
  .sort();
const adminPermissions = [...minimumRoleByPermission.keys()].sort();

export const viewerPermissionExclusions = Object.freeze(
  {
    "auditEvent:read": "Audit history contains security-sensitive activity.",
    "capabilityBinding:read":
      "Capability bindings expose delegated authority relationships.",
    "event:read": "Live event streams expose operational activity.",
    "externalIdentityLink:read":
      "External identity links expose private cross-system identity mappings.",
    "integrationGrant:read":
      "Integration grants expose principal capability relationships.",
    "job:read": "Job records expose worker execution data.",
    "jobAttempt:read": "Job attempts expose worker execution data.",
    "outputStream:read": "Output streams expose live execution data.",
    "pluginState:read": "Plugin state may contain arbitrary owner-scoped data.",
    "secret:read": "Secret reads expose credential metadata.",
    "session:read":
      "Agent sessions expose execution-resumption and harness metadata.",
    "sync:read": "Sync snapshots expose broad organization state.",
    "ticketSource:read":
      "A ticket source policy exposes which principal Bakery acts as and which GitHub actors may trigger it.",
    "worker:read": "Worker records expose infrastructure data.",
  } satisfies Partial<Record<CatalogPermissionKey, string>>,
);

const viewerExclusions = new Set<CatalogPermissionKey>(
  Object.keys(viewerPermissionExclusions) as CatalogPermissionKey[],
);
const viewerPermissions = developerPermissions.filter((permission) =>
  permission.endsWith(":read") && !viewerExclusions.has(permission)
);

export const rolePermissions = Object.freeze(
  {
    admin: Object.freeze(adminPermissions),
    developer: Object.freeze(developerPermissions),
    viewer: Object.freeze(viewerPermissions),
    guest: Object.freeze([] as CatalogPermissionKey[]),
  } as const satisfies Record<SystemRole, readonly CatalogPermissionKey[]>,
);

export function permissionMinimumRole(
  permission: CatalogPermissionKey,
): OrganizationRoleValue | undefined {
  return minimumRoleByPermission.get(permission);
}

export function roleHasPermission(
  role: SystemRole,
  permission: CatalogPermissionKey,
): boolean {
  return rolePermissions[role].includes(permission);
}

/** Every permission key the catalog assigns to at least one action. */
export const catalogPermissionKeys: readonly CatalogPermissionKey[] = Object
  .freeze(
    [
      ...new Set(
        catalogActions.flatMap((action) =>
          action.permission === null ? [] : [action.permission]
        ),
      ),
    ].sort(),
  );

const catalogPermissionKeySet: ReadonlySet<string> = new Set(
  catalogPermissionKeys,
);

/** True when `value` is a permission key the catalog declares. */
export function isCatalogPermissionKey(
  value: unknown,
): value is CatalogPermissionKey {
  return typeof value === "string" && catalogPermissionKeySet.has(value);
}
