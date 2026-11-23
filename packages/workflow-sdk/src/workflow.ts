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

/** How a forEach ended, as `$step.<id>.outcome` reports it. */
export type ForEachOutcome = "completed" | "failed" | "canceled" | "timed_out";

/** A forEach already added to a workflow: its id and references to its results. */
export type ForEachHandle = {
  readonly id: string;
  /** How many iterations completed. */
  iterations(): Ref<number>;
  /** Whether every item ran, or how the iteration that stopped the loop ended. */
  outcome(): Ref<ForEachOutcome>;
};

/**
 * A call already added to a workflow: its id, and a reference to each output the
 * called workflow declares. Nothing else of the called workflow can be read.
 */
export type CallHandle = {
  readonly id: string;
  /** A reference to an output the called workflow declares, by name. */
  output(name: string): Ref<unknown>;
};

/** The current item of a forEach, read inside its body as `$each.<as>`. */
export type LoopItem<T> = {
  /** A reference to the whole item. */
  readonly ref: Ref<T>;
  /** A reference to a field of the item, by dotted path. */
  field<P extends OutputPath<T> & string>(path: P): Ref<ValueAt<T, P>>;
};

export type ForEachOptions = {
  /** Most items the loop accepts, 1 to 12; a longer list halts the run. */
  readonly max: number;
  /** The name the body reads the item by; distinct from any enclosing loop's. */
  readonly as: string;
  readonly needs?: readonly { readonly id: string }[];
};

/**
 * A step's files section (chapter 25 section 17.6): the storage areas its
 * agent reads and writes, and the storage connections it binds. A definition
 * only narrows the defaults; `connections` opens /connections/<connection>
 * for exactly the connections named, and needs `connections` in `read`.
 */
export type StepFiles = {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
  /** Ids of the organization's storage connections the step's agent reads. */
  readonly connections?: readonly string[];
};

/** Options of one action step. */
export type ActionStepOptions = {
  readonly needs?: readonly { readonly id: string }[];
  readonly files?: StepFiles;
};

/** Adds steps to one list of steps: the workflow's own, or a forEach body. */
export type StepsBuilder = {
  /** Adds an action step with typed bindings. */
  action<In extends object, Out extends object>(
    id: string,
    action: ActionRef<In, Out>,
    bindings: Bindings<In>,
    options?: ActionStepOptions,
  ): StepHandle<Out>;
  /** Adds a step for an action known only by name; nothing is type-checked. */
  action(
    id: string,
    action: string,
    bindings: Readonly<Record<string, unknown>>,
    options?: ActionStepOptions,
  ): StepHandle<Record<string, unknown>>;
  /**
   * Calls a published version of another workflow. Its steps run here, under
   * this id, with `bindings` as the values of its inputs; this workflow reads
   * only what the called workflow declares as outputs. The version is named by
   * id, so what runs cannot change after this is written.
   */
  call(
    id: string,
    workflowVersionId: string,
    bindings: Readonly<Record<string, unknown>>,
    options?: { readonly needs?: readonly { readonly id: string }[] },
  ): CallHandle;
  /**
   * Adds a bounded, sequential forEach: `body` declares the steps that run
   * once per item of `items`, in order. It runs once, here, to build the
   * document; it is not called per item at run time.
   */
  forEach<T>(
    id: string,
    items: Ref<readonly T[]> | Ref<readonly T[] | null> | readonly T[],
    options: ForEachOptions,
    body: (steps: StepsBuilder, item: LoopItem<T>) => void,
  ): ForEachHandle;
};

export type WorkflowOptions<I extends WorkflowInputs> = {
  readonly name: string;
  readonly description?: string;
  readonly inputs: I;
};

