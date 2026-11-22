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
  createTicketSourceLabelsHandler,
  lookupTicketSourcePerson,
  readsProvider,
  type TicketOperationDependencies,
} from "./ticket-operation-runner.ts";
import {
  authorizeTicketAdmission,
  cancelTicketRequest,
  createTicketReadinessHandler,
  createTicketRequestHandler,
  createTicketTaskLink,
} from "./ticket-request-command.ts";
import {
  createExternalTicketsListHandler,
  createTicketSourcesListHandler,
  createTicketTaskLinksListHandler,
  getExternalTicket,
  getTicketSource,
} from "./ticket-query.ts";
import {
  createTicketRequestsListHandler,
  getTicketRequest,
} from "./ticket-request-query.ts";
import {
  authorizeRemoteTicketCreate,
  createRemoteTicketRunner,
  recordRemoteTicketCreate,
  type RemoteTicketCreator,
  UNAVAILABLE_TICKET_CREATOR,
} from "./ticket-create.ts";
import {
  createTicketNoteRunner,
  recordTicketNoteSync,
  type TicketNoteWriter,
  UNAVAILABLE_NOTE_WRITER,
} from "./ticket-notes.ts";
import {
  createTicketSource,
  createTicketSourcePreviewHandler,
  createTicketSourceSyncHandler,
  getTicketRoutingRules,
  replaceTicketRoutingRules,
  updateTicketSource,
} from "./ticket-source-command.ts";

export type TicketActionDependencies = TicketOperationDependencies & {
  /** Signs list cursors. */
  cursorSecret: string;
  /** Posts Bakery's status note on a ticket (#69); none wired refuses every write as failed. */
  noteWriter?: TicketNoteWriter;
  /** Creates a ticket in the tracker (#32); none wired answers every creation as unavailable. */
  ticketCreator?: RemoteTicketCreator;
};

/**
 * Ticket operations. The four that read GitHub run through the probe, read,
 * execute wrapper, and the status note resync through claim, write, record,
 * so no registry transaction is open during a provider call, and so does
 * remote ticket creation (claim, send, answer); the rest go straight to the
 * authority runner.
 */
