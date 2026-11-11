import {
  contractSchemas,
  workerActionCapabilities,
} from "@bakery/contracts/contracts";
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

function isDispatchable(action: WorkflowActionName): boolean {
  try {
    workerActionCapabilities(action);
    return true;
  } catch {
    return false;
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
  if (action === WorkflowRuntimeImplementedAction.Plan) {
    return unavailableHandler(schemas, action);
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
