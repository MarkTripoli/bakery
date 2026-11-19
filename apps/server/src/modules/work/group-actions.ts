import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  GroupImplementedAction,
  groupImplementedActions,
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
import { createGroup, deleteGroup, listGroups, updateGroup } from "./groups.ts";

/**
 * Organization groups. Any live human member reads them (a request has to be
 * addressable by name); only an organization Admin creates, changes or deletes
 * one. Groups are an audience, never a grant, so no action here widens anyone's
 * access.
 */
export function createGroupActionRegistry(
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
    access: ActionAccess.CurrentMember,
    organizationContext,
    authorize: requireHumanMember,
  } as const;
  const write = {
    type: ActionKind.Command,
    access: ActionAccess.Admin,
    organizationContext,
  } as const;

  registry.register({
    name: GroupImplementedAction.GroupsList,
    method: HttpMethod.Get,
    path: "/v1/groups",
    input: contractSchemas.Empty,
    output: contractSchemas.Groups,
    policy: read,
    handler: (context) => listGroups(context),
  }).register({
    name: GroupImplementedAction.GroupsCreate,
    method: HttpMethod.Post,
    path: "/v1/groups",
    input: contractSchemas.GroupCreate,
    output: contractSchemas.Group,
    policy: write,
    successStatus: 201,
    handler: (context, input) => createGroup(context, input),
  }).register({
    name: GroupImplementedAction.GroupsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/groups/:id",
    input: contractSchemas.GroupUpdate,
    output: contractSchemas.Group,
    policy: write,
    explicitIdempotency: "key-and-if-match",
    handler: (context, input) => updateGroup(context, input),
  }).register({
    name: GroupImplementedAction.GroupsDelete,
    method: HttpMethod.Delete,
    path: "/v1/groups/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: write,
    explicitIdempotency: "key-and-if-match",
    handler: (context) => deleteGroup(context),
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, groupImplementedActions);
  return registry;
}
