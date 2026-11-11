import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import { resolveRepositoryBinding } from "./binding.ts";
import { getEffectiveRepositoryRules } from "../repository-rules/effective.ts";
import { previewRepositoryRuleOverrides } from "../repository-rules/previews.ts";
import {
  createRepositoryRoleBinding,
  listRepositoryRoleBindings,
  updateRepositoryRoleBinding,
} from "./roles.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  getRepositoryObservation,
  getRepositoryOnboarding,
  onboardRepository,
} from "./onboarding.ts";

export { assertNextRevision, profileDigest } from "./postgres.ts";
export {
  createProjectsActionRegistry,
  type ProjectsActionHandlers,
} from "./actions.ts";
export { projectsBakeryMigrationSource } from "./migrations.ts";
export { resolveExecutableBinding } from "./binding.ts";

import {
  createApplication,
  createApplicationsListHandler,
  createProfile,
  createProfilesListHandler,
  createRepositoriesListHandler,
  createRepository,
  getApplication,
  getRepository,
  updateApplication,
  updateRepository,
} from "./postgres.ts";
import type { ProjectsActionHandlers } from "./actions.ts";

function requireScopedApplicationId(context: ActionContext): string {
  const applicationId = context.params.applicationId;
  if (!applicationId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return applicationId;
}

function assertApplicationInputScope(
  pathApplicationId: string,
  inputApplicationId: string,
): void {
  if (pathApplicationId !== inputApplicationId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

function createRolesListHandler(secret: string) {
  return function listRoles(
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryRoleList>,
  ): Promise<z.output<typeof contractSchemas["Page<RoleBinding>"]>> {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const applicationId = requireScopedApplicationId(context);
    assertApplicationInputScope(applicationId, input.applicationId);
    return listRepositoryRoleBindings(
      transaction,
      organizationId,
      applicationId,
      secret,
      principalId,
      {
        cursor: input.cursor,
        limit: input.limit,
      },
    );
  };
}

function createRole(
  context: ActionContext,
  input: z.output<typeof contractSchemas.RoleBindingCreate>,
): Promise<z.output<typeof contractSchemas.RoleBinding>> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const applicationId = requireScopedApplicationId(context);
  assertApplicationInputScope(applicationId, input.applicationId);
  return createRepositoryRoleBinding(
    transaction,
    organizationId,
    applicationId,
    {
      repositoryId: input.repositoryId,
      role: input.role,
      alias: input.alias,
      provenance: input.provenance,
    },
  );
}

function updateRole(
  context: ActionContext,
  input: z.output<typeof contractSchemas.RoleBindingUpdate>,
): Promise<z.output<typeof contractSchemas.RoleBinding>> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const metadata = requireCommandMetadata(context);
  const expectedVersion = metadata.expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (expectedVersion !== input.expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const applicationId = requireScopedApplicationId(context);
  const roleId = context.params.roleId;
  if (!roleId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return updateRepositoryRoleBinding(
    transaction,
    organizationId,
    applicationId,
    roleId,
    input.expectedVersion,
    {
      repositoryId: input.repositoryId,
      role: input.role,
      alias: input.alias,
      provenance: input.provenance,
      archivedAt: input.archivedAt,
    },
  );
}

async function resolveRole(
  context: ActionContext,
  input: z.output<typeof contractSchemas.RepositoryBindingSelector>,
): Promise<z.output<typeof contractSchemas.RepositoryBindingResolution>> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const applicationId = requireScopedApplicationId(context);
  const resolution = await resolveRepositoryBinding(
    transaction,
    organizationId,
    applicationId,
    input,
  );
  if (
    resolution.status === "foreign" ||
    (resolution.status === "unavailable" &&
      resolution.reason === "repository_not_found")
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return resolution;
}

export function createProjectsHandlers(secret: string): ProjectsActionHandlers {
  return {
    listApplications: createApplicationsListHandler(secret),
    getApplication,
    createApplication,
    updateApplication,
    listRepositories: createRepositoriesListHandler(secret),
    getRepository,
    createRepository,
    updateRepository,
    listProfiles: createProfilesListHandler(secret),
    createProfile,
    getEffectiveRules: getEffectiveRepositoryRules,
    previewRepositoryRules: previewRepositoryRuleOverrides,
    onboardRepository,
    getRepositoryOnboarding,
    getRepositoryObservation,
    listRoles: createRolesListHandler(secret),
    createRole,
    updateRole,
    resolveRole,
  };
}
