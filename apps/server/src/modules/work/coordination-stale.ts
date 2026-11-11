import type { PgTransactionClient } from "../../platform/database.ts";

// Stale-input rules for coordination lanes. Runs record the exact artifact
// version id and sha256 of every input they consumed (coordination-admission
// freezes them into the run snapshot). A lane whose child completed is stale
// when any consumed input version is no longer the current committed version
// of the upstream lane's output. Artifact ids are never compared: a new
// version replaces an artifact's current version under the same id.

/** Input version a lane's run consumed, as frozen into the run snapshot. */
export type ConsumedInput = Readonly<{
  fromLane: string;
  outputKey: string;
  artifactVersionId: string;
  sha256: string;
}>;

/** Current committed version of an upstream output, or null when none. */
export type CurrentOutput = Readonly<{ versionId: string; sha256: string }>;

/** Lane facts the stale check needs; independent of any database row type. */
export type StaleLaneFacts = Readonly<{
  key: string;
  prerequisites: readonly string[];
  /** True once the lane's child task completed. */
  completed: boolean;
  /** True when the lane declares typed inputs, so a completed lane must have consumed some. */
  expectsInputs: boolean;
  /** Inputs of the child's latest completed run; empty when it consumed none. */
  consumed: readonly ConsumedInput[];
}>;

/** Key of one upstream output inside a `CurrentOutput` lookup. */
export function outputLookupKey(laneKey: string, outputKey: string): string {
  return `${laneKey}\u0000${outputKey}`;
}

/** True when a consumed input is no longer the upstream's current output. */
export function isInputStale(
  input: ConsumedInput,
  current: ReadonlyMap<string, CurrentOutput | null>,
): boolean {
  const now = current.get(outputLookupKey(input.fromLane, input.outputKey));
  return !now || now.versionId !== input.artifactVersionId ||
    now.sha256 !== input.sha256;
}

/**
 * The one stale check shared by projection, reconcile, admission and reuse:
 * lane keys whose completed child consumed an input that is no longer current.
 * A lane that declares inputs but has no recorded consumed versions is stale:
 * nothing proves it saw the current upstream outputs. A lane that declares no
 * inputs is never stale.
 */
export function findStaleLanes(
  lanes: readonly StaleLaneFacts[],
  current: ReadonlyMap<string, CurrentOutput | null>,
): Set<string> {
  const stale = new Set<string>();
  for (const lane of lanes) {
    if (!lane.completed) continue;
    if (
      (lane.expectsInputs && lane.consumed.length === 0) ||
      lane.consumed.some((input) => isInputStale(input, current))
    ) {
      stale.add(lane.key);
    }
  }
  return stale;
}

/** True when any lane upstream of `laneKey`, direct or transitive, is stale. */
export function hasStaleUpstream(
  laneKey: string,
  prerequisitesByKey: ReadonlyMap<string, readonly string[]>,
  stale: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  const pending = [...prerequisitesByKey.get(laneKey) ?? []];
  while (pending.length > 0) {
    const key = pending.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    if (stale.has(key)) return true;
    pending.push(...prerequisitesByKey.get(key) ?? []);
  }
  return false;
}

/** A finished run with the inputs it consumed. */
export type FinishedRunInputs = Readonly<{
  status: string;
  finishedAt: string | null;
  createdAt: string;
  id: string;
  inputs: readonly ConsumedInput[];
}>;

/**
 * Inputs of the child's latest run that reached completed: the run that made
 * the child completed. A follow-up run that completed later supersedes the
 * earlier one, so its (newer) consumed versions are the lane's consumed inputs.
 */
export function latestCompletedRunInputs(
  runs: readonly FinishedRunInputs[],
): readonly ConsumedInput[] {
  const completed = runs.filter((run) => run.status === "completed");
  if (completed.length === 0) return [];
  const order = (run: FinishedRunInputs) =>
    `${run.finishedAt ?? run.createdAt}|${run.createdAt}|${run.id}`;
  completed.sort((a, b) => order(b).localeCompare(order(a)));
  return completed[0].inputs;
}

function parseConsumed(value: unknown): ConsumedInput[] {
  if (!Array.isArray(value)) return [];
  const inputs: ConsumedInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.fromLane === "string" && typeof row.outputKey === "string" &&
      typeof row.artifactVersionId === "string" &&
      typeof row.sha256 === "string"
    ) {
      inputs.push({
        fromLane: row.fromLane,
        outputKey: row.outputKey,
        artifactVersionId: row.artifactVersionId,
        sha256: row.sha256,
      });
    }
  }
  return inputs;
}

/** Inputs of the latest completed run of each child task (empty when none). */
export async function loadConsumedInputs(
  transaction: PgTransactionClient,
  organizationId: string,
  childTaskIds: readonly string[],
): Promise<Map<string, readonly ConsumedInput[]>> {
  const result = new Map<string, readonly ConsumedInput[]>();
  if (childTaskIds.length === 0) return result;
  const rows = await transaction.query<
    {
      task_id: string;
      id: string;
      status: string;
      finished_at: string | null;
      created_at: string;
      inputs: unknown;
    }
  >(
    `select r.task_id, r.id, r.status,
            to_char(r.finished_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as finished_at,
            to_char(r.created_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            r.snapshot -> 'coordination' -> 'inputs' as inputs
       from bakery.workflow_runs r
      where r.organization_id = $1 and r.task_id = any($2::uuid[])
        and r.status = 'completed' and r.workflow_version_id is not null`,
    [organizationId, [...childTaskIds]],
  );
  const byTask = new Map<string, FinishedRunInputs[]>();
  for (const row of rows.rows) {
    const list = byTask.get(row.task_id) ?? [];
    list.push({
      status: row.status,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
      id: row.id,
      inputs: parseConsumed(row.inputs),
    });
    byTask.set(row.task_id, list);
  }
  for (const [taskId, runs] of byTask) {
    result.set(taskId, latestCompletedRunInputs(runs));
  }
  return result;
}