export function createTicketActionRegistry(
  database: PgDatabase,
  dependencies: TicketActionDependencies,
): ActionRegistry {
  const base = new PostgresAuthorityRunner(database);
  const reading = createTicketOperationRunner(base, dependencies);
  const noting = createTicketNoteRunner(
    base,
    dependencies.noteWriter ?? UNAVAILABLE_NOTE_WRITER,
  );
  const creator = dependencies.ticketCreator ?? UNAVAILABLE_TICKET_CREATOR;
  const creating = createRemoteTicketRunner(base, creator);
  const authority: ActionAuthorityRunner = {
    run: (action, context, input, next) =>
      readsProvider(action.name)
        ? reading(action, context, input, next)
        : action.name === TicketImplementedAction.TicketTaskLinksResyncNote
        ? noting(action, context, input, next)
        : action.name === TicketImplementedAction.ExternalTicketsCreate
        ? creating(action, context, input, next)
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
    name: TicketImplementedAction.ExternalTicketsCreate,
    method: HttpMethod.Post,
    path: "/v1/ticket-sources/:id/tickets",
    input: contractSchemas.RemoteTicketCreate,
    output: contractSchemas.IntegrationActionReceipt,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.DeveloperAndExactExternalActionGrant,
      organizationContext,
      authorize: authorizeRemoteTicketCreate(creator),
    },
    // The effect is written to the ledger and may not have reached the
    // provider: the receipt is 202 and never claims the issue exists.
    explicitIdempotency: "key",
    successStatus: 202,
    handler: recordRemoteTicketCreate,
  }).register({
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
    output: contractSchemas.TicketPreviewResult,
    policy: admin,
    handler: createTicketSourcePreviewHandler(dependencies),
  }).register({
    name: TicketImplementedAction.TicketSourcesLookupPerson,
    method: HttpMethod.Get,
    path: "/v1/ticket-sources/:id/people/:login",
    input: contractSchemas.TicketSourcePersonPath,
    output: contractSchemas.TicketSourcePerson,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Admin,
      organizationContext,
    },
    handler: lookupTicketSourcePerson,
  }).register({
    name: TicketImplementedAction.TicketSourcesLabels,
    method: HttpMethod.Get,
    path: "/v1/ticket-sources/:id/labels",
    input: contractSchemas.TicketSourceLabelQuery,
    output: contractSchemas["Page<TicketSourceLabel>"],
    policy: query,
    handler: createTicketSourceLabelsHandler(dependencies.cursorSecret),
  }).register({
    name: TicketImplementedAction.TicketSourcesSync,
    method: HttpMethod.Post,
    path: "/v1/ticket-sources/:id/syncs",
    input: contractSchemas.TicketSyncCreate,
    output: contractSchemas.TicketOperationReceipt,
    policy: admin,
    handler: createTicketSourceSyncHandler(dependencies),
  }).register({
    name: TicketImplementedAction.TicketRoutingRulesGet,
    method: HttpMethod.Get,
    path: "/v1/ticket-sources/:id/routing-rules",
    input: contractSchemas.IdPath,
    output: contractSchemas.TicketRoutingRuleSet,
    policy: query,
    handler: getTicketRoutingRules,
  }).register({
    name: TicketImplementedAction.TicketRoutingRulesReplace,
    method: HttpMethod.Put,
    path: "/v1/ticket-sources/:id/routing-rules",
    input: contractSchemas.TicketRoutingRulesReplace,
    output: contractSchemas.TicketRoutingRuleSet,
    policy: admin,
    // A whole-set replace: the source version is always the precondition.
    explicitIdempotency: "key-and-if-match",
    handler: replaceTicketRoutingRules,
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
    name: TicketImplementedAction.TicketTaskLinksList,
    method: HttpMethod.Get,
    path: "/v1/ticket-task-links",
    input: contractSchemas.TicketTaskLinkQuery,
    output: contractSchemas["Page<TicketTaskLink>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createTicketTaskLinksListHandler(dependencies.cursorSecret),
  }).register({
    name: TicketImplementedAction.TicketTaskLinksResyncNote,
    method: HttpMethod.Post,
    path: "/v1/ticket-task-links/:id/note-syncs",
    input: contractSchemas.TicketTaskLinkNoteSync,
    output: contractSchemas.TicketTaskLink,
    policy: developer,
    // The link version is the precondition; the claim checks it.
    explicitIdempotency: "key-and-if-match",
    handler: recordTicketNoteSync,
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
  }).register({
    name: TicketImplementedAction.TicketRequestsList,
    method: HttpMethod.Get,
    path: "/v1/ticket-requests",
    input: contractSchemas.TicketRequestQuery,
    output: contractSchemas["Page<TicketRequestView>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createTicketRequestsListHandler(dependencies.cursorSecret),
  }).register({
    name: TicketImplementedAction.TicketRequestsGet,
    method: HttpMethod.Get,
    path: "/v1/ticket-requests/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.TicketRequestView,
    policy: query,
    handler: getTicketRequest,
  }).register({
    name: TicketImplementedAction.TicketRequestsCancel,
    method: HttpMethod.Post,
    path: "/v1/ticket-requests/:id/cancellations",
    input: contractSchemas.TicketRequestCancel,
    output: contractSchemas.TicketRequestView,
    // Stopping work is held to starting it: task:write and run:write now.
    policy: {
      ...developer,
      access: ActionAccess.DeveloperAndAdmissionAuthority,
      authorize: authorizeTicketAdmission,
    },
    // The request version is the precondition; the handler checks it.
    explicitIdempotency: "key-and-if-match",
    handler: cancelTicketRequest,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, ticketImplementedActions);
  return registry;
}
