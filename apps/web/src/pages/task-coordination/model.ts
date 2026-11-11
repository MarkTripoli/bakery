import type {
  ApplicationRepositoryRoleListResponse,
  CoordinationPlanResponse,
  RepositoryListResponse,
} from "../../api/client.ts";

export type LaneStatus =
  | "planned"
  | "ready"
  | "waiting"
  | "running"
  | "completed"
  | "stale"
  | "failed"
  | "stopped"
  | "canceled";

export type PlanLane = Readonly<{
  key: string;
  title: string;
  status: LaneStatus;
  childTaskId: string | null;
  repositoryId: string;
  alias: string | null;
  repository: string | null;
  prerequisites: readonly string[];
  outputs: readonly DeclaredOutput[];
  inputs: readonly { fromLane: string; outputKey: string }[];
  reusedFromLaneId: string | null;
}>;

export type DeclaredOutput = Readonly<{
  key: string;
  artifactType: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const STATUSES: readonly LaneStatus[] = [
  "planned",
  "ready",
  "waiting",
  "running",
  "completed",
  "stale",
  "failed",
  "stopped",
  "canceled",
];

/**
 * Lane rows in plan order, joining the stored lane projection with the
 * immutable spec (titles, typed inputs) and the application's aliases.
 * Everything is read defensively: a malformed field renders as empty.
 */
export function planLanes(
  plan: CoordinationPlanResponse,
  roles: ApplicationRepositoryRoleListResponse | undefined,
  repositories: RepositoryListResponse | undefined,
): PlanLane[] {
  const specLanes = isRecord(plan.spec) && Array.isArray(plan.spec.lanes)
    ? plan.spec.lanes.filter(isRecord)
    : [];
  const lanes = Array.isArray(plan.lanes) ? plan.lanes.filter(isRecord) : [];
  return lanes.map((lane) => {
    const key = text(lane.laneKey);
    const spec = specLanes.find((candidate) => text(candidate.key) === key);
    const repositoryId = text(lane.repositoryId);
    const role = roles?.items.find((item) =>
      item.repositoryId === repositoryId
    );
    const repository = repositories?.items.find((item) =>
      item.id === repositoryId
    );
    const status = STATUSES.find((item) => item === lane.status) ?? "planned";
    return {
      key,
      title: text(spec?.title) || key,
      status,
      childTaskId: typeof lane.childTaskId === "string"
        ? lane.childTaskId
        : null,
      repositoryId,
      alias: text(spec?.repositoryAlias) || role?.alias || null,
      repository: repository ? `${repository.owner}/${repository.name}` : null,
      prerequisites: strings(lane.prerequisites),
      outputs: Array.isArray(lane.declaredOutputs)
        ? lane.declaredOutputs.filter(isRecord).map((output) => ({
          key: text(output.key),
          artifactType: text(output.artifactType) || "patch",
        }))
        : [],
      inputs: Array.isArray(spec?.inputs)
        ? spec.inputs.filter(isRecord).map((input) => ({
          fromLane: text(input.fromLane),
          outputKey: text(input.outputKey),
        }))
        : [],
      reusedFromLaneId: typeof lane.reusedFromLaneId === "string"
        ? lane.reusedFromLaneId
        : null,
    };
  });
}

/** Newest plan revision that still describes the work (not replaced). */
export function currentPlan(
  plans: readonly CoordinationPlanResponse[],
): CoordinationPlanResponse | undefined {
  const sorted = [...plans].sort((a, b) => b.revision - a.revision);
  return sorted.find((plan) => plan.status !== "superseded") ?? sorted[0];
}

export type PlanCounts = Readonly<
  Record<LaneStatus, number> & {
    total: number;
  }
>;

export function laneCounts(lanes: readonly PlanLane[]): PlanCounts {
  const counts = Object.fromEntries(
    STATUSES.map((status) => [status, 0]),
  ) as Record<LaneStatus, number>;
  for (const lane of lanes) counts[lane.status] += 1;
  return { ...counts, total: lanes.length };
}

/** A plan may be canceled until it finished, was canceled, or was replaced. */
export function cancelable(plan: CoordinationPlanResponse): boolean {
  return plan.status === "planned" || plan.status === "materialized" ||
    plan.status === "partially_delivered";
}

/** Whether a declared output has a committed artifact on the lane's child. */
export function committed(
  output: DeclaredOutput,
  artifacts: readonly CommitCandidate[] | undefined,
): boolean {
  // Mirrors server admission: it filters to artifacts with a published
  // version, then takes the newest. So any matching artifact with a published
  // version makes the output committed, even beside a newer unpublished one.
  return artifacts?.some((artifact) =>
    artifact.name === output.key &&
    artifact.artifactType === output.artifactType &&
    artifact.currentVersionId != null
  ) ?? false;
}

export type CommitCandidate = Readonly<{
  id: string;
  name: string;
  artifactType: string;
  currentVersionId?: string | null;
  createdAt: string;
}>;

/** Where the plan came from, as the server stored it. */
export type PlanOrigin =
  | Readonly<{ kind: "ad_hoc" }>
  | Readonly<{
    kind: "saved_workflow";
    workflowId: string;
    workflowVersionId: string;
    nodeId: string;
  }>
  | Readonly<{
    kind: "ticket";
    provider: string;
    reference: string;
    /** Only ever an https URL; anything else is dropped. */
    url: string | null;
  }>;

/**
 * Reads the stored origin defensively. The server always sends one; null means
 * the plan carries none (a design fixture of the Paper frames), so nothing is
 * claimed. A present but unreadable origin is ad hoc, the schema default.
 */
export function planOrigin(
  plan: CoordinationPlanResponse,
): PlanOrigin | null {
  const origin: unknown = (plan as { origin?: unknown }).origin;
  if (origin === undefined || origin === null) return null;
  if (!isRecord(origin)) return { kind: "ad_hoc" };
  if (origin.kind === "saved_workflow" && text(origin.workflowId)) {
    return {
      kind: "saved_workflow",
      workflowId: text(origin.workflowId),
      workflowVersionId: text(origin.workflowVersionId),
      nodeId: text(origin.nodeId),
    };
  }
  if (
    origin.kind === "ticket" && text(origin.provider) && text(origin.reference)
  ) {
    return {
      kind: "ticket",
      provider: text(origin.provider),
      reference: text(origin.reference),
      url: httpsUrl(text(origin.url)),
    };
  }
  return { kind: "ad_hoc" };
}

/** The URL when it parses as https, else null: a link is never built from a claim of another scheme. */
export function httpsUrl(value: string): string | null {
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** Short, stable form of a digest or identifier for display. */
export const shortId = (value: string, length = 8): string =>
  value.slice(0, length);

/** Whether a lane's typed input has its upstream output committed. */
export type HandoffState = "committed" | "waiting";

/** Whether the plan carries an origin or a digest to show. */
export const hasProvenance = (plan: CoordinationPlanResponse): boolean =>
  planOrigin(plan) !== null ||
  (typeof plan.digest === "string" && plan.digest !== "");
