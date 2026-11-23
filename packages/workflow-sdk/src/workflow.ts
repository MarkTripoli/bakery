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
  /**
   * What the body's `collect` read from each completed iteration, in item
   * order (interpreter revision 5). Readable only when the body collects.
   */
  results(): Ref<readonly unknown[]>;
};

/** What a forEach body may return: the value to collect from each completed iteration. */
export type ForEachCollect = { readonly collect: unknown };

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
  /**
   * Most iterations that run at once, 1 to `max` (interpreter revision 5).
   * Iterations that run together may not write a shared area: the compiler
   * refuses a body with a git or shell step, or an agent step whose files
   * section writes beyond `outputs`.
   */
  readonly maxConcurrency?: number;
  readonly needs?: readonly { readonly id: string }[];
};

/** Adds steps to one list of steps: the workflow's own, or a forEach body. */
export type StepsBuilder = {
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
  /**
   * Adds a bounded, sequential forEach: `body` declares the steps that run
   * once per item of `items`, in order. It runs once, here, to build the
   * document; it is not called per item at run time. A body that returns
   * `{ collect }` has that value read from each completed iteration, after its
   * last step, and gathered as the loop's `results()`.
   */
  forEach<T>(
    id: string,
    items: Ref<readonly T[]> | Ref<readonly T[] | null> | readonly T[],
    options: ForEachOptions,
    body: (steps: StepsBuilder, item: LoopItem<T>) => void | ForEachCollect,
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
    readonly forEach?: never;
  }
  | {
    readonly id: string;
    readonly uses?: never;
    readonly needs?: readonly string[];
    readonly with?: never;
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
  readonly steps: readonly WorkflowDefinitionStep[];
};

export type WorkflowBuilder<I extends WorkflowInputs> = StepsBuilder & {
  /** A reference to a declared input of the run. */
  input<K extends keyof I & string>(name: K): Ref<InputValue<I[K]>>;
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

type BuiltStep =
  & { id: string; needs?: string[] }
  & (
    | { uses: string; with?: Record<string, unknown> }
    | {
      forEach: {
        items: unknown;
        max: number;
        as: string;
        maxConcurrency?: number;
        collect?: unknown;
        steps: BuiltStep[];
      };
    }
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
      stepOptions: { readonly needs?: readonly { readonly id: string }[] } = {},
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
      container.steps.push(step);
      return stepHandle([...container.prefix, id].join("."), id);
    };
    const forEach = (
      id: string,
      items: unknown,
      loopOptions: ForEachOptions,
      body: (
        steps: StepsBuilder,
        item: LoopItem<never>,
      ) => void | ForEachCollect,
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
      let collected: ForEachCollect | undefined;
      try {
        const item = `$each.${loopOptions.as}`;
        const returned = body(
          builderFor(loop),
          Object.freeze({
            ref: reference<never>(item),
            field: (path: string) => reference<never>(`${item}.${path}`),
          }) as LoopItem<never>,
        );
        collected = returned === undefined ? undefined : returned;
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
      if (loopOptions.maxConcurrency !== undefined) {
        (step as { forEach: { maxConcurrency?: number } }).forEach
          .maxConcurrency = loopOptions.maxConcurrency;
      }
      if (collected !== undefined && collected !== null) {
        if (!Object.hasOwn(collected, "collect")) {
          throw new Error(
            `forEach "${id}" body returned something other than { collect }`,
          );
        }
        readBindings(collected.collect, id, [], "collect");
        (step as { forEach: { collect?: unknown } }).forEach.collect =
          collected.collect;
      }
      if (needs.length > 0) step.needs = needs;
      container.steps.push(step);
      const qualified = [...container.prefix, id].join(".");
      const collects = collected !== undefined && collected !== null;
      const handle = Object.freeze({
        id,
        iterations: () => reference<number>(`$step.${qualified}.iterations`),
        outcome: () => reference<ForEachOutcome>(`$step.${qualified}.outcome`),
        results: () => {
          if (!collects) {
            throw new Error(
              `forEach "${id}" collects nothing, so it has no results`,
            );
          }
          return reference<readonly unknown[]>(`$step.${qualified}.results`);
        },
      });
      handles.add(handle);
      return handle;
    };
    return { action, forEach } as unknown as StepsBuilder;
  };

  return {
    ...builderFor(root),
    input: (name: string) => {
      if (!declared.has(name)) {
        throw new Error(`workflow input "${name}" is not declared`);
      }
      return reference<never>(`$input.${name}`);
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
          steps: root.steps,
        })) as WorkflowDefinition,
      ),
  } as WorkflowBuilder<I>;
}
