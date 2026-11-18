import type { OutputPath, Ref, ValueAt } from "./ref.ts";

/**
 * A declared workflow input: its document type name and whether a run must
 * supply it. `T` is the TypeScript type a reference to it carries; it is a
 * phantom, never read at runtime.
 */
export type InputSpec<T = unknown> = {
  readonly type: string;
  readonly required: boolean;
  readonly [phantom]?: T;
};
declare const phantom: unique symbol;

export type WorkflowInputs = Readonly<
  Record<string, InputSpec<never> | InputSpec<unknown>>
>;

/** The value type a reference to a declared input carries. */
export type InputValue<S> = S extends InputSpec<infer T> ? T : unknown;

const input = <T>(type: string, required: boolean): InputSpec<T> =>
  Object.freeze({ type, required }) as InputSpec<T>;

export const uuidInput = (required = true): InputSpec<string> =>
  input("uuid", required);
export const stringInput = (required = true): InputSpec<string> =>
  input("string", required);
export const integerInput = (required = true): InputSpec<number> =>
  input("integer", required);
export const booleanInput = (required = true): InputSpec<boolean> =>
  input("boolean", required);

/**
 * An action the workflow calls, typed by the input it takes and the output it
 * returns. Declaring one is how an author gets compile-time checking; an action
 * named by a bare string is typed `unknown`.
 */
export type ActionRef<In extends object, Out extends object> = {
  readonly id: string;
  readonly [actionTypes]?: { readonly in: In; readonly out: Out };
};
declare const actionTypes: unique symbol;

export function defineAction<In extends object, Out extends object>(
  id: string,
): ActionRef<In, Out> {
  return Object.freeze({ id }) as ActionRef<In, Out>;
}

/** What may be bound to an action's input: the value itself or a reference to one. */
export type Bindings<In> = {
  readonly [K in keyof In]?: In[K] | Ref<In[K]>;
};

/** A step already added to a workflow: its id, and references to its outputs. */
export type StepHandle<Out = unknown> = {
  readonly id: string;
  /** A reference to a value the step outputs, by dotted path. */
  output<P extends OutputPath<Out> & string>(path: P): Ref<ValueAt<Out, P>>;
};

export type WorkflowOptions<I extends WorkflowInputs> = {
  readonly name: string;
  readonly description?: string;
  readonly inputs: I;
};

export type WorkflowDefinition = {
  readonly apiVersion: "bakery.dev/v1";
  readonly kind: "workflow";
  readonly name: string;
  readonly description?: string;
  readonly inputs: Readonly<
    Record<string, { type: string; required: boolean }>
  >;
  readonly steps: readonly {
    readonly id: string;
    readonly uses: string;
    readonly needs?: readonly string[];
    readonly with?: Readonly<Record<string, unknown>>;
  }[];
};

export type WorkflowBuilder<I extends WorkflowInputs> = {
  /** A reference to a declared input of the run. */
  input<K extends keyof I & string>(name: K): Ref<InputValue<I[K]>>;
  /** Adds an action step with typed bindings. */
  action<In extends object, Out extends object>(
    id: string,
    action: ActionRef<In, Out>,
    bindings: Bindings<In>,
    options?: { readonly needs?: readonly { readonly id: string }[] },
  ): StepHandle<Out>;
  /** Adds a step for an action known only by name; nothing is type-checked. */
  action(
    id: string,
    action: string,
    bindings: Readonly<Record<string, unknown>>,
    options?: { readonly needs?: readonly { readonly id: string }[] },
  ): StepHandle<Record<string, unknown>>;
  /** The document, as inert plain JSON. */
  toJSON(): WorkflowDefinition;
};

/**
 * A string is a reference only when the whole string is one: the document
 * grammar reads a string that begins with `$` as a reference and everything
 * else as text, so text that merely mentions `$step.x` mid-sentence stays text.
 */
const STEP_REFERENCE = /^\$step\.([A-Za-z][A-Za-z0-9_-]*)(?=\.|$)/;

/**
 * Walks one step's bindings. It collects the step each reference reads, in
 * order, and refuses a value a document cannot hold: a workflow is data, so a
 * function (or a symbol) is an error here rather than a field that silently
 * disappears when the document is serialized.
 */
function readBindings(
  value: unknown,
  stepId: string,
  found: Set<string>,
  path = "",
): void {
  if (typeof value === "string") {
    const match = STEP_REFERENCE.exec(value);
    if (match) found.add(match[1]!);
  } else if (typeof value === "function" || typeof value === "symbol") {
    throw new Error(
      `step "${stepId}" binds a ${typeof value} at "${path}"; a workflow is data and holds no callback`,
    );
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      readBindings(item, stepId, found, `${path}/${index}`)
    );
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      readBindings(item, stepId, found, `${path}/${key}`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function defineWorkflow<const I extends WorkflowInputs>(
  options: WorkflowOptions<I>,
): WorkflowBuilder<I> {
  const declared = new Set(Object.keys(options.inputs));
  const steps: {
    id: string;
    uses: string;
    needs?: string[];
    with?: Record<string, unknown>;
  }[] = [];
  const handles = new WeakSet<object>();

  const stepHandle = (id: string): StepHandle<never> => {
    const handle = Object.freeze({
      id,
      output: (path: string) => `$step.${id}.${path}` as unknown as Ref<never>,
    }) as StepHandle<never>;
    handles.add(handle);
    return handle;
  };

  const action = (
    id: string,
    action: string | { readonly id: string },
    bindings: Readonly<Record<string, unknown>>,
    stepOptions: { readonly needs?: readonly { readonly id: string }[] } = {},
  ) => {
    if (steps.some((step) => step.id === id)) {
      throw new Error(`workflow step id "${id}" is already used`);
    }
    const referenced = new Set<string>();
    readBindings(bindings, id, referenced);
    for (const target of referenced) {
      if (!steps.some((step) => step.id === target)) {
        throw new Error(
          `step "${id}" reads $step.${target}, which is not declared before it (a string that begins with $ is a reference; write text that must start with $ as a literal)`,
        );
      }
    }
    for (const given of stepOptions.needs ?? []) {
      if (!handles.has(given)) {
        throw new Error(`step "${id}" needs a step of another workflow`);
      }
      referenced.add(given.id);
    }
    // Dependencies come from the data, in declaration order, so a step cannot
    // read an output its `needs` does not order it after.
    const needs = steps.map((step) => step.id).filter((other) =>
      referenced.has(other)
    );
    const step: (typeof steps)[number] = {
      id,
      uses: typeof action === "string" ? action : action.id,
    };
    if (needs.length > 0) step.needs = needs;
    if (Object.keys(bindings).length > 0) step.with = { ...bindings };
    steps.push(step);
    return stepHandle(id);
  };

  return {
    input: (name: string) => {
      if (!declared.has(name)) {
        throw new Error(`workflow input "${name}" is not declared`);
      }
      return `$input.${name}` as unknown as Ref<never>;
    },
    action: action as unknown as WorkflowBuilder<I>["action"],
    toJSON: () =>
      deepFreeze(
        JSON.parse(JSON.stringify({
          apiVersion: "bakery.dev/v1",
          kind: "workflow",
          name: options.name,
          ...(options.description === undefined
            ? {}
            : { description: options.description }),
          inputs: Object.fromEntries(
            Object.entries(options.inputs).map((
              [key, spec],
            ) => [key, { type: spec.type, required: spec.required }]),
          ),
          steps,
        })) as WorkflowDefinition,
      ),
  } as WorkflowBuilder<I>;
}
