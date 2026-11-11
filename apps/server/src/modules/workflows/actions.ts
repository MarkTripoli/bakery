import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  WorkflowImplementedAction,
  workflowImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";

export type WorkflowsActionHandlers = {
  listWorkflows: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<Workflow>"]>>;
  getWorkflow: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.Workflow>>;
  createWorkflow: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.NamedDefinitionCreate>,
  ) => Promise<z.output<typeof contractSchemas.Workflow>>;
  updateWorkflow: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.DefinitionUpdate>,
  ) => Promise<z.output<typeof contractSchemas.Workflow>>;
  listVersions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<WorkflowVersion>"]>>;
  getVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.WorkflowVersionPath>,
  ) => Promise<z.output<typeof contractSchemas.WorkflowVersion>>;
  createVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.WorkflowVersionCreate>,
  ) => Promise<z.output<typeof contractSchemas.WorkflowVersion>>;
  updateVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.WorkflowDraftUpdate>,
  ) => Promise<z.output<typeof contractSchemas.WorkflowVersion>>;
  publishVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.WorkflowVersionPublish>,
  ) => Promise<z.output<typeof contractSchemas.WorkflowVersion>>;
  activate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.WorkflowActivationCreate>,
  ) => Promise<z.output<typeof contractSchemas.Workflow>>;
  validate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.WorkflowValidation>,
  ) => Promise<z.output<typeof contractSchemas.ValidationReport>>;
};

export function createWorkflowsActionRegistry(
  database: PgDatabase,
  handlers: WorkflowsActionHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const queryPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const commandPolicy = {
    ...queryPolicy,
    type: ActionKind.Command,
    access: ActionAccess.Admin,
  } as const;
  // Validation is a POST with an Idempotency-Key but only needs Developer
  // access.
  const validatePolicy = {
    ...queryPolicy,
    type: ActionKind.Command,
  } as const;

  registry.register({
    name: WorkflowImplementedAction.WorkflowsList,
    method: HttpMethod.Get,
    path: "/v1/workflows",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Workflow>"],
    policy: queryPolicy,
    handler: handlers.listWorkflows,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowsGet,
    method: HttpMethod.Get,
    path: "/v1/workflows/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Workflow,
    policy: queryPolicy,
    handler: handlers.getWorkflow,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowsCreate,
    method: HttpMethod.Post,
    path: "/v1/workflows",
    input: contractSchemas.NamedDefinitionCreate,
    output: contractSchemas.Workflow,
    policy: commandPolicy,
    handler: handlers.createWorkflow,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/workflows/:id",
    input: contractSchemas.DefinitionUpdate,
    output: contractSchemas.Workflow,
    policy: commandPolicy,
    handler: handlers.updateWorkflow,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowVersionsList,
    method: HttpMethod.Get,
    path: "/v1/workflows/:id/versions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<WorkflowVersion>"],
    policy: queryPolicy,
    handler: handlers.listVersions,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowVersionsGet,
    method: HttpMethod.Get,
    path: "/v1/workflows/:id/versions/:versionId",
    input: contractSchemas.WorkflowVersionPath,
    output: contractSchemas.WorkflowVersion,
    policy: queryPolicy,
    handler: handlers.getVersion,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowVersionsCreate,
    method: HttpMethod.Post,
    path: "/v1/workflows/:id/versions",
    input: contractSchemas.WorkflowVersionCreate,
    output: contractSchemas.WorkflowVersion,
    policy: commandPolicy,
    handler: handlers.createVersion,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowVersionsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/workflows/:id/versions/:versionId",
    input: contractSchemas.WorkflowDraftUpdate,
    output: contractSchemas.WorkflowVersion,
    policy: commandPolicy,
    handler: handlers.updateVersion,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowVersionsPublish,
    method: HttpMethod.Post,
    path: "/v1/workflows/:id/versions/:versionId/publish",
    input: contractSchemas.WorkflowVersionPublish,
    output: contractSchemas.WorkflowVersion,
    policy: commandPolicy,
    explicitIdempotency: "key-and-if-match",
    successStatus: 200,
    handler: handlers.publishVersion,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowActivationsCreate,
    method: HttpMethod.Post,
    path: "/v1/workflows/:id/activations",
    input: contractSchemas.WorkflowActivationCreate,
    output: contractSchemas.Workflow,
    policy: commandPolicy,
    explicitIdempotency: "key-and-if-match",
    successStatus: 200,
    handler: handlers.activate,
  });
  registry.register({
    name: WorkflowImplementedAction.WorkflowsValidate,
    method: HttpMethod.Post,
    path: "/v1/workflow-validations",
    input: contractSchemas.WorkflowValidation,
    output: contractSchemas.ValidationReport,
    policy: validatePolicy,
    successStatus: 200,
    handler: handlers.validate,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, workflowImplementedActions);
  return registry;
}
