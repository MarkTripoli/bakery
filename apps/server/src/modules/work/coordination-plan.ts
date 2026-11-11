import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

/** Stable lane and output keys: lowercase words joined by hyphens. */
export const COORDINATION_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const MAX_COORDINATION_LANES = 32;
export const MAX_COORDINATION_CONCURRENCY = 16;

const keySchema = z.string().regex(COORDINATION_KEY_PATTERN).describe(
  "Stable lowercase key of up to 63 characters (letters, digits and hyphens, starting with a letter) that names a lane, repository alias or declared output inside one plan.",
);

export const CoordinationOutputSpecSchema = z.object({
  key: keySchema.describe(
    "Key of the typed output this lane promises to commit; downstream lanes name it in their inputs.",
  ),
  kind: z.literal("artifact").describe(
    "Kind of output: an immutable artifact published on the lane's child task under the same name as the key.",
  ),
  artifactType: z.enum([
    "research",
    "plan",
    "design",
    "check",
    "review",
    "log",
    "image",
    "patch",
    "other",
  ]).default("patch").describe(
    "Artifact type the committed artifact must have, one of the platform artifact types; the handoff matches the artifact by this type and the output key, never by name alone.",
  ),
}).strict().describe(
  "One typed output a lane declares; a dependant lane starts only after the committed artifact exists.",
);

export const CoordinationInputSpecSchema = z.object({
  fromLane: keySchema.describe(
    "Key of the upstream lane that produces the input; it must be a prerequisite, direct or transitive.",
  ),
  outputKey: keySchema.describe(
    "Key of the output the upstream lane declares and this lane consumes as a typed artifact reference.",
  ),
}).strict().describe(
  "Typed handoff from an upstream lane's declared output into this lane.",
);

export const CoordinationLaneSpecSchema = z.object({
  key: keySchema.describe("Unique key of this lane within the plan."),
  repositoryAlias: keySchema.describe(
    "Application repository alias this lane works in; it must resolve to exactly one repository of the application.",
  ),
  title: z.string().trim().min(1).max(500).describe(
    "Human-readable title copied onto the lane's child task.",
  ),
  instructions: z.string().max(20000).describe(
    "Instructions for the agent working this lane, copied onto the child task description.",
  ),
  prerequisites: z.array(keySchema).max(MAX_COORDINATION_LANES).describe(
    "Keys of lanes that must complete, with their declared outputs committed, before this lane may start.",
  ),
  outputs: z.array(CoordinationOutputSpecSchema).max(16).describe(
    "Typed outputs this lane declares for dependants.",
  ),
  inputs: z.array(CoordinationInputSpecSchema).max(32).describe(
    "Typed handoffs this lane consumes from upstream lanes.",
  ),
}).strict().describe(
  "One repository-specific unit of work that materializes as one child task.",
);

export const CoordinationPlanSpecSchema = z.object({
  lanes: z.array(CoordinationLaneSpecSchema).min(1).max(MAX_COORDINATION_LANES)
    .describe("Named lanes of the plan; lane keys are unique."),
  maxConcurrency: z.number().int().min(1).max(MAX_COORDINATION_CONCURRENCY)
    .describe(
      "Requested most lanes running at once. Recorded with the plan for coordinators and readers; lane admission does not enforce it yet and is bounded by prerequisites, worker capacity and the shared plan budget.",
    ),
  join: z.literal("all-required").describe(
    "Join policy: the parent completes only after every required lane completes.",
  ),
  failurePolicy: z.literal("stop-dependent").describe(
    "Failure policy: a failed lane stops its dependants while independent lanes may finish.",
  ),
}).strict().describe(
  "Immutable ad hoc multi-repository coordination plan: lanes, prerequisites, typed handoffs, concurrency, join and failure policy.",
);

export type CoordinationPlanSpec = z.output<typeof CoordinationPlanSpecSchema>;

const originReferenceSchema = z.string().trim().min(1).max(200).describe(
  "Provider-side reference of the ticket, such as an issue key or number, as the caller claims it; the server does not verify it.",
);