/** One step of a built document: an action, or a forEach holding steps. */
export type WorkflowDefinitionStep =
  | {
    readonly id: string;
    readonly uses: string;
    readonly needs?: readonly string[];
    readonly with?: Readonly<Record<string, unknown>>;
    readonly files?: StepFiles;
    readonly forEach?: never;
    readonly call?: never;
  }
  | {
    readonly id: string;
    readonly uses?: never;
    readonly needs?: readonly string[];
    readonly with?: never;
    readonly forEach?: never;
    readonly call: {
      readonly workflow: string;
      readonly with?: Readonly<Record<string, unknown>>;
    };
  }
  | {
    readonly id: string;
    readonly uses?: never;
    readonly needs?: readonly string[];
    readonly with?: never;
    readonly call?: never;
    readonly forEach: {
      readonly items: unknown;
      readonly max: number;
      readonly as: string;
      readonly steps: readonly WorkflowDefinitionStep[];
    };
  };

export type WorkflowDefinition = {
  readonly apiVersion: "bakery.dev/v1";
  readonly kind: "workflow";
  readonly name: string;
  readonly description?: string;
  readonly inputs: Readonly<
    Record<string, { type: string; required: boolean }>
  >;
  /** What a workflow that calls this one may read; absent when none are declared. */
  readonly outputs?: Readonly<Record<string, string>>;
  readonly steps: readonly WorkflowDefinitionStep[];
};

export type WorkflowBuilder<I extends WorkflowInputs> = StepsBuilder & {
  /** A reference to a declared input of the run. */
  input<K extends keyof I & string>(name: K): Ref<InputValue<I[K]>>;
  /**
   * Declares what a workflow that calls this one may read: each name maps to a
   * step output of this workflow. Call it once, after the steps it points at.
   */
  outputs(declared: Readonly<Record<string, Ref<unknown>>>): void;
  /** The document, as inert plain JSON. */
  toJSON(): WorkflowDefinition;
};

/**
 * A string is a reference only when the whole string is one: the document
 * grammar reads a string that begins with `$` as a reference and everything
 * else as text, so text that merely mentions `$step.x` mid-sentence stays text.
 */
const STEP_REFERENCE = /^\$step\.([A-Za-z][A-Za-z0-9_-]*)(?=\.|$)/;
const LOOP_ITEM_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTPUT_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

/**
 * Walks one step's bindings. It collects the step each reference reads, in
 * order, and refuses a value a document cannot hold: a workflow is data, so a
 * function (or a symbol) is an error here rather than a field that silently
 * disappears when the document is serialized.
 */
