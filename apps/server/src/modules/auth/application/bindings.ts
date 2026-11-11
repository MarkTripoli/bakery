import {
  type CatalogActionName,
  type CatalogPermissionKey,
  OrganizationRole,
} from "@bakery/contracts/contracts";
import { roleHasPermission, type SystemRole } from "./permissions.ts";

/** Roles a binding may carry. Admin is organization-wide only. */
export const BINDING_ROLES = [
  OrganizationRole.Viewer,
  OrganizationRole.Developer,
] as const;
export type BindingRole = (typeof BINDING_ROLES)[number];

export const BINDING_SCOPE_TYPES = ["application", "repository"] as const;
export type BindingScopeType = (typeof BINDING_SCOPE_TYPES)[number];

/** One live resource role binding of the acting principal. */
export type ResourceBinding = Readonly<{
  roleKey: BindingRole;
  scopeType: BindingScopeType;
  scopeId: string;
}>;

/** The application and optional repository a request targets. */
export type BindingTarget = Readonly<{
  applicationId: string;
  repositoryId: string | null;
}>;

/** What a list action may return for a principal that holds only bindings. */
export type AccessScope = Readonly<{
  applicationIds: readonly string[];
  repositoryIds: readonly string[];
}>;

/** How a bindable action finds the resource it touches. */
export type BindableKind =
  | "list"
  | "application"
  | "repository"
  | "task"
  | "run"
  | "taskInput";

/**
 * Actions a binding can unlock. Every other action stays organization-wide:
 * a binding never reaches events, artifacts, controls, checks, secrets or
 * administration.
 */
export const BINDABLE_ACTIONS: Readonly<
  Partial<Record<CatalogActionName, BindableKind>>
> = Object.freeze({
  "applications.list": "list",
  "applications.get": "application",
  "repositories.list": "list",
  "repositories.get": "repository",
  "tasks.list": "list",
  "tasks.get": "task",
  "tasks.create": "taskInput",
  "tasks.update": "task",
  "runs.create": "task",
  "runs.list": "task",
  "runs.get": "run",
  "runSteps.list": "run",
});

export function isBindingRole(value: unknown): value is BindingRole {
  return BINDING_ROLES.includes(value as BindingRole);
}

export function isBindingScopeType(value: unknown): value is BindingScopeType {
  return BINDING_SCOPE_TYPES.includes(value as BindingScopeType);
}

/** True when the binding's resource contains the target. */
export function bindingCovers(
  binding: ResourceBinding,
  target: BindingTarget,
): boolean {
  return binding.scopeType === "application"
    ? binding.scopeId === target.applicationId
    : target.repositoryId !== null && binding.scopeId === target.repositoryId;
}

/** True when the binding's role holds the permission. */
export function bindingAllows(
  binding: ResourceBinding,
  permission: CatalogPermissionKey,
): boolean {
  return roleHasPermission(binding.roleKey as SystemRole, permission);
}

/** Resources a list may return for these bindings and this permission. */
export function accessScopeFor(
  bindings: readonly ResourceBinding[],
  permission: CatalogPermissionKey,
): AccessScope | undefined {
  const allowed = bindings.filter((binding) =>
    bindingAllows(binding, permission)
  );
  if (allowed.length === 0) return undefined;
  const ids = (type: BindingScopeType) => [
    ...new Set(
      allowed.filter((binding) => binding.scopeType === type).map((binding) =>
        binding.scopeId
      ),
    ),
  ];
  return {
    applicationIds: ids("application"),
    repositoryIds: ids("repository"),
  };
}

/**
 * SQL for "only what the bindings reach": a column is matched against the
 * application ids and/or repository ids, with placeholders starting at
 * `firstParam`. A null column drops that side, so an application list does not
 * expose the parent of a repository-only binding.
 */
export function accessScopeClause(
  scope: AccessScope,
  columns: Readonly<{ application: string | null; repository: string | null }>,
  firstParam: number,
): { sql: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  if (columns.application !== null) {
    values.push([...scope.applicationIds]);
    parts.push(
      `${columns.application} = any($${
        firstParam + values.length - 1
      }::uuid[])`,
    );
  }
  if (columns.repository !== null) {
    values.push([...scope.repositoryIds]);
    parts.push(
      `${columns.repository} = any($${firstParam + values.length - 1}::uuid[])`,
    );
  }
  return { sql: `(${parts.join(" or ")})`, values };
}
