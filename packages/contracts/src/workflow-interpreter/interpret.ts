import { cloneJson } from "./clone.ts";
import type {
  WorkflowActionNode,
  WorkflowLane,
  WorkflowNode,
  WorkflowParallelNode,
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
  /**
   * Tries the host allowed beyond a repeat's own `max`, by the repeat's step
   * key (`repair`). The document stays pinned; the host records each allowance
   * as a fact of the run, and a key with no entry keeps the document's bound.
   */
  repeatExtra?: Readonly<Record<string, number>>;
  /** Recorded step results, keyed by step key (`repair@2.repair_test`). */
  steps: ReadonlyMap<string, StepRecord>;
  /** The run was canceled: nothing further may be dispatched. */
  cancelRequested?: boolean;
  /**
   * Keys of steps the host has dispatched that have no result yet. Revision 1
   * runs one step at a time and ignores it. Revision 2 reads it to know which
   * lanes of a parallel group are already running, so that a lane that has
   * started keeps its place against `maxConcurrency` however the others
   * finish.
   */
  inFlight?: ReadonlySet<string>;
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
  /**
   * The step's declared input slots in authored order, each with the value its
   * `from` resolved to (normally an artifact reference). Present only when the
   * step declares slots, so a dispatch of a step without them is unchanged.
   * The host pins what each value names at admission.
   */
  inputs?: readonly Readonly<{ slot: string; value: JsonValue }>[];
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
  /**
   * Revision 2, inside a parallel group: every step that may run now, in
   * authored order, one next step for each lane that is allowed to run (at
   * most `maxConcurrency` lanes, lanes already running first). The same set
   * is answered again until a step in it is recorded, so a host dispatches
   * each key once and treats the rest as already running.
   */
  | Readonly<{
    kind: "dispatch_many";
    steps: readonly (ActionDispatch | WaitDispatch)[];
  }>
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
  }>
  /**
   * A repeat that declares `allow` used it up below its `max` with its exit
   * condition still false. Nothing further runs until the host records an
   * allowance for `key` (`repeatExtra`); more rounds never go past `max`.
   */
  | Readonly<{
    kind: "paused";
    key: string;
    iterations: number;
    allowed: number;
    max: number;
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
  | Readonly<{
    t: "pending_many";
    steps: readonly (ActionDispatch | WaitDispatch)[];
  }>
  | Readonly<{ t: "done" }>
  | Readonly<{
    t: "halt";
    outcome: "failed" | "canceled" | "timed_out";
    key: string;
  }>
  /** A repeat used its `allow` below its `max`; the run waits for a limit decision. */
  | Readonly<{
    t: "pause";
    key: string;
    iterations: number;
    allowed: number;
    max: number;
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

  /** Exports of finished lanes, keyed by `<group key>.<lane id>`. */
  private readonly laneExports = new Map<string, Record<string, JsonValue>>();

  constructor(
    private readonly document: WorkflowSemanticDocument,
    private readonly state: RunState,
    /** Revision 2: parallel groups run. Revision 1 refuses them by name. */
    private readonly groups: boolean = false,
    /** Loop-bounds revision: a repeat's `min` and `allow` are honored. Earlier ones ignore them. */
    private readonly loopBounds: boolean = false,
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
      case "pending_many":
        return { kind: "dispatch_many", steps: walk.steps };
      case "halt":
        return { kind: "halted", outcome: walk.outcome, key: walk.key };
      case "pause":
        return {
          kind: "paused",
          key: walk.key,
          iterations: walk.iterations,
          allowed: walk.allowed,
          max: walk.max,
        };
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
        case "parallel": {
          if (!this.groups) {
            throw new WorkflowInterpreterError("parallel_unsupported");
          }
          // `<group>.<lane>.<name>`: a finished lane's export, or (from inside
          // that lane) one of its own steps, named by its absolute path.
          const lane = node.lanes.find((candidate) => candidate.id === rest[0]);
          if (!lane) throw new WorkflowInterpreterError("reference_unresolved");
          const name = rest[1];
          if (
            name !== undefined &&
            Object.hasOwn(node.outputs[lane.id] ?? {}, name)
          ) {
            const exported = this.laneExports.get(
              `${keyOf(segments, node.id)}.${lane.id}`,
            );
            if (!exported) {
              throw new WorkflowInterpreterError("reference_unresolved");
            }
            return readFields(exported[name] ?? null, rest.slice(2));
          }
          segments.push({ id: node.id }, { id: lane.id });
          nodes = lane.steps;
          at += 1;
          break;
        }
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
        if (!this.groups) {
          throw new WorkflowInterpreterError("parallel_unsupported");
        }
        return this.walkParallel(node, scope);
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
        ...(node.inputs === undefined || node.inputs.length === 0 ? {} : {
          inputs: node.inputs.map((slot) => ({
            slot: slot.name,
            value: evaluateValue(slot.from, read),
          })),
        }),
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
   * A bounded parallel group (revision 2). Lanes are sequences; a lane runs
   * once the lanes it `needs` are done, and at most `maxConcurrency` lanes run
   * at once, those already running first and then new ones in authored order.
   * The join is all-required: the group is done only when every lane is, and
   * lane exports exist only then. A failed lane (any step outside a repeat
   * failed, was canceled or timed out) stops its dependants, directly or
   * through other lanes (`failurePolicy: stop-dependent`), and nothing else:
   * lanes that depend on no failed lane start as they would have, lanes that
   * started run to the end, and when nothing can still run the group halts
   * with the first failed lane's outcome and step key in authored order.
   */
  private walkParallel(node: WorkflowParallelNode, scope: Scope): Walk {
    const groupSegments: readonly Segment[] = [...scope.segments, {
      id: node.id,
    }];
    const laneStatus = new Map<
      string,
      "done" | "failed" | "waiting" | "active"
    >();
    const halts = new Map<string, Extract<Walk, { t: "halt" }>>();
    const pauses: Extract<Walk, { t: "pause" }>[] = [];
    const pending = new Map<
      string,
      readonly (ActionDispatch | WaitDispatch)[]
    >();
    const laneScope = (lane: WorkflowLane): Scope => ({
      segments: [...groupSegments, { id: lane.id }],
      frames: scope.frames,
    });
    const started = (lane: WorkflowLane): boolean => {
      const prefix = `${keyOf(groupSegments, lane.id)}.`;
      for (const key of this.state.steps.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      for (const key of this.state.inFlight ?? []) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    };
    const lanes = new Map(node.lanes.map((lane) => [lane.id, lane]));
    const classify = (lane: WorkflowLane, path: readonly string[]): void => {
      if (laneStatus.has(lane.id)) return;
      // The compiler rejects a cycle; a document that has one anyway is refused.
      if (path.includes(lane.id)) {
        throw new WorkflowInterpreterError("document_invalid");
      }
      for (const need of lane.needs) {
        const prerequisite = lanes.get(need);
        if (!prerequisite) {
          throw new WorkflowInterpreterError("document_invalid");
        }
        classify(prerequisite, [...path, lane.id]);
      }
      // A lane whose prerequisites are not all done does not start; one whose
      // prerequisite failed (or itself waits on one that did) never will.
      if (lane.needs.some((need) => laneStatus.get(need) !== "done")) {
        laneStatus.set(lane.id, "waiting");
        return;
      }
      const inner = laneScope(lane);
      const walk = this.walkList(lane.steps, inner);
      if (walk.t === "halt") {
        laneStatus.set(lane.id, "failed");
        halts.set(lane.id, walk);
      } else if (walk.t === "pause") {
        // Not failed and not done: the lane waits on a decision, and so do the
        // lanes that need it.
        laneStatus.set(lane.id, "waiting");
        pauses.push(walk);
      } else if (walk.t === "done") {
        const exports: Record<string, JsonValue> = {};
        for (
          const [name, value] of Object.entries(node.outputs[lane.id] ?? {})
        ) {
          exports[name] = evaluateValue(value, this.reader(inner));
        }
        this.laneExports.set(keyOf(groupSegments, lane.id), exports);
        laneStatus.set(lane.id, "done");
      } else {
        laneStatus.set(lane.id, "active");
        pending.set(
          lane.id,
          walk.t === "pending" ? [walk.step] : walk.steps,
        );
      }
    };
    for (const lane of node.lanes) classify(lane, []);

    const failed = node.lanes.filter((lane) =>
      laneStatus.get(lane.id) === "failed"
    );
    const active = node.lanes.filter((lane) =>
      laneStatus.get(lane.id) === "active"
    );
    const running = active.filter(started);
    // Free slots go to the first lanes, in authored order, that are ready and
    // have not started. A lane with a failed prerequisite (or one waiting on
    // such a lane) is never ready, so a failure costs only its dependants.
    const room = Math.max(0, node.maxConcurrency - running.length);
    const fresh = active.filter((lane) => !started(lane)).slice(0, room);
    const chosen = new Set([...running, ...fresh].map((lane) => lane.id));
    const steps = active.filter((lane) => chosen.has(lane.id)).flatMap((lane) =>
      pending.get(lane.id)!
    );
    if (steps.length > 0) return { t: "pending_many", steps };
    if (failed.length > 0) return halts.get(failed[0]!.id)!;
    if (pauses.length > 0) return pauses[0]!;
    if (node.lanes.every((lane) => laneStatus.get(lane.id) === "done")) {
      return { t: "done" };
    }
    // Lanes are waiting with nothing running and nothing failed: only a
    // document with a cycle gets here.
    throw new WorkflowInterpreterError("document_invalid");
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
      // `until` is not asked before round `min`: those rounds run regardless.
      if (
        iterations >= (this.loopBounds ? node.min ?? 0 : 0) &&
        evaluateCondition(node.until, this.reader(checking))
      ) {
        outcome = "completed";
        break;
      }
      const extra = this.state.repeatExtra?.[key] ?? 0;
      // A repeat with an `allow` is held to its `max` however much the host
      // adds; one without keeps the document's bound plus the host's allowance.
      const soft = this.loopBounds ? node.allow : undefined;
      const allowed = soft === undefined
        ? node.max + extra
        : Math.min(soft + extra, node.max);
      if (iterations === allowed) {
        if (soft !== undefined && allowed < node.max) {
          return { t: "pause", key, iterations, allowed, max: node.max };
        }
        outcome = "exhausted";
        break;
      }
      const number = iterations + 1;
      const body: Scope = {
        segments: [...scope.segments, { id: node.id, iteration: number }],
        frames: [...scope.frames, { node, iteration: number, candidate }],
      };
      const walk = this.walkList(node.steps, body);
      if (
        walk.t === "pending" || walk.t === "pending_many" ||
        walk.t === "pause"
      ) return walk;
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
 * calls this once per step. The answer is counted with every reference
 * expanded; past `MAX_CLONE_NODES` values this throws `state_too_large`.
 *
 * Prototypes are part of the answer's frozen shape (pinned in
 * tests/unit/workflow-interpreter-state-boundary_test.ts). An object the
 * interpreter builds from a mapping, such as a dispatch's `input`, has no
 * prototype, so a key named `toString` or `constructor` is only data. An object
 * it copies from recorded state keeps the ordinary prototype it had. The copy
 * keeps each object's prototype and never substitutes one.
 */
export function nextStep(
  document: WorkflowSemanticDocument,
  state: RunState,
): NextStep {
  return cloneJson(new Run(document, state).next()) as NextStep;
}

/**
 * Interpreter revision 2: revision 1 plus bounded parallel groups. A plan
 * without a parallel group gets the answers revision 1 gives; inside a group
 * the answer is a set of steps (`dispatch_many`), see `NextStep`. Everything
 * said of `nextStep` holds, including the prototypes of the objects it builds
 * and copies, and `state.inFlight` is read.
 */
export function nextStepWithGroups(
  document: WorkflowSemanticDocument,
  state: RunState,
): NextStep {
  return cloneJson(new Run(document, state, true).next()) as NextStep;
}

/**
 * The loop-bounds revision: the previous revision plus a repeat's `min` (rounds
 * that run even when `until` already holds) and `allow` (a soft cap below
 * `max` at which the run pauses for a limit decision, never past `max`). A
 * plan whose repeats name neither gets the previous revision's answers, and
 * earlier revisions ignore both fields, so no pinned run changes.
 */
export function nextStepWithLoopBounds(
  document: WorkflowSemanticDocument,
  state: RunState,
): NextStep {
  return cloneJson(new Run(document, state, true, true).next()) as NextStep;
}