function readBindings(
  value: unknown,
  stepId: string,
  found: string[][],
  path = "",
): void {
  if (typeof value === "string") {
    const match = STEP_REFERENCE.exec(value);
    if (match) found.push(value.slice("$step.".length).split("."));
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

/** A plain copy of a files section, keeping only the axes it names. */
function copyFiles(files: StepFiles): StepFiles {
  return {
    ...(files.read === undefined ? {} : { read: [...files.read] }),
    ...(files.write === undefined ? {} : { write: [...files.write] }),
    ...(files.connections === undefined
      ? {}
      : { connections: [...files.connections] }),
  };
}

type BuiltStep =
  & { id: string; needs?: string[] }
  & (
    | { uses: string; with?: Record<string, unknown>; files?: StepFiles }
    | {
      forEach: { items: unknown; max: number; as: string; steps: BuiltStep[] };
    }
    | { call: { workflow: string; with?: Record<string, unknown> } }
  );

/** One list of steps being built: the workflow's own, or an open loop's body. */
type Container = {
  /** Qualified id of the loop whose body this is; empty for the workflow. */
  readonly prefix: readonly string[];
  /** The loop's item name; undefined for the workflow. */
  readonly as: string | undefined;
  readonly steps: BuiltStep[];
  /** Steps of the enclosing list this loop must follow. */
  readonly needs: Set<string>;
};

export function defineWorkflow<const I extends WorkflowInputs>(
  options: WorkflowOptions<I>,
): WorkflowBuilder<I> {
  const declared = new Set(Object.keys(options.inputs));
  const root: Container = {
    prefix: [],
    as: undefined,
    steps: [],
    needs: new Set(),
  };
  const open: Container[] = [root];
  const handles = new WeakSet<object>();
  let declaredOutputs: Record<string, string> | undefined;

  const reference = <T>(text: string) => text as unknown as Ref<T>;

  const stepHandle = (qualified: string, id: string): StepHandle<never> => {
    const handle = Object.freeze({
      id,
      output: (path: string) => reference<never>(`$step.${qualified}.${path}`),
    }) as StepHandle<never>;
    handles.add(handle);
    return handle;
  };

  /**
   * Resolves the references a new step of `at` reads. A reference names an
   * earlier step of `at` (a dependency of the new step) or of an enclosing
   * list (a dependency of the loop that encloses `at` there). Anything else is
   * refused here, as the compiler would refuse it later.
   */
  const dependencies = (
    at: Container,
    stepId: string,
    value: unknown,
    own: Set<string>,
  ): void => {
    const found: string[][] = [];
    readBindings(value, stepId, found);
    for (const path of found) {
      const depth = open.indexOf(at);
      let matched = false;
      for (let level = depth; level >= 0; level -= 1) {
        const container = open[level]!;
        const prefix = container.prefix;
        if (
          path.length <= prefix.length ||
          !prefix.every((segment, index) => path[index] === segment)
        ) continue;
        const target = path[prefix.length]!;
        if (!container.steps.some((step) => step.id === target)) break;
        if (level === depth) own.add(target);
        else open[level + 1]!.needs.add(target);
        matched = true;
        break;
      }
      if (!matched) {
        throw new Error(
          `step "${stepId}" reads $step.${
            path.join(".")
          }, which is not declared before it (a string that begins with $ is a reference; write text that must start with $ as a literal)`,
        );
      }
    }
  };

  const ordered = (container: Container, wanted: Set<string>): string[] =>
    container.steps.map((step) => step.id).filter((id) => wanted.has(id));

  const checkStepId = (container: Container, id: string): void => {
    if (container.steps.some((step) => step.id === id)) {
      throw new Error(`workflow step id "${id}" is already used`);
    }
  };

  const addNeeds = (
    id: string,
    given: readonly { readonly id: string }[] | undefined,
    into: Set<string>,
  ): void => {
    for (const handle of given ?? []) {
      if (!handles.has(handle)) {
        throw new Error(`step "${id}" needs a step of another workflow`);
      }
      into.add(handle.id);
    }
  };

  const builderFor = (container: Container): StepsBuilder => {
    const current = (): void => {
      if (open.at(-1) !== container) {
        throw new Error(
          "steps of a forEach are added only inside its body callback, and the workflow's own steps only outside every body",
        );
      }
    };
    const action = (
      id: string,
      action: string | { readonly id: string },
      bindings: Readonly<Record<string, unknown>>,
      stepOptions: ActionStepOptions = {},
    ) => {
      current();
      checkStepId(container, id);
      const wanted = new Set<string>();
      dependencies(container, id, bindings, wanted);
      addNeeds(id, stepOptions.needs, wanted);
      // Dependencies come from the data, in declaration order, so a step cannot
      // read an output its `needs` does not order it after.
      const needs = ordered(container, wanted);
      const step: BuiltStep = {
        id,
        uses: typeof action === "string" ? action : action.id,
      };
      if (needs.length > 0) step.needs = needs;
      if (Object.keys(bindings).length > 0) step.with = { ...bindings };
      if (stepOptions.files !== undefined) {
        step.files = copyFiles(stepOptions.files);
      }
      container.steps.push(step);
      return stepHandle([...container.prefix, id].join("."), id);
    };
    const forEach = (
      id: string,
      items: unknown,
      loopOptions: ForEachOptions,
      body: (steps: StepsBuilder, item: LoopItem<never>) => void,
    ): ForEachHandle => {
      current();
      checkStepId(container, id);
      if (!LOOP_ITEM_NAME.test(loopOptions.as)) {
        throw new Error(
          `forEach "${id}" names its item "${loopOptions.as}", which is not an item name`,
        );
      }
      if (open.some((enclosing) => enclosing.as === loopOptions.as)) {
        throw new Error(
          `forEach "${id}" reuses the item name "${loopOptions.as}" of a loop around it`,
        );
      }
      const wanted = new Set<string>();
      dependencies(container, id, items, wanted);
      addNeeds(id, loopOptions.needs, wanted);
      const loop: Container = {
        prefix: [...container.prefix, id],
        as: loopOptions.as,
        steps: [],
        needs: wanted,
      };
      open.push(loop);
      try {
        const item = `$each.${loopOptions.as}`;
        body(
          builderFor(loop),
          Object.freeze({
            ref: reference<never>(item),
            field: (path: string) => reference<never>(`${item}.${path}`),
          }) as LoopItem<never>,
        );
      } finally {
        open.pop();
      }
      if (loop.steps.length === 0) {
        throw new Error(`forEach "${id}" has no steps`);
      }
      const needs = ordered(container, wanted);
      const step: BuiltStep = {
        id,
        forEach: {
          items,
          max: loopOptions.max,
          as: loopOptions.as,
          steps: loop.steps,
        },
      };
      if (needs.length > 0) step.needs = needs;
      container.steps.push(step);
      const qualified = [...container.prefix, id].join(".");
      const handle = Object.freeze({
        id,
        iterations: () => reference<number>(`$step.${qualified}.iterations`),
        outcome: () => reference<ForEachOutcome>(`$step.${qualified}.outcome`),
      });
      handles.add(handle);
      return handle;
    };
    const call = (
      id: string,
      workflowVersionId: string,
      bindings: Readonly<Record<string, unknown>> = {},
      callOptions: { readonly needs?: readonly { readonly id: string }[] } = {},
    ): CallHandle => {
      current();
      checkStepId(container, id);
      if (!VERSION_ID.test(workflowVersionId)) {
        throw new Error(
          `call "${id}" names "${workflowVersionId}", which is not a workflow version id`,
        );
      }
      const wanted = new Set<string>();
      dependencies(container, id, bindings, wanted);
      addNeeds(id, callOptions.needs, wanted);
      const needs = ordered(container, wanted);
      const step: BuiltStep = {
        id,
        call: {
          workflow: workflowVersionId.toLowerCase(),
          ...(Object.keys(bindings).length > 0
            ? { with: { ...bindings } }
            : {}),
        },
      };
      if (needs.length > 0) step.needs = needs;
      container.steps.push(step);
      const qualified = [...container.prefix, id].join(".");
      const handle = Object.freeze({
        id,
        output: (name: string) =>
          reference<unknown>(`$step.${qualified}.${name}`),
      });
      handles.add(handle);
      return handle;
    };
    return { action, forEach, call } as unknown as StepsBuilder;
  };

  return {
    ...builderFor(root),
    input: (name: string) => {
      if (!declared.has(name)) {
        throw new Error(`workflow input "${name}" is not declared`);
      }
      return reference<never>(`$input.${name}`);
    },
    outputs: (declared: Readonly<Record<string, unknown>>) => {
      if (declaredOutputs !== undefined) {
        throw new Error("workflow outputs are declared once");
      }
      const mapped: Record<string, string> = {};
      for (const [name, ref] of Object.entries(declared)) {
        if (!OUTPUT_NAME.test(name)) {
          throw new Error(`workflow output "${name}" is not an output name`);
        }
        if (typeof ref !== "string" || !ref.startsWith("$step.")) {
          throw new Error(
            `workflow output "${name}" must be a reference to a step output`,
          );
        }
        mapped[name] = ref;
      }
      declaredOutputs = mapped;
    },
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
          ...(declaredOutputs && Object.keys(declaredOutputs).length > 0
            ? { outputs: declaredOutputs }
            : {}),
          steps: root.steps,
        })) as WorkflowDefinition,
      ),
  } as WorkflowBuilder<I>;
}
