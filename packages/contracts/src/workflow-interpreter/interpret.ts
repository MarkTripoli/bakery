import { cloneJson } from "./clone.ts";
import type {
  WorkflowActionNode,
  WorkflowNode,
  WorkflowReferenceNode,
  WorkflowRepeatNode,
  WorkflowSemanticDocument,
  WorkflowWaitNode,
} from "../workflow-compiler/schema.ts";
import {
  evaluateCondition,
  evaluateValue,
  isJsonObject,
  type JsonValue,
  readFields,
  type ReferenceReader,
} from "./evaluate.ts";
import { WorkflowInterpreterError } from "./errors.ts";

/** What the run has recorded for one executable step (an action or a wait). */
export type StepRecord =
  | Readonly<{ status: "completed"; output: JsonValue }>
  | Readonly<{ status: "failed" | "canceled" | "timed_out" }>;

/**
 * Everything the interpreter reads. It is the whole input: the interpreter has
 * no clock, no database and no randomness, so the same state always gives the
 * same answer. The host must freeze `task` and `inputs` for the life of a run:
 * a condition that reads them is evaluated again on every call.
 */
export type RunState = Readonly<{
  inputs: Readonly<Record<string, JsonValue>>;
  /** The run's frozen `$task`. */
  task: JsonValue;
  /** `$delivery`, resolved by the host from run state; absent until it is. */
  delivery?: JsonValue;
  /** Recorded step results, keyed by step key (`repair@2.repair_test`). */
  steps: ReadonlyMap<string, StepRecord>;
  /** The run was canceled: nothing further may be dispatched. */
  cancelRequested?: boolean;
}>;

export type ActionDispatch = Readonly<{
  kind: "action";
  /** Stable step key: qualified id, with `@n` for each enclosing repeat. */
  key: string;
  id: string;
  action: string;
  /**
   * The resolved `with` object, plus `checks` when the step names them. A
   * copy: the host may edit it without touching the run's recorded state.
   */
  input: JsonValue;
  /**
   * The effect key, parts joined with a colon, when the step has one. It is not
   * placed in `input`: only the host knows whether the action's input schema
   * has an `effectKey` field to receive it.
   */
  effectKey?: string;
  agentVersionId?: string;
  requires: readonly string[];
  timeoutMs: number;
  retry: WorkflowActionNode["retry"];
  limits?: WorkflowActionNode["limits"];
  /** Iteration number of each enclosing repeat, outermost first. */
  iterationPath: readonly number[];
}>;

export type WaitDispatch = Readonly<{
  kind: "wait";
  key: string;
  id: string;
  wait: WorkflowWaitNode["wait"];
  iterationPath: readonly number[];
}>;

export type NextStep =
  | Readonly<{ kind: "dispatch"; step: ActionDispatch | WaitDispatch }>
  /** Every node has finished or was skipped. */
  | Readonly<{ kind: "finished" }>
  /**
   * A step outside any repeat failed, was canceled or timed out; or the run
   * was canceled (`key` is then null). Nothing further runs.
   */
  | Readonly<{
    kind: "halted";
    outcome: "failed" | "canceled" | "timed_out";
    key: string | null;
  }>;

type Segment = Readonly<{ id: string; iteration?: number }>;
type Frame = Readonly<{
  node: WorkflowRepeatNode;
  iteration: number;
  /** The accumulator; undefined while a repeat's own seed is being built. */
  candidate: JsonValue | undefined;
}>;
type Scope = Readonly<
  { segments: readonly Segment[]; frames: readonly Frame[] }
>;

type RepeatResult = {
  iterations: number;
  currentCandidate: JsonValue;
  outcome: "completed" | "exhausted" | "canceled" | "failed" | "timed_out";
};

type Walk =
  | Readonly<{ t: "pending"; step: ActionDispatch | WaitDispatch }>
  | Readonly<{ t: "done" }>
  | Readonly<{
    t: "halt";
    outcome: "failed" | "canceled" | "timed_out";
    key: string;
  }>;

const SCALAR_KEY_PART = new Set(["string", "number", "boolean"]);

