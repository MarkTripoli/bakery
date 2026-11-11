import type { PgTransactionClient } from "../../../platform/database.ts";
import {
  type BindableKind,
  type BindingTarget,
  isBindingRole,
  isBindingScopeType,
  type ResourceBinding,
} from "../application/bindings.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live bindings the principal holds in the organization. */
export async function loadResourceBindings(
  client: PgTransactionClient,
  principalId: string,
  organizationId: string,
): Promise<ResourceBinding[]> {
  const result = await client.query<
    {
      roleKey: string;
      scopeType: string;
      applicationId: string | null;
      repositoryId: string | null;
    }
  >(
    `select role_key as "roleKey", scope_type as "scopeType",
      application_id as "applicationId", repository_id as "repositoryId"
    from bakery.access_bindings
    where organization_id = $1 and principal_id = $2`,
    [organizationId, principalId],
  );
  const bindings: ResourceBinding[] = [];
  for (const row of result.rows) {
    const scopeId = row.scopeType === "application"
      ? row.applicationId
      : row.repositoryId;
    if (
      !isBindingRole(row.roleKey) || !isBindingScopeType(row.scopeType) ||
      scopeId === null
    ) continue;
    bindings.push({
      roleKey: row.roleKey,
      scopeType: row.scopeType,
      scopeId,
    });
  }
  return bindings;
}

/**
 * The application and repository a request touches, or undefined when the
 * resource does not exist in the organization (or the id is malformed).
 */
export async function resolveBindingTarget(
  client: PgTransactionClient,
  organizationId: string,
  kind: BindableKind,
  source: Readonly<{ id?: string; input: unknown }>,
): Promise<BindingTarget | undefined> {
  const one = async (sql: string, id: string | undefined) => {
    if (id === undefined || !UUID.test(id)) return undefined;
    const result = await client.query<
      { applicationId: string; repositoryId: string | null }
    >(sql, [organizationId, id]);
    return result.rows[0];
  };
  switch (kind) {
    case "application":
      return await one(
        `select id as "applicationId", null::uuid as "repositoryId"
        from bakery.applications where organization_id = $1 and id = $2`,
        source.id,
      );
    case "repository":
      return await one(
        `select application_id as "applicationId", id as "repositoryId"
        from bakery.repositories where organization_id = $1 and id = $2`,
        source.id,
      );
    case "task":
      return await one(
        `select application_id as "applicationId",
          repository_id as "repositoryId"
        from bakery.tasks where organization_id = $1 and id = $2`,
        source.id,
      );
    case "run":
      return await one(
        `select task.application_id as "applicationId",
          task.repository_id as "repositoryId"
        from bakery.workflow_runs as run
        join bakery.tasks as task
          on task.organization_id = run.organization_id
          and task.id = run.task_id
        where run.organization_id = $1 and run.id = $2`,
        source.id,
      );
    case "taskInput": {
      const input = source.input as {
        applicationId?: string;
        repositoryId?: string | null;
      };
      if (
        input.applicationId === undefined || !UUID.test(input.applicationId)
      ) return undefined;
      if (input.repositoryId === undefined || input.repositoryId === null) {
        return await one(
          `select id as "applicationId", null::uuid as "repositoryId"
          from bakery.applications where organization_id = $1 and id = $2`,
          input.applicationId,
        );
      }
      // The pair must agree, or a repository binding could file a task
      // under an application it does not belong to.
      const repository = await one(
        `select application_id as "applicationId", id as "repositoryId"
        from bakery.repositories where organization_id = $1 and id = $2`,
        input.repositoryId,
      );
      return repository?.applicationId === input.applicationId
        ? repository
        : undefined;
    }
    case "list":
      return undefined;
  }
}
