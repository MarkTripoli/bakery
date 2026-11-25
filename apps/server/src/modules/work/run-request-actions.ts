import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  RunRequestImplementedAction,
  runRequestImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { requireHumanMember } from "../auth/transport/http/v1/handlers.ts";
import {
  createRunRequest,
  listRunAccess,
  listRunRequests,
  myRunRequests,
  removeRunAccess,
  withdrawRunRequest,
} from "./run-requests.ts";

/**
 * Requests on a run. Making, listing and withdrawing need Developer access (the
 * asker must be able to see and share the run); `mine` is the asked person's
 * own view and needs only a live human membership, because a person asked may
 * hold nothing but the right to see this one run.
 */
export function createRunRequestActionRegistry(
  database: PgDatabase,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const organizationContext =
    OrganizationContextPolicy.RequiredAuthenticatedContext;
  const read = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext,
  } as const;
  const write = { ...read, type: ActionKind.Command } as const;
  const mine = {
    type: ActionKind.Query,
    access: ActionAccess.CurrentMember,
    organizationContext,
    authorize: requireHumanMember,
  } as const;

  registry.register({
    name: RunRequestImplementedAction.RunRequestsCreate,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/requests",
    input: contractSchemas.RunRequestCreate,
    output: contractSchemas.RunRequest,
    policy: write,
    successStatus: 201,
    handler: (context, input) => createRunRequest(context, input),
  }).register({
    // Registered before the generic `:id` list so the literal segment wins.
    name: RunRequestImplementedAction.RunRequestsMine,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/requests/mine",
    input: contractSchemas.Empty,
    output: contractSchemas.RunRequests,
    policy: mine,
    handler: (context) => myRunRequests(context),
  }).register({
    name: RunRequestImplementedAction.RunRequestsList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/requests",
    input: contractSchemas.Empty,
    output: contractSchemas.RunRequests,
    policy: read,
    handler: (context) => listRunRequests(context),
  }).register({
    name: RunRequestImplementedAction.RunAccessList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/access",
    input: contractSchemas.Empty,
    output: contractSchemas.RunAccessList,
    policy: read,
    handler: (context) => listRunAccess(context),
  }).register({
    name: RunRequestImplementedAction.RunAccessRemove,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/access/:principalId/remove",
    input: contractSchemas.Empty,
    output: contractSchemas.RunAccessRemoval,
    policy: write,
    successStatus: 200,
    explicitIdempotency: "key-and-if-match",
    handler: (context) => removeRunAccess(context),
  }).register({
    name: RunRequestImplementedAction.RunRequestsWithdraw,
    method: HttpMethod.Post,
    path: "/v1/run-requests/:id/withdraw",
    input: contractSchemas.Empty,
    output: contractSchemas.RunRequest,
    policy: write,
    successStatus: 200,
    explicitIdempotency: "key-and-if-match",
    handler: (context) => withdrawRunRequest(context),
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, runRequestImplementedActions);
  return registry;
}
