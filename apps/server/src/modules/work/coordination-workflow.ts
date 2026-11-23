import { z } from "zod";
import {
  COORDINATION_KEY_PATTERN,
  type CoordinationPlanSpec,
  jsonBytes,
  MAX_AUTHORED_EXPORTS_BYTES,
  MAX_AUTHORED_STEPS,
  MAX_AUTHORED_STEPS_BYTES,
  MAX_COORDINATION_CONCURRENCY,
  MAX_COORDINATION_LANES,
} from "./coordination-plan.ts";

// Pure lowering between a published workflow version's `parallel` node and a
// split (a coordination plan spec), in both directions. The saved-workflow entry
// hands the lowered spec to the same create command ad hoc and ticket plans use;
// no second engine exists. The lowering keeps every lane's authored id, steps and
// exports next to the plan's own fields, so raising a lowered node gives back the
// node the author wrote (#422); the lane instructions are only the child's brief.

export type WorkflowMappingCode =
  | "workflow_node_not_parallel"
  | "workflow_lane_key_unmappable"
  | "workflow_node_exceeds_coordination_limits"
  /** The published definition no longer compiles, so no node can be read. */
  | "workflow_not_compilable";

/** Typed refusal of a workflow node the coordination boundary cannot take. */
export class WorkflowMappingError extends Error {
  override readonly name = "WorkflowMappingError";
  readonly code: WorkflowMappingCode;
  readonly path: readonly (string | number)[];
  constructor(code: WorkflowMappingCode, path: readonly (string | number)[]) {
    super(`${code} at ${path.join(".")}`);
    this.code = code;
    this.path = path;
  }
}

const identifierSchema = z.string().min(1).max(64).describe(
  "Workflow node or lane identifier as authored in the published workflow version.",
);

const ParallelNodeSchema = z.object({
  kind: z.literal("parallel").describe("Tag marking a bounded parallel group."),
  id: identifierSchema,
  maxConcurrency: z.number().int().min(1).describe(
    "Maximum lanes the parallel group runs at once, copied onto the plan.",
  ),
  join: z.literal("all-required").describe(
    "Join policy: every lane must succeed.",
  ),
  failurePolicy: z.literal("stop-dependent").describe(
    "Failure policy: stop lanes that depend on a failed lane.",
  ),
  lanes: z.array(
    z.object({
      id: identifierSchema,
      needs: z.array(identifierSchema).describe(
        "Identifiers of lanes that must finish before this lane starts.",
      ),
      repository: z.string().describe(
        "Repository alias the lane runs against, mapped one to one to a coordination repository alias.",
      ),
      steps: z.array(z.unknown().describe("One authored workflow node."))
        .describe(
          "Ordered steps of the lane, rendered into the lane instructions.",
        ),
    }).passthrough().describe(
      "One named lane of the parallel group.",
    ),
  ).min(1).describe("Lanes in authored order."),
  outputs: z.record(
    z.string().describe("Lane identifier the exports belong to."),
    z.record(
      z.string().describe("Export name of the lane."),
      z.unknown().describe("Exported value node; only its name is mapped."),
    ).describe("Exports of one lane keyed by export name."),
  ).default({}).describe("Typed exports keyed by lane identifier."),
}).passthrough().describe(
  "Parallel node of a normalized workflow version, read only as far as the coordination mapping needs.",
);

export type ParallelNode = z.output<typeof ParallelNodeSchema>;

/** Finds the node with this id anywhere in the normalized workflow document. */
export function findParallelNode(
  document: unknown,
  nodeId: string,
): ParallelNode {
  const matches: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.kind === "string" && record.id === nodeId) {
      matches.push(record);
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(document, 0);
  const parallel = matches.find((node) => node.kind === "parallel");
  const parsed = ParallelNodeSchema.safeParse(parallel);
  if (!parsed.success) {
    throw new WorkflowMappingError("workflow_node_not_parallel", ["nodeId"]);
  }
  return parsed.data;
}

function normalizeKey(
  value: string,
  path: readonly (string | number)[],
): string {
  const key = value.toLowerCase().replaceAll("_", "-");
  if (!COORDINATION_KEY_PATTERN.test(key)) {
    throw new WorkflowMappingError("workflow_lane_key_unmappable", path);
  }
  return key;
}

function renderSteps(
  steps: readonly unknown[],
  lines: string[],
  depth: number,
): void {
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const node = step as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id : "?";
    const kind = typeof node.kind === "string" ? node.kind : "step";
    const label = kind === "action" && typeof node.action === "string"
      ? `${id}: ${node.action}`
      : `${id} (${kind})`;
    lines.push(`${"  ".repeat(depth)}- ${label}`);
    for (const nested of ["steps", "then", "else"] as const) {
      if (Array.isArray(node[nested])) {
        renderSteps(node[nested] as unknown[], lines, depth + 1);
      }
    }
    const seed = node.seed;
    if (seed && typeof seed === "object") {
      const seedSteps = (seed as { steps?: unknown }).steps;
      if (Array.isArray(seedSteps)) renderSteps(seedSteps, lines, depth + 1);
    }
  }
}

const MAX_OUTPUTS_PER_LANE = 16;
const MAX_INPUTS_PER_LANE = 32;
const MAX_INSTRUCTIONS = 20000;

/**
 * Lowers a parallel node to a split. Lane ids and export names become
 * lowercase hyphenated keys (`_` to `-`); a key that still fails the
 * coordination pattern or collides is refused, never renamed further. A lane
 * over the coordination limits is refused, never truncated.
 */