function keyOf(segments: readonly Segment[], id: string): string {
  return [...segments, { id }].map((segment) =>
    segment.iteration === undefined
      ? segment.id
      : `${segment.id}@${segment.iteration}`
  ).join(".");
}

/** The iteration number of each enclosing repeat on a key's path, outermost first. */
function iterationPathOf(segments: readonly Segment[]): readonly number[] {
  return segments.flatMap((segment) =>
    segment.iteration === undefined ? [] : [segment.iteration]
  );
}

class Run {
  private readonly repeatResults = new Map<string, RepeatResult>();
  private readonly branchExports = new Map<
    string,
    Record<string, JsonValue>
  >();

  constructor(
    private readonly document: WorkflowSemanticDocument,
    private readonly state: RunState,
  ) {}

  next(): NextStep {
    if (this.state.cancelRequested === true) {
      return { kind: "halted", outcome: "canceled", key: null };
    }
    const walk = this.walkList(this.document.steps, {
      segments: [],
      frames: [],
    });
    switch (walk.t) {
      case "pending":
        return { kind: "dispatch", step: walk.step };
      case "halt":
        return { kind: "halted", outcome: walk.outcome, key: walk.key };
      case "done":
        return { kind: "finished" };
    }
  }

  // --- reading values

  private reader(scope: Scope): ReferenceReader {
    return (reference: WorkflowReferenceNode): JsonValue => {
      const [first, ...rest] = reference.path;
      switch (reference.root) {
        case "input":
          return readFields(
            first !== undefined && Object.hasOwn(this.state.inputs, first)
              ? this.state.inputs[first]!
              : null,
            rest,
          );
        case "task":
          return readFields(this.state.task, reference.path);
        case "delivery":
          if (this.state.delivery === undefined) {
            throw new WorkflowInterpreterError("delivery_unresolved");
          }
          return readFields(this.state.delivery, reference.path);
        case "repeat": {
          // The innermost repeat that has an accumulator. While a repeat builds
          // its own seed it has none, so `$repeat` means the repeat around it.
          const frame = [...scope.frames].reverse().find((candidate) =>
            candidate.candidate !== undefined
          );
          if (!frame || first !== "currentCandidate") {
            throw new WorkflowInterpreterError("reference_unresolved");
          }
          return readFields(frame.candidate!, rest);
        }
        case "step":
          return this.readStep(reference.path, scope);
      }
    };
  }

  /** Walks an absolute `$step` path from the root, the way the compiler resolves it. */
  private readStep(path: readonly string[], scope: Scope): JsonValue {
    let nodes: readonly WorkflowNode[] = this.document.steps;
    const segments: Segment[] = [];
    for (let at = 0; at < path.length; at += 1) {
      const node = nodes.find((candidate) => candidate.id === path[at]);
      if (!node) throw new WorkflowInterpreterError("reference_unresolved");
      const rest = path.slice(at + 1);
      switch (node.kind) {
        case "action":
        case "wait": {
          const record = this.state.steps.get(keyOf(segments, node.id));
          if (!record || record.status !== "completed") {
            throw new WorkflowInterpreterError("reference_unresolved");
          }
          return readFields(record.output, rest);
        }
        case "sequence":
          segments.push({ id: node.id });
          nodes = node.steps;
          break;
        case "branch": {
          const name = rest[0];
          if (name !== undefined && Object.hasOwn(node.outputs, name)) {
            const exported = this.branchExports.get(keyOf(segments, node.id));
            if (!exported) {
              throw new WorkflowInterpreterError("reference_unresolved");
            }
            return readFields(exported[name] ?? null, rest.slice(1));
          }
          segments.push({ id: node.id });
          nodes = [...node.then, ...node.else];
          break;
        }
        case "repeat": {
          const name = rest[0];
          if (
            name === "iterations" || name === "outcome" ||
            name === "currentCandidate"
          ) {
            const result = this.repeatResults.get(keyOf(segments, node.id));
            if (!result) {
              throw new WorkflowInterpreterError("reference_unresolved");
            }
            return readFields(result[name], rest.slice(1));
          }
          // A child of the repeat: only a reader inside it may name one, and it
          // names the iteration the reader is in (a seed step is iteration 0).
          const frame = scope.frames.find((candidate) =>
            candidate.node === node
          );
          if (!frame) {
            throw new WorkflowInterpreterError("reference_unresolved");
          }
          const seedSteps = node.seed.form === "sequence"
            ? node.seed.steps
            : [];
          const inSeed = seedSteps.some((step) => step.id === name);
          segments.push({
            id: node.id,
            iteration: inSeed ? 0 : frame.iteration,
          });
          nodes = inSeed ? seedSteps : node.steps;
          break;
        }
        case "parallel":
          throw new WorkflowInterpreterError("parallel_unsupported");
      }
    }
    // The path stopped at a container, which has no value of its own.
    throw new WorkflowInterpreterError("reference_unresolved");
  }