export const CoordinationPlanOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ad_hoc").describe(
      "Tag marking a plan a person or the coordinator composed directly in a conversation.",
    ),
  }).strict().describe(
    "Origin of a plan composed directly in a conversation rather than from a saved workflow or a ticket.",
  ),
  z.object({
    kind: z.literal("saved_workflow").describe(
      "Tag marking a plan mapped from a parallel node of a published workflow version.",
    ),
    workflowId: z.string().uuid().describe(
      "Identifier of the workflow definition that owns the published version.",
    ),
    workflowVersionId: z.string().uuid().describe(
      "Identifier of the exact published workflow version the plan was mapped from.",
    ),
    nodeId: z.string().trim().min(1).max(64).describe(
      "Identifier of the parallel node in the workflow version that was mapped to lanes.",
    ),
  }).strict().describe(
    "Origin of a plan mapped from one parallel node of a published workflow version; the server sets it, callers cannot claim it on create.",
  ),
  z.object({
    kind: z.literal("ticket").describe(
      "Tag marking a plan that a ticket in an external tracker asked for.",
    ),
    provider: z.string().trim().min(1).max(64).describe(
      "Name of the ticket provider as the caller claims it, such as github or jira; the server does not verify it.",
    ),
    reference: originReferenceSchema,
    url: z.string().max(2048).refine((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, { message: "ticket url must be an https URL" }).optional().describe(
      "Optional https link to the ticket, at most 2048 characters; shown as claimed by the caller, never fetched.",
    ),
  }).strict().describe(
    "Origin of a plan a ticket asked for; provider, reference and link are claims by the caller and are not verified.",
  ),
]).describe(
  "Where a coordination plan came from: ad hoc conversation, saved workflow node or ticket. Origin labels the plan and never changes its semantics, digest or lane identities.",
);

export type CoordinationPlanOrigin = z.output<
  typeof CoordinationPlanOriginSchema
>;

export const AD_HOC_ORIGIN: CoordinationPlanOrigin = Object.freeze({
  kind: "ad_hoc",
});

/**
 * Canonical comparison key of an origin (key order never matters). Saved
 * workflow origins compare by workflow and node, not by version: republishing
 * a workflow whose node maps to the same spec is the same request, so it
 * replays the existing plan instead of conflicting with it.
 */
export async function coordinationOriginKey(
  origin: CoordinationPlanOrigin,
): Promise<string> {
  const family = origin.kind === "saved_workflow"
    ? {
      kind: origin.kind,
      workflowId: origin.workflowId,
      nodeId: origin.nodeId,
    }
    : origin;
  return await sha256Hex(canonicalJson(family));
}

export type CoordinationLaneSpec = z.output<typeof CoordinationLaneSpecSchema>;

export type AliasCandidate = Readonly<{ repositoryId: string; role: string }>;
export type CoordinationScope = Readonly<{
  /** Alias -> repositories the application's roles map it to. */
  aliases: ReadonlyMap<string, readonly AliasCandidate[]>;
  /**
   * Repositories the parent task explicitly links. Null means the parent
   * declares no links and the application's aliased repositories are the scope.
   */
  linkedRepositoryIds: ReadonlySet<string> | null;
  /** Repositories of the plan's application. */
  applicationRepositoryIds: ReadonlySet<string>;
}>;

export type CoordinationIssue = Readonly<{
  path: readonly (string | number)[];
  code:
    | "duplicate_lane_key"
    | "self_prerequisite"
    | "prerequisite_unknown"
    | "dependency_cycle"
    | "alias_unknown"
    | "alias_ambiguous"
    | "repository_foreign"
    | "repository_out_of_scope"
    | "shared_writable_checkout"
    | "input_not_declared_upstream"
    | "output_duplicate";
}>;

export type ResolvedLane = Readonly<{
  spec: CoordinationLaneSpec;
  repositoryId: string;
  laneDigest: string;
}>;

/** Thrown with every structural problem found; no repository is guessed. */
export class CoordinationPlanInvalidError extends Error {
  override readonly name = "CoordinationPlanInvalidError";
  readonly issues: readonly CoordinationIssue[];
  constructor(issues: readonly CoordinationIssue[]) {
    super(`coordination plan invalid: ${issues.map((i) => i.code).join(",")}`);
    this.issues = issues;
  }
}

export function topologicalOrder(
  lanes: readonly CoordinationLaneSpec[],
): { order: string[]; cyclic: boolean } {
  const byKey = new Map(lanes.map((lane) => [lane.key, lane]));
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  let cyclic = false;
  const visit = (key: string) => {
    const current = state.get(key);
    if (current === "done") return;
    if (current === "visiting") {
      cyclic = true;
      return;
    }
    state.set(key, "visiting");
    for (const prerequisite of byKey.get(key)?.prerequisites ?? []) {
      if (byKey.has(prerequisite)) visit(prerequisite);
    }
    state.set(key, "done");
    order.push(key);
  };
  for (const lane of lanes) visit(lane.key);
  return { order, cyclic };
}

