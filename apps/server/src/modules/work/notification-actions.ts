import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  NotificationImplementedAction,
  notificationImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { ActionAccess } from "@bakery/contracts/contracts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { requireHumanMember } from "../auth/transport/http/v1/handlers.ts";
import { createNotificationHandlers } from "./notification-handlers.ts";

/**
 * The recipient's own inbox. Every action is `CurrentMember`: a live human
 * member needs no role to read and manage their own notifications, and none of
 * these actions can name someone else's inbox. The handler derives the
 * recipient from the authorized transaction, not from the request.
 */
export function createNotificationActionRegistry(
  database: PgDatabase,
  secret: string,
): ActionRegistry {
  const authority = new PostgresAuthorityRunner(database);
  const registry = new ActionRegistry(
    authority,
    createPostgresCommandRunner(),
  );
  const handlers = createNotificationHandlers(secret);
  const organizationContext =
    OrganizationContextPolicy.RequiredAuthenticatedContext;
  // `CurrentMember` is not a base organization policy, so every action states
  // the guard that grants it: a live human member, reading or changing only the
  // inbox the authorized transaction resolves for them.
  const read = {
    type: ActionKind.Query,
    access: ActionAccess.CurrentMember,
    organizationContext,
    authorize: requireHumanMember,
  } as const;
  const write = {
    type: ActionKind.Command,
    access: ActionAccess.CurrentMember,
    organizationContext,
    authorize: requireHumanMember,
  } as const;

  registry.register({
    name: NotificationImplementedAction.NotificationsList,
    method: HttpMethod.Get,
    path: "/v1/notifications",
    input: contractSchemas.NotificationCursorQuery,
    output: contractSchemas["Page<Notification>"],
    policy: read,
    handler: handlers.list,
  }).register({
    name: NotificationImplementedAction.NotificationsCount,
    method: HttpMethod.Get,
    path: "/v1/notifications/count",
    input: contractSchemas.Empty,
    output: contractSchemas.NotificationCount,
    policy: read,
    handler: handlers.count,
  }).register({
    // Registered before the `:id` route so a literal segment is not captured as
    // an id; the router matches these in registration order.
    name: NotificationImplementedAction.NotificationsMarkAllRead,
    method: HttpMethod.Post,
    path: "/v1/notifications/read-all",
    input: contractSchemas.NotificationMarkAllRead,
    output: contractSchemas.NotificationMarkAllReadResult,
    explicitIdempotency: "key",
    policy: write,
    handler: handlers.markAllRead,
  }).register({
    name: NotificationImplementedAction.NotificationsUndoMarkAllRead,
    method: HttpMethod.Post,
    path: "/v1/notifications/read-all/undo",
    input: contractSchemas.NotificationUndoMarkAllRead,
    output: contractSchemas.NotificationUndoMarkAllReadResult,
    explicitIdempotency: "key",
    successStatus: 200,
    policy: write,
    handler: handlers.undoMarkAllRead,
  }).register({
    name: NotificationImplementedAction.NotificationsGet,
    method: HttpMethod.Get,
    path: "/v1/notifications/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Notification,
    policy: read,
    handler: handlers.get,
  }).register({
    name: NotificationImplementedAction.NotificationsResolveTarget,
    method: HttpMethod.Get,
    path: "/v1/notifications/:id/target",
    input: contractSchemas.IdPath,
    output: contractSchemas.NotificationTarget,
    policy: read,
    handler: handlers.resolveTarget,
  }).register({
    name: NotificationImplementedAction.NotificationsSetRead,
    method: HttpMethod.Patch,
    path: "/v1/notifications/:id",
    input: contractSchemas.NotificationReadUpdate,
    output: contractSchemas.Notification,
    explicitIdempotency: "key",
    policy: write,
    handler: handlers.setRead,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, notificationImplementedActions);
  return registry;
}