  // --- walking nodes

  /** Nodes run in authored order. The first one that needs the outside world stops the walk. */
  private walkList(nodes: readonly WorkflowNode[], scope: Scope): Walk {
    const settled = new Map<string, "done" | "skipped">();
    for (const node of nodes) {
      // Skipping propagates only through `needs`, never through order alone.
      let skipped = node.needs.some((id) => settled.get(id) === "skipped");
      if (!skipped && node.if !== undefined) {
        skipped = !evaluateCondition(node.if, this.reader(scope));
      }
      if (skipped) {
        settled.set(node.id, "skipped");
        continue;
      }
      const walk = this.walkNode(node, scope);
      if (walk.t !== "done") return walk;
      settled.set(node.id, "done");
    }
    return { t: "done" };
  }

  private walkNode(node: WorkflowNode, scope: Scope): Walk {
    switch (node.kind) {
      case "action":
        return this.walkAction(node, scope);
      case "wait":
        return this.walkWait(node, scope);
      case "sequence":
        return this.walkList(node.steps, {
          segments: [...scope.segments, { id: node.id }],
          frames: scope.frames,
        });
      case "branch":
        return this.walkBranch(node, scope);
      case "repeat":
        return this.walkRepeat(node, scope);
      case "parallel":
        throw new WorkflowInterpreterError("parallel_unsupported");
    }
  }

  private recorded(key: string): Walk | undefined {
    const record = this.state.steps.get(key);
    if (record === undefined) return undefined;
    return record.status === "completed"
      ? { t: "done" }
      : { t: "halt", outcome: record.status, key };
  }

  private walkAction(node: WorkflowActionNode, scope: Scope): Walk {
    const key = keyOf(scope.segments, node.id);
    const recorded = this.recorded(key);
    if (recorded) return recorded;

    const read = this.reader(scope);
    const resolved = evaluateValue(node.with, read);
    if (!isJsonObject(resolved)) {
      throw new WorkflowInterpreterError("document_invalid");
    }
    const input: { [name: string]: JsonValue } = { ...resolved };
    // The compiler keeps `checks` out of `with`; the executor puts them in.
    if (node.checks !== undefined) input["checks"] = [...node.checks];

    let effectKey: string | undefined;
    if (node.effectKey !== undefined) {
      effectKey = node.effectKey.parts.map((part) => {
        if (part.kind === "literal") return part.value;
        const value = read(part);
        if (!SCALAR_KEY_PART.has(typeof value)) {
          throw new WorkflowInterpreterError("operand_invalid");
        }
        return String(value);
      }).join(":");
    }

    return {
      t: "pending",
      step: {
        kind: "action",
        key,
        id: node.id,
        action: node.action,
        input,
        ...(effectKey === undefined ? {} : { effectKey }),
        ...(node.agentVersionId === undefined
          ? {}
          : { agentVersionId: node.agentVersionId }),
        requires: node.requires,
        timeoutMs: node.timeoutMs,
        retry: node.retry,
        ...(node.limits === undefined ? {} : { limits: node.limits }),
        iterationPath: iterationPathOf(scope.segments),
      },
    };
  }

  private walkWait(node: WorkflowWaitNode, scope: Scope): Walk {
    const key = keyOf(scope.segments, node.id);
    const recorded = this.recorded(key);
    if (recorded) return recorded;
    return {
      t: "pending",
      step: {
        kind: "wait",
        key,
        id: node.id,
        wait: node.wait,
        iterationPath: iterationPathOf(scope.segments),
      },
    };
  }

