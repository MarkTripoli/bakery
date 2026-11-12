import transport from "../../generated/transport-schemas.ts";
import { contractSchemas, toJsonSchema } from "../contracts.ts";
import {
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionName,
} from "../workflow-action-registry.ts";
import {
  createWorkflowCompilerCatalog,
  type WorkflowCatalogEvent,
  type WorkflowCompilerCatalog,
  type WorkflowLimitField,
} from "./catalog.ts";

type JsonSchemaSource = Parameters<typeof toJsonSchema>[0];

function liveSchema(name: string): unknown {
  const schemas = contractSchemas as unknown as Record<
    string,
    JsonSchemaSource
  >;
  return Object.hasOwn(schemas, name)
    ? toJsonSchema(schemas[name]!)
    : undefined;
}

/**
 * Limit keys every action accepts today, plus `maxFindings` for the review
 * action. No per-action limit registry exists yet; widen this table together
 * with the registry.
 */
function defaultLimitFields(): Record<
  WorkflowActionName,
  readonly WorkflowLimitField[]
> {
  const table = {} as Record<WorkflowActionName, readonly WorkflowLimitField[]>;
  for (const name of WORKFLOW_ACTION_NAMES) {
    table[name] = name === "review.independent"
      ? ["maxDuration", "maxCostUsd", "maxFindings"]
      : ["maxDuration", "maxCostUsd"];
  }
  return Object.freeze(table);
}

type JsonProperties = { properties?: Record<string, unknown> };

/**
 * The `$delivery` object: run state the runtime resolves at claim time. Each
 * field takes the exact schema of the action input it feeds (`headSha` and
 * `failedChecks` and `blockingFindings` the repair input, `checkIds` the check
 * input), so a read and the field it fills agree by construction and cannot
 * drift. Unresolved, and so unreadable, when any of those schemas is missing.
 */
function liveDeliverySchema(): unknown {
  const repair = liveSchema("RepairInput") as JsonProperties | undefined;
  const checks = liveSchema("CheckInput") as JsonProperties | undefined;
  const properties = {
    headSha: repair?.properties?.["revision"],
    checkIds: checks?.properties?.["checks"],
    failedChecks: repair?.properties?.["failedChecks"],
    blockingFindings: repair?.properties?.["findings"],
  };
  if (Object.values(properties).some((schema) => schema === undefined)) {
    return undefined;
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

let cached: WorkflowCompilerCatalog | undefined;

/**
 * Catalog built from the live contracts: JSON Schemas from `contractSchemas`
 * through `toJsonSchema`, event names from the transport inventory and the
 * `Task` schema for `$task`. Built once, on first call, and converted lazily
 * per action. Check names are validated by pattern only (`checkNames: null`)
 * because no check registry exists and repository profiles define checks at
 * runtime. Actions whose IO schemas are missing from the live contracts
 * report `action_schema_unresolved`.
 */
export function defaultWorkflowCompilerCatalog(): WorkflowCompilerCatalog {
  cached ??= createWorkflowCompilerCatalog({
    schemas: liveSchema,
    events: (transport as unknown as {
      events: Readonly<Record<string, WorkflowCatalogEvent>>;
    }).events,
    taskSchema: () => liveSchema("Task"),
    deliverySchema: liveDeliverySchema,
    checkNames: null,
    actionLimitFields: defaultLimitFields(),
  });
  return cached;
}
