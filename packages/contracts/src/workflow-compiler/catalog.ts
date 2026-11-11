import {
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionMetadata,
  type WorkflowActionName,
} from "../workflow-action-registry.ts";
import { isSecretName } from "./secrets.ts";
import { registeredActionMetadata } from "./registry.ts";
import {
  asObjectType,
  type ObjectField,
  type ObjectValueType,
  schemaToValueType,
  type ValueType,
} from "./types.ts";

/** Action-local limit keys a catalog may allow per action. */
export type WorkflowLimitField = "maxDuration" | "maxCostUsd" | "maxFindings";

/** Shape of a catalog event: only the payload field grammar is read. */
export type WorkflowCatalogEvent = {
  readonly payloadFields?: Readonly<Record<string, string>> | undefined;
};

/** Named IO schemas as a record, or a lazy lookup returning undefined when absent. */
export type WorkflowSchemaSource =
  | Readonly<Record<string, unknown>>
  | ((name: string) => unknown);

export type WorkflowCompilerCatalogInput = {
  /** JSON Schema for each registry IO schema name. */
  readonly schemas: WorkflowSchemaSource;
  /** Known event names for `wait.event`, each with an optional payload grammar. */
  readonly events: Readonly<Record<string, WorkflowCatalogEvent>>;
  /** JSON Schema of the `$task` object, or a thunk producing it. */
  readonly taskSchema: unknown;
  /**
   * Exact registered check names, or `null` for pattern-only validation (no
   * check registry exists yet; repository profiles define checks at runtime).
   */
  readonly checkNames: ReadonlySet<string> | null;
  /** Limit keys each registered action accepts. */
  readonly actionLimitFields: Readonly<
    Record<WorkflowActionName, readonly WorkflowLimitField[]>
  >;
};

export type ResolvedWorkflowAction = {
  readonly name: string;
  readonly metadata: WorkflowActionMetadata;
  readonly input: ObjectValueType;
  readonly output: ValueType;
};

export type ResolvedWorkflowEvent = {
  /** Payload object type, or undefined when its field grammar is unsupported. */
  readonly payload: ObjectValueType | undefined;
};

/** Injected, read-only view of every external fact the compiler resolves against. */
export interface WorkflowCompilerCatalog {
  /** Exact check names, or null when only the name pattern is enforced. */
  readonly checkNames: ReadonlySet<string> | null;
  /** Limit keys accepted by an action (empty for unregistered names). */
  limitFields(action: string): readonly WorkflowLimitField[];
  /** Resolved IO types, or undefined when unregistered or the schema does not resolve. */
  resolveAction(action: string): ResolvedWorkflowAction | undefined;
  /** Event lookup for `wait.event`; undefined when the name is unknown. */
  event(name: string): ResolvedWorkflowEvent | undefined;
  /** Type of the `$task` object, or undefined when unresolved. */
  task(): ValueType | undefined;
}

function lookupSchema(source: WorkflowSchemaSource, name: string): unknown {
  if (typeof source === "function") return source(name);
  return Object.hasOwn(source, name) ? source[name] : undefined;
}

const EVENT_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENUM_FIELD = /^enum\(([A-Za-z0-9_|-]{1,256})\)$/;

function eventFieldType(text: string): ValueType | undefined {
  if (text.endsWith("|null")) {
    const inner = eventFieldType(text.slice(0, -"|null".length));
    return inner && inner.kind !== "nullable"
      ? { kind: "nullable", inner }
      : undefined;
  }
  switch (text) {
    case "uuid":
      return { kind: "string", format: "uuid" };
    case "string":
    case "decimalString":
      return { kind: "string" };
    case "integer":
      return { kind: "number", integer: true };
    case "number":
      return { kind: "number", integer: false };
    case "boolean":
      return { kind: "boolean" };
  }
  const match = ENUM_FIELD.exec(text);
  if (match) {
    return { kind: "string", enum: Object.freeze(match[1]!.split("|")) };
  }
  return undefined;
}

function eventPayload(
  event: WorkflowCatalogEvent,
): ObjectValueType | undefined {
  const fields = new Map<string, ObjectField>();
  for (const [name, text] of Object.entries(event.payloadFields ?? {})) {
    const type = EVENT_FIELD_NAME.test(name) && typeof text === "string"
      ? eventFieldType(text)
      : undefined;
    if (!type) return undefined;
    fields.set(name, {
      type,
      required: true,
      sensitive: isSecretName(name),
    });
  }
  return { kind: "object", fields };
}

/**
 * Builds the catalog the compiler resolves against. Nothing here imports the
 * live contracts, so SDK and editor consumers can inject their own. Schemas
 * are converted lazily on first use and cached; a schema that does not
 * resolve leaves its action unresolved (`action_schema_unresolved`) rather
 * than widening to an untyped value.
 */
export function createWorkflowCompilerCatalog(
  input: WorkflowCompilerCatalogInput,
): WorkflowCompilerCatalog {
  const actions = new Map<string, ResolvedWorkflowAction | null>();
  const events = new Map<string, ResolvedWorkflowEvent | null>();
  let task: { value: ValueType | undefined } | undefined;
  return {
    checkNames: input.checkNames,
    limitFields(action) {
      return (WORKFLOW_ACTION_NAMES as readonly string[]).includes(action) &&
          Object.hasOwn(input.actionLimitFields, action)
        ? input.actionLimitFields[action as WorkflowActionName]
        : [];
    },
    resolveAction(action) {
      const cached = actions.get(action);
      if (cached !== undefined) return cached ?? undefined;
      const metadata = registeredActionMetadata(action);
      let resolved: ResolvedWorkflowAction | null = null;
      if (metadata) {
        const inputType = asObjectType(
          schemaToValueType(lookupSchema(input.schemas, metadata.input)),
        );
        const outputType = schemaToValueType(
          lookupSchema(input.schemas, metadata.output),
        );
        if (inputType && outputType) {
          resolved = {
            name: action,
            metadata,
            input: inputType,
            output: outputType,
          };
        }
      }
      actions.set(action, resolved);
      return resolved ?? undefined;
    },
    event(name) {
      const cached = events.get(name);
      if (cached !== undefined) return cached ?? undefined;
      const source = Object.hasOwn(input.events, name)
        ? input.events[name]
        : undefined;
      const resolved = source ? { payload: eventPayload(source) } : null;
      events.set(name, resolved);
      return resolved ?? undefined;
    },
    task() {
      if (!task) {
        const schema = typeof input.taskSchema === "function"
          ? (input.taskSchema as () => unknown)()
          : input.taskSchema;
        task = { value: schemaToValueType(schema) };
      }
      return task.value;
    },
  };
}

/**
 * Resolves nothing. Used when a compile has no catalog so the catalog-free
 * flow and scope rules still run with action outputs of unknown type.
 */
export const UNTYPED_CATALOG: WorkflowCompilerCatalog = Object.freeze({
  checkNames: null,
  limitFields: () => [],
  resolveAction: () => undefined,
  event: () => undefined,
  task: () => undefined,
});
