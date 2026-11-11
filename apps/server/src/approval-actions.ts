import type { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type CommandRunner,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ApprovalImplementedAction as Action,
  approvalImplementedActions,
  assertImplementedActionRegistry,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";

type Out<K extends keyof typeof contractSchemas> = z.output<
  typeof contractSchemas[K]
>;
type Handler<I, O> = (context: ActionContext, input: I) => O | Promise<O>;

export type ApprovalActionHandlers = {
  planRevisionsList: Handler<
    Out<"PlanRevisionQuery">,
    Out<"Page<PlanRevision>">
  >;
  planRevisionsGet: Handler<Out<"IdPath">, Out<"PlanRevision">>;
  approvalsList: Handler<Out<"ApprovalQuery">, Out<"Page<Approval>">>;
  approvalsGet: Handler<Out<"IdPath">, Out<"Approval">>;
  approvalsDecide: Handler<Out<"ApprovalDecision">, Out<"Approval">>;
  approvalsRevoke: Handler<Out<"ApprovalRevoke">, Out<"Approval">>;
};

/** Plan revision and approval routes, registered one by one. */
export function createApprovalActionRegistry(
  handlers: ApprovalActionHandlers,
  options: {
    authorityRunner: ActionAuthorityRunner;
    commandRunner: CommandRunner;
  },
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  const query = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const command = { ...query, type: ActionKind.Command } as const;
  registry.register({
    name: Action.PlanRevisionsList,
    method: HttpMethod.Get,
    path: "/v1/plan-revisions",
    input: contractSchemas.PlanRevisionQuery,
    output: contractSchemas["Page<PlanRevision>"],
    policy: query,
    handler: handlers.planRevisionsList,
  });
  registry.register({
    name: Action.PlanRevisionsGet,
    method: HttpMethod.Get,
    path: "/v1/plan-revisions/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.PlanRevision,
    policy: query,
    handler: handlers.planRevisionsGet,
  });
  registry.register({
    name: Action.ApprovalsList,
    method: HttpMethod.Get,
    path: "/v1/approvals",
    input: contractSchemas.ApprovalQuery,
    output: contractSchemas["Page<Approval>"],
    policy: query,
    handler: handlers.approvalsList,
  });
  registry.register({
    name: Action.ApprovalsGet,
    method: HttpMethod.Get,
    path: "/v1/approvals/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Approval,
    policy: query,
    handler: handlers.approvalsGet,
  });
  registry.register({
    name: Action.ApprovalsDecide,
    method: HttpMethod.Post,
    path: "/v1/approvals/:id/decision",
    input: contractSchemas.ApprovalDecision,
    output: contractSchemas.Approval,
    policy: command,
    successStatus: 200,
    handler: handlers.approvalsDecide,
  });
  registry.register({
    name: Action.ApprovalsRevoke,
    method: HttpMethod.Post,
    path: "/v1/approvals/:id/revoke",
    input: contractSchemas.ApprovalRevoke,
    output: contractSchemas.Approval,
    policy: command,
    successStatus: 200,
    handler: handlers.approvalsRevoke,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, approvalImplementedActions);
  return registry;
}
