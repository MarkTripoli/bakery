import {
  type ActionAuthorityRunner,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  TicketImplementedAction,
  ticketImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import {
  createTicketOperationRunner,
  readsProvider,
  type TicketOperationDependencies,
} from "./ticket-operation-runner.ts";
import {
  authorizeTicketAdmission,
  createTicketReadinessHandler,
  createTicketRequestHandler,
  createTicketTaskLink,
} from "./ticket-request-command.ts";
import {
  createExternalTicketsListHandler,
  createTicketSourcesListHandler,
  getExternalTicket,
  getTicketSource,
} from "./ticket-query.ts";
import {
  createTicketSource,
  createTicketSourcePreviewHandler,
  createTicketSourceSyncHandler,
  updateTicketSource,
} from "./ticket-source-command.ts";

export type TicketActionDependencies = TicketOperationDependencies & {
  /** Signs list cursors. */
  cursorSecret: string;
};

/**
 * Ticket operations. The four that read GitHub run through the probe, read,
 * execute wrapper, so no registry transaction is open during a provider call;
 * the rest go straight to the authority runner. Remote ticket creation
 * (`externalTickets.create`) is not registered.
 */
export function createTicketActionRegistry(
  database: PgDatabase,
  dependencies: TicketActionDependencies,
): ActionRegistry {
  const base = new PostgresAuthorityRunner(database);
  const reading = createTicketOperationRunner(base, dependencies);
  const authority: ActionAuthorityRunner = {
    run: (action, context, input, next) =>
      readsProvider(action.name)
        ? reading(action, context, input, next)
        : base.run(action, context, input, next),
  };
  const registry = new ActionRegistry(authority, createPostgresCommandRunner());
  const organizationContext =
    OrganizationContextPolicy.RequiredAuthenticatedContext;
  const query = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext,
  } as const;
  const admin = {
    type: ActionKind.Command,
    access: ActionAccess.Admin,
    organizationContext,
  } as const;
  const developer = {
    type: ActionKind.Command,
    access: ActionAccess.Developer,
    organizationContext,
  } as const;

  registry.register({
    name: TicketImplementedAction.TicketSourcesList,
    method: HttpMethod.Get,
    path: "/v1/ticket-sources",
    input: contractSchemas.TicketSourceQuery,
    output: contractSchemas["Page<TicketSource>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createTicketSourcesListHandler(dependencies.cursorSecret),
  }).register({
    name: TicketImplementedAction.TicketSourcesCreate,
    method: HttpMethod.Post,
    path: "/v1/ticket-sources",
    input: contractSchemas.TicketSourceCreate,
    output: contractSchemas.TicketSource,
    policy: admin,
    handler: createTicketSource,
  }).register({
    name: TicketImplementedAction.TicketSourcesGet,
    method: HttpMethod.Get,
    path: "/v1/ticket-sources/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.TicketSource,
    policy: query,
    handler: getTicketSource,
  }).register({
    name: TicketImplementedAction.TicketSourcesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/ticket-sources/:id",
    input: contractSchemas.TicketSourceUpdate,
    output: contractSchemas.TicketSource,
    policy: admin,
    handler: updateTicketSource,
  }).register({
    name: TicketImplementedAction.TicketSourcesPreview,
    method: HttpMethod.Post,
    path: "/v1/ticket-sources/:id/previews",
    input: contractSchemas.TicketPreviewCreate,
    output: contractSchemas.TicketOperationReceipt,
    policy: admin,
    handler: createTicketSourcePreviewHandler(dependencies),
  }).register({
    name: TicketImplementedAction.TicketSourcesSync,
    method: HttpMethod.Post,
    path: "/v1/ticket-sources/:id/syncs",
    input: contractSchemas.TicketSyncCreate,
    output: contractSchemas.TicketOperationReceipt,
    policy: admin,
    handler: createTicketSourceSyncHandler(dependencies),
  }).register({
    name: TicketImplementedAction.ExternalTicketsList,
    method: HttpMethod.Get,
    path: "/v1/external-tickets",
    input: contractSchemas.ExternalTicketQuery,
    output: contractSchemas["Page<ExternalTicket>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createExternalTicketsListHandler(dependencies.cursorSecret),
  }).register({
    name: TicketImplementedAction.ExternalTicketsGet,
    method: HttpMethod.Get,
    path: "/v1/external-tickets/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.ExternalTicket,
    policy: query,
    handler: getExternalTicket,
  }).register({
    name: TicketImplementedAction.TicketReadinessCreate,
    method: HttpMethod.Post,
    path: "/v1/external-tickets/:id/readiness-checks",
    input: contractSchemas.TicketReadinessCreate,
    output: contractSchemas.TicketOperationReceipt,
    policy: developer,
    handler: createTicketReadinessHandler(dependencies),
  }).register({
    name: TicketImplementedAction.TicketTaskLinksCreate,
    method: HttpMethod.Post,
    path: "/v1/external-tickets/:id/links",
    input: contractSchemas.TicketTaskLinkCreate,
    output: contractSchemas.TicketTaskLink,
    policy: developer,
    handler: createTicketTaskLink,
  }).register({
    name: TicketImplementedAction.TicketRequestsCreate,
    method: HttpMethod.Post,
    path: "/v1/external-tickets/:id/requests",
    input: contractSchemas.TicketRequestCreate,
    output: contractSchemas.TicketRequest,
    // The catalog permission is not enough: the caller needs both task:write
    // and run:write, because a request creates a task and may start a run.
    policy: {
      ...developer,
      access: ActionAccess.DeveloperAndAdmissionAuthority,
      authorize: authorizeTicketAdmission,
    },
    handler: createTicketRequestHandler(dependencies),
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, ticketImplementedActions);
  return registry;
}