  private walkBranch(
    node: Extract<WorkflowNode, { kind: "branch" }>,
    scope: Scope,
  ): Walk {
    const chosen = evaluateCondition(node.when, this.reader(scope));
    const inner: Scope = {
      segments: [...scope.segments, { id: node.id }],
      frames: scope.frames,
    };
    const walk = this.walkList(chosen ? node.then : node.else, inner);
    if (walk.t !== "done") return walk;
    // An arm that has no value for an output name yields null for it.
    const exported: Record<string, JsonValue> = {};
    for (const [name, arms] of Object.entries(node.outputs)) {
      const value = chosen ? arms.then : arms.else;
      exported[name] = value === undefined
        ? null
        : evaluateValue(value, this.reader(inner));
    }
    this.branchExports.set(keyOf(scope.segments, node.id), exported);
    return { t: "done" };
  }

  /**
   * A bounded repeat. `until` is checked before the first iteration and after
   * each completed one; a seed that already satisfies it runs zero iterations.
   * The accumulator changes only when a whole iteration completed, so a failed,
   * canceled or timed-out iteration leaves the prior one intact and becomes the
   * repeat's outcome rather than the run's.
   */
  private walkRepeat(node: WorkflowRepeatNode, scope: Scope): Walk {
    const key = keyOf(scope.segments, node.id);

    let candidate: JsonValue;
    if (node.seed.form === "mapping") {
      candidate = evaluateValue(node.seed.currentCandidate, this.reader(scope));
    } else {
      const seedScope: Scope = {
        segments: [...scope.segments, { id: node.id, iteration: 0 }],
        frames: [...scope.frames, {
          node,
          iteration: 0,
          candidate: undefined,
        }],
      };
      const seeded = this.walkList(node.seed.steps, seedScope);
      // A seed that cannot be built leaves the repeat no accumulator to return,
      // so it stops the run like any other step outside a repeat's body.
      if (seeded.t !== "done") return seeded;
      candidate = evaluateValue(
        node.seed.currentCandidate,
        this.reader(seedScope),
      );
    }

    let iterations = 0;
    let outcome: RepeatResult["outcome"];
    for (;;) {
      const checking: Scope = {
        segments: scope.segments,
        frames: [...scope.frames, { node, iteration: iterations, candidate }],
      };
      if (evaluateCondition(node.until, this.reader(checking))) {
        outcome = "completed";
        break;
      }
      if (iterations === node.max) {
        outcome = "exhausted";
        break;
      }
      const number = iterations + 1;
      const body: Scope = {
        segments: [...scope.segments, { id: node.id, iteration: number }],
        frames: [...scope.frames, { node, iteration: number, candidate }],
      };
      const walk = this.walkList(node.steps, body);
      if (walk.t === "pending") return walk;
      if (walk.t === "halt") {
        outcome = walk.outcome;
        break;
      }
      candidate = evaluateValue(node.currentCandidate, this.reader(body));
      iterations = number;
    }
    this.repeatResults.set(key, {
      iterations,
      currentCandidate: candidate,
      outcome,
    });
    return { t: "done" };
  }
}

/**
 * What the run should do next, derived only from the document and the recorded
 * state. Calling it again with the same state gives the same answer, so a
 * replay or a duplicate call is harmless; the caller records a step's result
 * and calls again.
 *
 * The answer is a copy that shares nothing with `state` or `document`: a
 * reference such as `$step.x.payload` is resolved to the very object the run
 * recorded, and a dispatch also carries the document's own `retry` and
 * `requires`. Without the copy, a host that edited a dispatch (to inject a
 * field, say) would silently edit the recorded output, the document and every
 * later answer. State must be plain JSON: a recorded value that is not makes
 * this throw `state_not_json`. The copy costs time linear in the size of the
 * answer, which includes any large payload the step references, and the host
 * calls this once per step.
 */
export function nextStep(
  document: WorkflowSemanticDocument,
  state: RunState,
): NextStep {
  return cloneJson(new Run(document, state).next()) as NextStep;
}