function ancestors(
  lanes: readonly CoordinationLaneSpec[],
): Map<string, Set<string>> {
  const byKey = new Map(lanes.map((lane) => [lane.key, lane]));
  const memo = new Map<string, Set<string>>();
  const walk = (key: string, seen: Set<string>): Set<string> => {
    const cached = memo.get(key);
    if (cached) return cached;
    const result = new Set<string>();
    if (seen.has(key)) return result;
    seen.add(key);
    for (const prerequisite of byKey.get(key)?.prerequisites ?? []) {
      if (!byKey.has(prerequisite)) continue;
      result.add(prerequisite);
      for (const upstream of walk(prerequisite, seen)) result.add(upstream);
    }
    seen.delete(key);
    memo.set(key, result);
    return result;
  };
  for (const lane of lanes) walk(lane.key, new Set());
  return memo;
}

/**
 * Structural validation that needs no database: keys, prerequisites, cycles
 * and typed handoffs. Alias and scope checks live in `resolveCoordinationPlan`.
 */
export function validateCoordinationStructure(
  spec: CoordinationPlanSpec,
): CoordinationIssue[] {
  const issues: CoordinationIssue[] = [];
  const keys = new Set<string>();
  spec.lanes.forEach((lane, index) => {
    if (keys.has(lane.key)) {
      issues.push({
        path: ["lanes", index, "key"],
        code: "duplicate_lane_key",
      });
    }
    keys.add(lane.key);
  });
  spec.lanes.forEach((lane, index) => {
    lane.prerequisites.forEach((prerequisite, position) => {
      const path = ["lanes", index, "prerequisites", position] as const;
      if (prerequisite === lane.key) {
        issues.push({ path, code: "self_prerequisite" });
      } else if (!keys.has(prerequisite)) {
        issues.push({ path, code: "prerequisite_unknown" });
      }
    });
    const seenOutputs = new Set<string>();
    lane.outputs.forEach((output, position) => {
      if (seenOutputs.has(output.key)) {
        issues.push({
          path: ["lanes", index, "outputs", position, "key"],
          code: "output_duplicate",
        });
      }
      seenOutputs.add(output.key);
    });
  });
  if (issues.length === 0 && topologicalOrder(spec.lanes).cyclic) {
    issues.push({ path: ["lanes"], code: "dependency_cycle" });
  }
  if (issues.length > 0) return issues;
  const upstream = ancestors(spec.lanes);
  const byKey = new Map(spec.lanes.map((lane) => [lane.key, lane]));
  spec.lanes.forEach((lane, index) => {
    lane.inputs.forEach((input, position) => {
      const source = byKey.get(input.fromLane);
      const declared = source?.outputs.some((output) =>
        output.key === input.outputKey
      ) ?? false;
      if (
        !source || !upstream.get(lane.key)?.has(input.fromLane) || !declared
      ) {
        issues.push({
          path: ["lanes", index, "inputs", position],
          code: "input_not_declared_upstream",
        });
      }
    });
  });
  return issues;
}

/**
 * Resolves aliases to concrete repositories and rejects, without selecting a
 * target on the caller's behalf: unknown or ambiguous aliases, repositories
 * outside the application or the parent's links, cycles, undeclared handoffs
 * and two writer lanes on one repository (a shared writable checkout).
 */
export async function resolveCoordinationPlan(
  spec: CoordinationPlanSpec,
  scope: CoordinationScope,
): Promise<readonly ResolvedLane[]> {
  const issues = validateCoordinationStructure(spec);
  const repositoryByLane = new Map<string, string>();
  const laneIndexByRepository = new Map<string, number>();
  spec.lanes.forEach((lane, index) => {
    const path = ["lanes", index, "repositoryAlias"] as const;
    const candidates = scope.aliases.get(lane.repositoryAlias) ?? [];
    const distinct = [...new Set(candidates.map((c) => c.repositoryId))];
    if (distinct.length === 0) {
      issues.push({ path, code: "alias_unknown" });
      return;
    }
    if (distinct.length > 1) {
      issues.push({ path, code: "alias_ambiguous" });
      return;
    }
    const repositoryId = distinct[0];
    if (!scope.applicationRepositoryIds.has(repositoryId)) {
      issues.push({ path, code: "repository_foreign" });
      return;
    }
    if (
      scope.linkedRepositoryIds !== null &&
      !scope.linkedRepositoryIds.has(repositoryId)
    ) {
      issues.push({ path, code: "repository_out_of_scope" });
      return;
    }
    if (laneIndexByRepository.has(repositoryId)) {
      issues.push({ path, code: "shared_writable_checkout" });
      return;
    }
    laneIndexByRepository.set(repositoryId, index);
    repositoryByLane.set(lane.key, repositoryId);
  });
  if (issues.length > 0) throw new CoordinationPlanInvalidError(issues);

  const digests = new Map<string, string>();
  const byKey = new Map(spec.lanes.map((lane) => [lane.key, lane]));
  for (const key of topologicalOrder(spec.lanes).order) {
    const lane = byKey.get(key) as CoordinationLaneSpec;
    // The digest folds in upstream digests so a changed upstream lane
    // invalidates every dependant instead of reusing stale handoffs.
    digests.set(
      key,
      await sha256Hex(canonicalJson({
        lane,
        repositoryId: repositoryByLane.get(key),
        upstream: [...lane.prerequisites].sort().map((p) => digests.get(p)),
      })),
    );
  }
  return spec.lanes.map((lane) => ({
    spec: lane,
    repositoryId: repositoryByLane.get(lane.key) as string,
    laneDigest: digests.get(lane.key) as string,
  }));
}

