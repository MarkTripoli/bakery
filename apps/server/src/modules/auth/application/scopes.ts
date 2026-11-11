import type { CatalogPermissionKey } from "@bakery/contracts/contracts";

/**
 * Scope bundles shared by access tokens and the MCP resource. A scope only
 * restricts what the principal's live permissions already allow; it never adds
 * authority.
 */
export const AccessScope = Object.freeze(
  {
    Read: "bakery:read",
    Operate: "bakery:operate",
    Admin: "bakery:admin",
  } as const,
);
export type AccessScope = (typeof AccessScope)[keyof typeof AccessScope];

export const ACCESS_SCOPES: readonly AccessScope[] = Object.freeze([
  AccessScope.Read,
  AccessScope.Operate,
  AccessScope.Admin,
]);

export function isAccessScope(value: string): value is AccessScope {
  return (ACCESS_SCOPES as readonly string[]).includes(value);
}

function verbOf(permission: string): string {
  return permission.slice(permission.indexOf(":") + 1);
}

/** True when `scope` covers `permission`: read = `:read`, operate = non-`manage`, admin = all. */
export function scopeCovers(
  scope: AccessScope,
  permission: CatalogPermissionKey | string,
): boolean {
  switch (scope) {
    case AccessScope.Admin:
      return true;
    case AccessScope.Operate:
      return verbOf(permission) !== "manage";
    case AccessScope.Read:
      return verbOf(permission) === "read";
  }
}

/** The single scope decision for tokens and the MCP resource. */
export function scopeAllows(
  permission: CatalogPermissionKey | string,
  scopes: readonly string[],
): boolean {
  return ACCESS_SCOPES.some((scope) =>
    scopes.includes(scope) && scopeCovers(scope, permission)
  );
}

/** Smallest bundles that would cover `permission`, narrowest first. */
export function minimalScopes(
  permission: CatalogPermissionKey | string,
): AccessScope[] {
  const verb = verbOf(permission);
  if (verb === "read") return [AccessScope.Read];
  if (verb === "manage") return [AccessScope.Admin];
  return [AccessScope.Operate];
}

/** Narrowest single bundle covering every listed permission. */
export function minimalScopesFor(
  permissions: readonly (CatalogPermissionKey | string)[],
): AccessScope[] {
  const needed = new Set(permissions.flatMap((p) => minimalScopes(p)));
  if (needed.has(AccessScope.Admin)) return [AccessScope.Admin];
  if (needed.has(AccessScope.Operate)) return [AccessScope.Operate];
  return needed.size > 0 ? [AccessScope.Read] : [];
}

const scopeRank: Readonly<Record<AccessScope, number>> = {
  [AccessScope.Read]: 1,
  [AccessScope.Operate]: 2,
  [AccessScope.Admin]: 3,
};

/** True when one held scope is `wanted` or a broader bundle (admin > operate > read). */
export function scopeImplies(
  held: readonly string[],
  wanted: AccessScope,
): boolean {
  return held.some((scope) =>
    isAccessScope(scope) && scopeRank[scope] >= scopeRank[wanted]
  );
}
