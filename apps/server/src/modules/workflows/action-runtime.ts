import {
  contractSchemas,
  UnknownWorkerActionError,
  workerActionCapabilities,
} from "@bakery/contracts/contracts";
import { normalizeWorkflowStop } from "@bakery/contracts/human-approval";
import { StandardError } from "@bakery/contracts/http";
import {
  assertDispatchableWorkflowActionsRegistered,
  assertImplementedWorkflowActionRegistry,
  assertWorkflowActionSchemasResolve,
  WorkflowRuntimeImplementedAction,
  workflowRuntimeImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_REGISTRY_VERSION,
  type WorkflowActionHandler,
  type WorkflowActionName,
  WorkflowActionRegistry,
} from "@bakery/contracts/workflow-action-registry";
import { assertActionInput } from "@bakery/persistence";

type SchemaMap = Readonly<Record<string, unknown>>;

type Parser = { parse(value: unknown): unknown };

/** Admission-only result of a worker-dispatched handler; no work runs here. */
export type WorkflowActionDispatchRequest = Readonly<{
  dispatch: "worker_job";
  action: WorkflowActionName;
  version: typeof WORKFLOW_ACTION_REGISTRY_VERSION;
  input: unknown;
}>;

function parser(schemas: SchemaMap, name: string): Parser {
  const schema = schemas[name] as Parser | undefined;
  if (!schema || typeof schema.parse !== "function") {
    throw new Error(`workflow action schema does not resolve: ${name}`);
  }
  return schema;
}

/**
 * Whether a worker runs this action. Only an action nobody registered answers
 * false; a broken entry in Bakery's own table is thrown, because treating a
 * contract defect as "not dispatchable" would silently route the step elsewhere
 * instead of failing where the defect is (issue 244).
 */
export function isDispatchable(action: WorkflowActionName): boolean {
  try {
    workerActionCapabilities(action);
    return true;
  } catch (error) {
    if (error instanceof UnknownWorkerActionError) return false;
    throw error;
  }
}

/**
 * Worker-dispatched handlers only admit: they validate input against the
 * registered schema and return a job dispatch request. The worker produces the
 * declared output; `execution/results.ts:415-418` validates it with
 * `workerActionOutputSchema(action)`, which `assertWorkflowWorkerContract`
 * (`workflow-action-registry.ts:348-370`) pins to the same schema name as
 * `outputSchema` here.
 */
function workerDispatchHandler(
  schemas: SchemaMap,
  action: WorkflowActionName,
): WorkflowActionHandler {
  const { input } = WORKFLOW_ACTION_METADATA[action];
  return (value) => {
    parser(schemas, input).parse(value);
    assertActionInput(action, value);
    return Object.freeze<WorkflowActionDispatchRequest>({
      dispatch: "worker_job",
      action,
      version: WORKFLOW_ACTION_REGISTRY_VERSION,
      input: value,
    });
  };
}

/** `rpi.plan` is declared but has no worker contract, so it cannot run. */
function unavailableHandler(
  schemas: SchemaMap,
  action: WorkflowActionName,
): WorkflowActionHandler {
  const { input } = WORKFLOW_ACTION_METADATA[action];
  return (value) => {
    parser(schemas, input).parse(value);
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_action_unavailable" },
    });
  };
}

function handlerFor(
  schemas: SchemaMap,
  action: WorkflowActionName,
): WorkflowActionHandler {
  if (action === WorkflowRuntimeImplementedAction.Noop) {
    const metadata = WORKFLOW_ACTION_METADATA[action];
    return (input) => {
      parser(schemas, metadata.input).parse(input);
      return parser(schemas, metadata.output).parse({});
    };
  }
  if (action === WorkflowRuntimeImplementedAction.Stop) {
    const metadata = WORKFLOW_ACTION_METADATA[action];
    return (value) => {
      const input = parser(schemas, metadata.input).parse(value);
      // A stop names its outcome and does not run code: the run ends on the
      // named outcome, which is what a caller or a later step branches on.
      return parser(schemas, metadata.output).parse(normalizeWorkflowStop(
        input as { outcome: string; reason?: string },
      ));
    };
  }
  if (action === WorkflowRuntimeImplementedAction.HumanApproval) {
    // The approval step waits: an answer completes it, so the handler validates
    // the input and reports the wait rather than producing a decision. Asking
    // for a decision here would let the step approve itself.
    const metadata = WORKFLOW_ACTION_METADATA[action];
    return (value) => {
      parser(schemas, metadata.input).parse(value);
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_approval_awaits_decision" },
      });
    };
  }
  if (action === WorkflowRuntimeImplementedAction.Plan) {
    return unavailableHandler(schemas, action);
  }
  if (
    action === WorkflowRuntimeImplementedAction.DeliveryPrepare ||
    action === WorkflowRuntimeImplementedAction.DeliveryDeploy ||
    action === WorkflowRuntimeImplementedAction.DeliveryHealth
  ) {
    // A delivery step calls a deployment target over time, so the engine
    // settles it in its admission (workflow-adapter, delivery steps) and this
    // handler only validates: running it here would deploy with no record.
    const { input } = WORKFLOW_ACTION_METADATA[action];
    return (value) => {
      parser(schemas, input).parse(value);
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "workflow_delivery_step_settled_by_engine" },
      });
    };
  }
  return workerDispatchHandler(schemas, action);
}

/** Builds the server workflow action registry; any drift fails at startup. */
export function createWorkflowActionRuntime(
  schemas: SchemaMap = contractSchemas as unknown as SchemaMap,
): WorkflowActionRegistry {
  const registry = new WorkflowActionRegistry();
  for (const action of workflowRuntimeImplementedActions) {
    const metadata = WORKFLOW_ACTION_METADATA[action];
    registry.register({
      action,
      version: WORKFLOW_ACTION_REGISTRY_VERSION,
      metadata,
      handler: {
        action,
        version: WORKFLOW_ACTION_REGISTRY_VERSION,
        inputSchema: metadata.input,
        outputSchema: metadata.output,
        handle: handlerFor(schemas, action),
      },
    });
  }
  assertWorkflowActionSchemasResolve(registry, schemas);
  assertImplementedWorkflowActionRegistry(
    registry,
    workflowRuntimeImplementedActions,
  );
  assertDispatchableWorkflowActionsRegistered(registry, isDispatchable);
  return registry;
}