export async function coordinationPlanDigest(
  spec: CoordinationPlanSpec,
): Promise<string> {
  return await sha256Hex(canonicalJson(spec));
}

export type LaneStatus =
  | "planned"
  | "ready"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "canceled"
  /**
   * The lane's child completed, but an input it consumed is no longer the
   * upstream lane's current committed output. Needs rework in a new revision.
   */
  | "stale";
export type PlanStatus =
  | "planned"
  | "materialized"
  | "completed"
  | "partially_delivered"
  | "failed"
  | "canceled"
  | "superseded";

/**
 * Parent projection. All required lanes completed -> completed. A failed lane
 * stops its dependants (stop-dependent); independent lanes continue. Once
 * nothing can still run, the parent is partially delivered when any lane
 * delivered, otherwise failed. The parent never reports success while a
 * required lane is incomplete.
 */
export function projectLaneStatuses(
  lanes: readonly Readonly<{
    key: string;
    prerequisites: readonly string[];
    status: LaneStatus;
  }>[],
): { lanes: Map<string, LaneStatus>; plan: PlanStatus } {
  const byKey = new Map(lanes.map((lane) => [lane.key, lane]));
  const resolved = new Map<string, LaneStatus>();
  const staleAncestor = (key: string): boolean => {
    const visited = new Set<string>();
    const pending = [...byKey.get(key)?.prerequisites ?? []];
    while (pending.length > 0) {
      const next = pending.pop() as string;
      if (visited.has(next)) continue;
      visited.add(next);
      const upstream = byKey.get(next);
      if (upstream?.status === "stale") return true;
      pending.push(...upstream?.prerequisites ?? []);
    }
    return false;
  };
  const resolve = (key: string, seen: Set<string>): LaneStatus => {
    const known = resolved.get(key);
    if (known) return known;
    const lane = byKey.get(key);
    if (!lane || seen.has(key)) return "stopped";
    seen.add(key);
    let status = lane.status;
    if (status !== "completed" && status !== "canceled") {
      for (const prerequisite of lane.prerequisites) {
        const upstream = resolve(prerequisite, seen);
        if (
          upstream === "failed" || upstream === "stopped" ||
          upstream === "canceled"
        ) status = "stopped";
      }
    }
    // A materialized (ready) lane whose prerequisites have not all completed
    // waits; an early start is refused (lane_prerequisite_incomplete).
    if (status === "ready") {
      for (const prerequisite of lane.prerequisites) {
        if (resolve(prerequisite, seen) !== "completed") status = "waiting";
      }
      // A stale lane anywhere upstream also holds it back: admission refuses
      // the run until the stale work is redone.
      if (status === "ready" && staleAncestor(lane.key)) status = "waiting";
    }
    seen.delete(key);
    resolved.set(key, status);
    return status;
  };
  for (const lane of lanes) resolve(lane.key, new Set());
  const statuses = [...resolved.values()];
  if (statuses.every((status) => status === "completed")) {
    return { lanes: resolved, plan: "completed" };
  }
  const running = (s: LaneStatus) =>
    s === "planned" || s === "ready" || s === "waiting" || s === "running";
  const delivered = (s: LaneStatus) => s === "completed" || s === "stale";
  const inflight = statuses.some(running);
  if (statuses.some((status) => status === "canceled") && !inflight) {
    return {
      lanes: resolved,
      plan: statuses.some(delivered) ? "partially_delivered" : "canceled",
    };
  }
  if (inflight) return { lanes: resolved, plan: "materialized" };
  // A stale lane keeps the parent open for rework while nothing failed; once
  // a lane failed or stopped, the failure rules decide as before.
  if (
    statuses.includes("stale") &&
    !statuses.some((s) => s === "failed" || s === "stopped")
  ) return { lanes: resolved, plan: "materialized" };
  return {
    lanes: resolved,
    plan: statuses.some(delivered) ? "partially_delivered" : "failed",
  };
}