/** Key of one committed output inside a per-child lookup. */
export function childOutputKey(
  childTaskId: string,
  name: string,
  artifactType: string,
): string {
  return `${childTaskId}\u0000${name}\u0000${artifactType}`;
}

/**
 * Current committed artifact version of each (child task, name, type): the
 * newest artifact of that name and type whose current version is set, matching
 * the handoff lookup the lane admission freezes into runs.
 */
export async function loadCurrentOutputs(
  transaction: PgTransactionClient,
  organizationId: string,
  childTaskIds: readonly string[],
): Promise<Map<string, CurrentOutput>> {
  const current = new Map<string, CurrentOutput>();
  if (childTaskIds.length === 0) return current;
  const rows = await transaction.query<
    {
      task_id: string;
      name: string;
      artifact_type: string;
      version_id: string;
      sha256: string;
    }
  >(
    `select distinct on (a.task_id, a.name, a.artifact_type)
            a.task_id, a.name, a.artifact_type, v.id as version_id, v.sha256
       from bakery.artifacts a
       join bakery.artifact_versions v
         on v.organization_id = a.organization_id
        and v.artifact_id = a.id
        and v.id = a.current_version_id
      where a.organization_id = $1 and a.task_id = any($2::uuid[])
      order by a.task_id, a.name, a.artifact_type, a.created_at desc, a.id desc`,
    [organizationId, [...childTaskIds]],
  );
  for (const row of rows.rows) {
    current.set(childOutputKey(row.task_id, row.name, row.artifact_type), {
      versionId: row.version_id,
      sha256: row.sha256,
    });
  }
  return current;
}

/** Lane columns the stale loader reads; a subset of the persisted lane row. */
export type StaleLaneRow = Readonly<{
  lane_key: string;
  prerequisites: readonly string[];
  child_task_id: string | null;
  child_status: string | null;
  declared_outputs: unknown;
  /** Number of typed inputs the lane's plan spec declares for it. */
  declared_input_count: number;
}>;

function declaredType(
  declaredOutputs: unknown,
  outputKey: string,
): string {
  if (Array.isArray(declaredOutputs)) {
    for (const output of declaredOutputs) {
      if (output && typeof output === "object") {
        const row = output as { key?: unknown; artifactType?: unknown };
        if (row.key === outputKey) {
          return typeof row.artifactType === "string"
            ? row.artifactType
            : "patch";
        }
      }
    }
  }
  return "patch";
}

/**
 * Current committed version of the output a consumed input names: the
 * upstream lane's child (null when it has none) looked up in `outputs` by the
 * artifact type that lane declares for the output key.
 */
export function currentOutputForInput(
  outputs: ReadonlyMap<string, CurrentOutput>,
  input: ConsumedInput,
  upstreamChildTaskId: string | null | undefined,
  upstreamDeclaredOutputs: unknown,
): CurrentOutput | null {
  if (!upstreamChildTaskId) return null;
  return outputs.get(
    childOutputKey(
      upstreamChildTaskId,
      input.outputKey,
      declaredType(upstreamDeclaredOutputs, input.outputKey),
    ),
  ) ?? null;
}

/**
 * Stale lane keys of several plans, loading consumed inputs and the upstream
 * lanes' current committed outputs in two queries for all plans together.
 */
export async function loadStaleLaneKeys(
  transaction: PgTransactionClient,
  organizationId: string,
  planLanes: ReadonlyMap<string, readonly StaleLaneRow[]>,
): Promise<Map<string, Set<string>>> {
  const completedChildren = new Set<string>();
  for (const lanes of planLanes.values()) {
    for (const lane of lanes) {
      if (lane.child_task_id && lane.child_status === "completed") {
        completedChildren.add(lane.child_task_id);
      }
    }
  }
  const consumedByChild = await loadConsumedInputs(
    transaction,
    organizationId,
    [...completedChildren],
  );
  const upstreamChildren = new Set<string>();
  for (const lanes of planLanes.values()) {
    for (const lane of lanes) {
      if (!lane.child_task_id) continue;
      for (const input of consumedByChild.get(lane.child_task_id) ?? []) {
        const upstream = lanes.find((other) =>
          other.lane_key === input.fromLane
        );
        if (upstream?.child_task_id) {
          upstreamChildren.add(upstream.child_task_id);
        }
      }
    }
  }
  const outputs = await loadCurrentOutputs(
    transaction,
    organizationId,
    [...upstreamChildren],
  );
  const byPlan = new Map<string, Set<string>>();
  for (const [planId, lanes] of planLanes) {
    const current = new Map<string, CurrentOutput | null>();
    const facts: StaleLaneFacts[] = lanes.map((lane) => {
      const completed = lane.child_task_id !== null &&
        lane.child_status === "completed";
      const consumed = completed
        ? consumedByChild.get(lane.child_task_id as string) ?? []
        : [];
      for (const input of consumed) {
        const upstream = lanes.find((other) =>
          other.lane_key === input.fromLane
        );
        current.set(
          outputLookupKey(input.fromLane, input.outputKey),
          currentOutputForInput(
            outputs,
            input,
            upstream?.child_task_id,
            upstream?.declared_outputs,
          ),
        );
      }
      return {
        key: lane.lane_key,
        prerequisites: lane.prerequisites,
        completed,
        expectsInputs: lane.declared_input_count > 0,
        consumed,
      };
    });
    byPlan.set(planId, findStaleLanes(facts, current));
  }
  return byPlan;
}
