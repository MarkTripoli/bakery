import { z } from "zod";
import {
  COORDINATION_KEY_PATTERN,
  type CoordinationPlanSpec,
  MAX_COORDINATION_CONCURRENCY,
  MAX_COORDINATION_LANES,
} from "./coordination-plan.ts";

// Pure mapper from a published workflow version's `parallel` node to a
// coordination plan spec. The saved-workflow entry hands the result to the same
// create command ad hoc and ticket plans use; no second engine exists.

export type WorkflowMappingCode =
  | "workflow_node_not_parallel"
  | "workflow_lane_key_unmappable"
  | "workflow_node_exceeds_coordination_limits";

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
 * Maps a parallel node to a plan spec. Lane ids and export names become
 * lowercase hyphenated keys (`_` to `-`); a key that still fails the
 * coordination pattern or collides is refused, never renamed further. A lane
 * over the coordination limits is refused, never truncated.
 */
export function mapParallelNodeToPlanSpec(
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