export function lowerParallelNode(
  node: ParallelNode,
): CoordinationPlanSpec {
  if (
    node.lanes.length > MAX_COORDINATION_LANES ||
    node.maxConcurrency > MAX_COORDINATION_CONCURRENCY
  ) {
    throw new WorkflowMappingError(
      "workflow_node_exceeds_coordination_limits",
      ["lanes"],
    );
  }
  const keyByLane = new Map<string, string>();
  const taken = new Set<string>();
  node.lanes.forEach((lane, index) => {
    const key = normalizeKey(lane.id, ["lanes", index, "id"]);
    if (taken.has(key)) {
      throw new WorkflowMappingError(
        "workflow_lane_key_unmappable",
        ["lanes", index, "id"],
      );
    }
    taken.add(key);
    keyByLane.set(lane.id, key);
  });
  const outputsByLane = new Map<string, string[]>();
  node.lanes.forEach((lane, index) => {
    const names = Object.keys(node.outputs[lane.id] ?? {});
    if (names.length > MAX_OUTPUTS_PER_LANE) {
      throw new WorkflowMappingError(
        "workflow_node_exceeds_coordination_limits",
        ["lanes", index, "outputs"],
      );
    }
    const keys: string[] = [];
    for (const name of names) {
      const key = normalizeKey(name, ["outputs", lane.id, name]);
      if (keys.includes(key)) {
        throw new WorkflowMappingError(
          "workflow_lane_key_unmappable",
          ["outputs", lane.id, name],
        );
      }
      keys.push(key);
    }
    outputsByLane.set(lane.id, keys);
  });
  const lanes = node.lanes.map((lane, index) => {
    if (!COORDINATION_KEY_PATTERN.test(lane.repository)) {
      throw new WorkflowMappingError(
        "workflow_lane_key_unmappable",
        ["lanes", index, "repository"],
      );
    }
    const prerequisites = lane.needs.map((need) =>
      keyByLane.get(need) ?? normalizeKey(need, ["lanes", index, "needs"])
    );
    const inputs = lane.needs.flatMap((need) =>
      (outputsByLane.get(need) ?? []).map((outputKey) => ({
        fromLane: keyByLane.get(need) as string,
        outputKey,
      }))
    );
    if (inputs.length > MAX_INPUTS_PER_LANE) {
      throw new WorkflowMappingError(
        "workflow_node_exceeds_coordination_limits",
        ["lanes", index, "inputs"],
      );
    }
    const lines: string[] = [`Workflow lane ${lane.id}, steps in order:`];
    renderSteps(lane.steps, lines, 0);
    // The same bounds, measured the same way, as the schema the lowered lane
    // must then pass: a lane over them is refused here, never cut.
    const stepsTooBig = lane.steps.length > MAX_AUTHORED_STEPS ||
      jsonBytes(lane.steps) > MAX_AUTHORED_STEPS_BYTES;
    const exportsTooBig =
      jsonBytes(node.outputs[lane.id] ?? {}) > MAX_AUTHORED_EXPORTS_BYTES;
    if (stepsTooBig || exportsTooBig) {
      throw new WorkflowMappingError(
        "workflow_node_exceeds_coordination_limits",
        ["lanes", index, stepsTooBig ? "steps" : "outputs"],
      );
    }
    const instructions = lines.join("\n");
    if (instructions.length > MAX_INSTRUCTIONS) {
      throw new WorkflowMappingError(
        "workflow_node_exceeds_coordination_limits",
        ["lanes", index, "instructions"],
      );
    }
    return {
      key: keyByLane.get(lane.id) as string,
      repositoryAlias: lane.repository,
      title: lane.id,
      instructions,
      authored: {
        id: lane.id,
        steps: lane.steps,
        ...(node.outputs[lane.id] === undefined
          ? {}
          : { exports: node.outputs[lane.id] }),
      },
      prerequisites,
      outputs: (outputsByLane.get(lane.id) ?? []).map((key) => ({
        key,
        kind: "artifact" as const,
        artifactType: "patch" as const,
      })),
      inputs,
    };
  });
  return {
    lanes,
    maxConcurrency: node.maxConcurrency,
    join: node.join,
    failurePolicy: node.failurePolicy,
  };
}

/**
 * Raises a split to the parallel node it lowers from: the inverse of
 * `lowerParallelNode` for everything the split owns (lanes, their order,
 * prerequisites, repositories, steps, exports, concurrency, join and failure
 * policy). A lane without an authored record, one an agent or a person composed
 * directly, takes its key for its id, no steps, and an empty export for each
 * declared output. Node-level wiring (`needs`, `if`) belongs to the parent run's
 * graph, not to the split, so it is not here.
 */
export function raiseToParallelNode(
  spec: CoordinationPlanSpec,
  nodeId: string,
): ParallelNode {
  const idByKey = new Map(
    spec.lanes.map((lane) => [lane.key, lane.authored?.id ?? lane.key]),
  );
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const lane of spec.lanes) {
    const id = idByKey.get(lane.key) as string;
    if (lane.authored !== undefined) {
      if (lane.authored.exports !== undefined) {
        outputs[id] = { ...lane.authored.exports };
      }
    } else if (lane.outputs.length > 0) {
      outputs[id] = Object.fromEntries(lane.outputs.map((o) => [o.key, {}]));
    }
  }
  return {
    kind: "parallel",
    id: nodeId,
    maxConcurrency: spec.maxConcurrency,
    join: spec.join,
    failurePolicy: spec.failurePolicy,
    lanes: spec.lanes.map((lane) => ({
      id: idByKey.get(lane.key) as string,
      needs: lane.prerequisites.map((key) => idByKey.get(key) as string),
      repository: lane.repositoryAlias,
      steps: lane.authored?.steps ?? [],
    })),
    outputs,
  };
}
