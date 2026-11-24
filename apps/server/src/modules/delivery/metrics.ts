/**
 * Development metrics over pull request facts (chapter 18, issue #46).
 *
 * metrics.get answers one allowlisted metric over a bounded half-open UTC
 * window [from, to) in buckets; metrics.sources lists the exact pull requests
 * behind it. Both read the organization's pull requests once, bounded and by
 * index, after the action's authority has resolved the organization actor
 * (metric:read), and aggregate here in TypeScript: nothing is computed in the
 * database. Identity is the pull request row (repository + provider number),
 * so a webhook delivered twice or a reread never counts twice. A value that
 * cannot be known (no provider time, no diff totals) is left out and counted
 * as missing with its reason; it is never a zero.
 */

import { StandardError } from "@bakery/contracts/http";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  cohortSummary,
  leadTimeHours,
  readDeliveredTasks,
  type TaskTimeline,
  waitShares,
} from "./task-times.ts";
import {
  COUNTER_VERSION,
  type LineCount,
  LineCoverage,
} from "../integrations/line-counter.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEFAULT_SPAN_MS = 30 * DAY_MS;
const MAX_SPAN_MS = 366 * DAY_MS;
const MAX_POINTS = 1000;
/** The most pull requests one interactive answer reads. */
export const MAX_SCOPE_ROWS = 20_000;
/** A source not read for this long is stale. */
export const STALE_AFTER_MS = DAY_MS;

export const MetricKey = Object.freeze(
  {
    Opened: "prs.opened",
    Merged: "prs.merged",
    ClosedUnmerged: "prs.closedUnmerged",
    OpenAtCutoff: "prs.openAtCutoff",
    MergeRate: "prs.mergeRate",
    TurnaroundHours: "prs.turnaroundHours",
    ChangedLines: "prs.changedLines",
    CountedLines: "loc.changedLines",
    TaskLeadTime: "tasks.leadTimeHours",
    DeploymentFrequency: "delivery.deploymentFrequency",
    ChangeLeadTime: "delivery.changeLeadTimeHours",
    ChangeFailRate: "delivery.changeFailRate",
    FailedDeploymentRecovery: "delivery.failedDeploymentRecoveryHours",
    DeploymentReworkRate: "delivery.deploymentReworkRate",
  } as const,
);
export type MetricKey = typeof MetricKey[keyof typeof MetricKey];

/**
 * The production delivery metrics (chapter 18, DORA). They count deployments
 * and incidents, and Bakery records neither yet, so every answer is unknown
 * with the reason `no_deploy_evidence`, never zero, until a deployment fact
 * exists. Real deployment evidence waits on hosted deploys (owner directive
 * 2026-11-11).
 */
export const PRODUCTION_DELIVERY_METRICS: ReadonlySet<MetricKey> = new Set([
  MetricKey.DeploymentFrequency,
  MetricKey.ChangeLeadTime,
  MetricKey.ChangeFailRate,
  MetricKey.FailedDeploymentRecovery,
  MetricKey.DeploymentReworkRate,
]);

export type MissingReason =
  | "no_opened_time"
  | "no_merged_time"
  | "no_closed_time"
  | "no_diff_totals"
  | "no_line_count"
  | "line_count_binary"
  | "line_count_truncated"
  | "still_open";

type Unit = "count" | "ratio" | "hours" | "lines";

type Definition = Readonly<{
  unit: Unit;
  cohort: string;
  /** The provider time a pull request is placed at for this metric. */
  placedBy:
    | "opened"
    | "merged"
    | "closed"
    | "cutoff"
    | "delivered"
    | "deployed";
}>;

/**
 * The definitions. Changing any word here changes the measurement revision,
 * so an answer under an old definition is never compared with a new one.
 */
export const METRIC_DEFINITIONS: Readonly<Record<MetricKey, Definition>> =
  Object.freeze({
    [MetricKey.Opened]: {
      unit: "count",
      cohort: "Distinct pull requests opened in each period",
      placedBy: "opened",
    },
    [MetricKey.Merged]: {
      unit: "count",
      cohort: "Distinct pull requests merged in each period",
      placedBy: "merged",
    },
    [MetricKey.ClosedUnmerged]: {
      unit: "count",
      cohort:
        "Distinct pull requests finally closed without merge in each period",
      placedBy: "closed",
    },
    [MetricKey.OpenAtCutoff]: {
      unit: "count",
      cohort: "Pull requests open at the end of each period",
      placedBy: "cutoff",
    },
    [MetricKey.MergeRate]: {
      unit: "ratio",
      cohort:
        "Pull requests first opened in each period: merged by the end of the window over all opened",
      placedBy: "opened",
    },
    [MetricKey.TurnaroundHours]: {
      unit: "hours",
      cohort:
        "Mean merged minus opened time of pull requests merged in each period",
      placedBy: "merged",
    },
    [MetricKey.ChangedLines]: {
      unit: "lines",
      cohort:
        "Added plus deleted lines, once per distinct pull request merged in each period",
      placedBy: "merged",
    },
    [MetricKey.CountedLines]: {
      unit: "lines",
      cohort:
        "Added plus deleted lines of source, test, docs and config files, lock, vendored and generated files excluded, from a complete count of the merged head, once per distinct pull request merged in each period",
      placedBy: "merged",
    },
    [MetricKey.TaskLeadTime]: {
      unit: "hours",
      cohort:
        "Tasks delivered in each period: from the first admitted run to the first merged pull request, else the last completed run",
      placedBy: "delivered",
    },
    [MetricKey.DeploymentFrequency]: {
      unit: "count",
      cohort:
        "Successful production deployments of each application in each period",
      placedBy: "deployed",
    },
    [MetricKey.ChangeLeadTime]: {
      unit: "hours",
      cohort:
        "Mean commit to production deployment time of changes deployed in each period",
      placedBy: "deployed",
    },
    [MetricKey.ChangeFailRate]: {
      unit: "ratio",
      cohort:
        "Production deployments in each period that caused a failure needing remediation, over all deployments",
      placedBy: "deployed",
    },
    [MetricKey.FailedDeploymentRecovery]: {
      unit: "hours",
      cohort:
        "Mean time from a failed production deployment to its recovery, for failures recovered in each period",
      placedBy: "deployed",
    },
    [MetricKey.DeploymentReworkRate]: {
      unit: "ratio",
      cohort:
        "Unplanned production deployments made to fix an incident, over all deployments in each period",
      placedBy: "deployed",
    },
  });

/** FNV-1a over a definition, as a short stable revision id. */
export function revisionOf(key: MetricKey, definition: Definition): string {
  const text = JSON.stringify({ key, ...definition, v: 1 });
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return key + "@" + hash.toString(16).padStart(8, "0");
}

/** The revision of a metric's current definition. */
export function measurementRevision(key: MetricKey): string {
  return revisionOf(key, METRIC_DEFINITIONS[key]);
}

export type Resolution = "minute" | "hour" | "day";
const RESOLUTION_MS: Record<Resolution, number> = {
  minute: 60_000,
  hour: HOUR_MS,
  day: DAY_MS,
};

export type MetricWindow = Readonly<{
  from: Date;
  to: Date;
  resolution: Resolution;
  bucketMs: number;
  buckets: number;
}>;

function unprocessable(field: string, code: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: [field], code, message: code }] },
  });
}

/** The window an answer covers, defaulted and bounded as chapter 18 says. */
export function metricWindow(
  input: { from?: string | Date; to?: string | Date; resolution?: Resolution },
  now: Date,
): MetricWindow {
  const to = input.to === undefined ? now : new Date(input.to);
  const from = input.from === undefined
    ? new Date(to.getTime() - DEFAULT_SPAN_MS)
    : new Date(input.from);
  if (Number.isNaN(to.getTime())) unprocessable("to", "invalid_time");
  if (Number.isNaN(from.getTime())) unprocessable("from", "invalid_time");
  const span = to.getTime() - from.getTime();
  if (span <= 0) unprocessable("from", "window_empty");
  if (span > MAX_SPAN_MS) unprocessable("from", "window_too_long");
  const resolution = input.resolution ?? "day";
  const bucketMs = RESOLUTION_MS[resolution];
  const buckets = Math.ceil(span / bucketMs);
  if (buckets > MAX_POINTS) unprocessable("resolution", "too_many_points");
  return { from, to, resolution, bucketMs, buckets };
}

/** One pull request as the metrics read it. Null is unknown. */
export type PullRequestFact = Readonly<{
  id: string;
  repositoryId: string;
  taskId: string;
  providerNumber: number;
  url: string;
  status: "open" | "closed" | "merged";
  openedAt: Date | null;
  mergedAt: Date | null;
  closedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  /** The line count of the head under the current counter version; null when none. */
  lineCount?: LineCount | null;
  /** Lifecycle transitions, oldest first, deduplicated by identity. */
  transitions: readonly { kind: string; at: Date }[];
}>;

/** Delivered tasks placed at their delivery time, valued by lead time. */
export function taskPlacements(
  tasks: readonly TaskTimeline[],
  window: MetricWindow,
): Placement[] {
  return tasks
    .filter((task) => inWindow(task.deliveredAt, window))
    .map((task) => ({
      fact: null,
      task,
      countedAt: task.deliveredAt,
      value: leadTimeHours(task),
      missingReason: null,
    }));
}

/** One record behind a metric: where it is placed and what it adds. */
export type Placement = Readonly<{
  /** The pull request behind a pull request metric; null for a task metric. */
  fact: PullRequestFact | null;
  /** The task behind a task metric; absent for a pull request metric. */
  task?: TaskTimeline;
  countedAt: Date | null;
  value: number | null;
  missingReason: MissingReason | null;
}>;

function inWindow(at: Date | null, window: MetricWindow): at is Date {
  return at !== null && at.getTime() >= window.from.getTime() &&
    at.getTime() < window.to.getTime();
}

/**
 * Whether a pull request is open at an instant, from its transitions when it
 * has them (so a reopened pull request is open again after its reopen), else
 * from its lifecycle times. Unknown when it was never read.
 */
export function openAt(fact: PullRequestFact, at: Date): boolean | null {
  const t = at.getTime();
  if (fact.transitions.length > 0) {
    let open: boolean | null = null;
    for (const transition of fact.transitions) {
      if (transition.at.getTime() > t) break;
      open = transition.kind === "opened" || transition.kind === "reopened";
    }
    return open ?? false;
  }
  if (fact.openedAt === null) return null;
  if (fact.openedAt.getTime() > t) return false;
  const ended = fact.mergedAt ?? fact.closedAt;
  return ended === null || ended.getTime() > t;
}

/**
 * The record list behind a metric over a window: the members of its cohort,
 * each placed at the provider time the metric counts and with its own value,
 * or left out with a reason. A merged pull request is never a "closed without
 * merge"; one whose time is unknown cannot be placed and is missing.
 */
export function placements(
  key: MetricKey,
  facts: readonly PullRequestFact[],
  window: MetricWindow,
): Placement[] {
  const out: Placement[] = [];
  for (const fact of facts) {
    switch (key) {
      case MetricKey.Opened:
        if (fact.openedAt === null) {
          out.push({
            fact,
            countedAt: null,
            value: null,
            missingReason: "no_opened_time",
          });
        } else if (inWindow(fact.openedAt, window)) {
          out.push({
            fact,
            countedAt: fact.openedAt,
            value: 1,
            missingReason: null,
          });
        }
        break;
      case MetricKey.Merged:
        if (fact.status === "merged" && fact.mergedAt === null) {
          out.push({
            fact,
            countedAt: null,
            value: null,
            missingReason: "no_merged_time",
          });
        } else if (inWindow(fact.mergedAt, window)) {
          out.push({
            fact,
            countedAt: fact.mergedAt,
            value: 1,
            missingReason: null,
          });
        }
        break;
      case MetricKey.ClosedUnmerged:
        if (fact.status !== "closed" || fact.mergedAt !== null) break;
        if (fact.closedAt === null) {
          out.push({
            fact,
            countedAt: null,
            value: null,
            missingReason: "no_closed_time",
          });
        } else if (inWindow(fact.closedAt, window)) {
          out.push({
            fact,
            countedAt: fact.closedAt,
            value: 1,
            missingReason: null,
          });
        }
        break;
      case MetricKey.OpenAtCutoff: {
        const cutoff = new Date(window.to.getTime() - 1);
        const open = openAt(fact, cutoff);
        if (open === null) {
          out.push({
            fact,
            countedAt: null,
            value: null,
            missingReason: "no_opened_time",
          });
        } else if (open) {
          out.push({
            fact,
            countedAt: window.to,
            value: 1,
            missingReason: null,
          });
        }
        break;
      }
      case MetricKey.MergeRate:
        if (fact.openedAt === null) {
          out.push({
            fact,
            countedAt: null,
            value: null,
            missingReason: "no_opened_time",
          });
        } else if (inWindow(fact.openedAt, window)) {
          const merged = fact.mergedAt !== null &&
            fact.mergedAt.getTime() < window.to.getTime();
          out.push({
            fact,
            countedAt: fact.openedAt,
            value: merged ? 1 : 0,
            missingReason: null,
          });
        }
        break;
      case MetricKey.TurnaroundHours:
        if (!inWindow(fact.mergedAt, window)) {
          if (fact.status === "merged" && fact.mergedAt === null) {
            out.push({
              fact,
              countedAt: null,
              value: null,
              missingReason: "no_merged_time",
            });
          }
          break;
        }
        out.push(
          fact.openedAt === null
            ? {
              fact,
              countedAt: fact.mergedAt,
              value: null,
              missingReason: "no_opened_time",
            }
            : {
              fact,
              countedAt: fact.mergedAt,
              value: (fact.mergedAt.getTime() - fact.openedAt.getTime()) /
                HOUR_MS,
              missingReason: null,
            },
        );
        break;
      case MetricKey.ChangedLines:
        if (!inWindow(fact.mergedAt, window)) break;
        out.push(
          fact.additions === null || fact.deletions === null
            ? {
              fact,
              countedAt: fact.mergedAt,
              value: null,
              missingReason: "no_diff_totals",
            }
            : {
              fact,
              countedAt: fact.mergedAt,
              value: fact.additions + fact.deletions,
              missingReason: null,
            },
        );
        break;
      case MetricKey.CountedLines: {
        if (!inWindow(fact.mergedAt, window)) break;
        const count = fact.lineCount ?? null;
        const missingReason: MissingReason | null = count === null
          ? "no_line_count"
          : count.coverage === LineCoverage.Truncated
          ? "line_count_truncated"
          : count.coverage === LineCoverage.Binary
          ? "line_count_binary"
          : null;
        out.push({
          fact,
          countedAt: fact.mergedAt,
          value: missingReason === null ? count!.added + count!.deleted : null,
          missingReason,
        });
        break;
      }
    }
  }
  return out;
}

export type SeriesBody = {
  points: {
    at: string;
    value: number | null;
    unknownReason:
      | "no_records"
      | "no_known_values"
      | "no_deploy_evidence"
      | null;
  }[];
  sampleCount: number;
  missingCount: number;
  missingReasons: { reason: MissingReason; count: number }[];
  completeness: "complete" | "partial" | "unknown";
};

/**
 * A production delivery metric's answer while no deployment is recorded:
 * every point unknown for the same named reason, nothing sampled, nothing
 * missing, completeness unknown.
 */
export function noDeployEvidence(window: MetricWindow): SeriesBody {
  return {
    points: Array.from({ length: window.buckets }, (_, index) => ({
      at: new Date(window.from.getTime() + index * window.bucketMs)
        .toISOString(),
      value: null,
      unknownReason: "no_deploy_evidence" as const,
    })),
    sampleCount: 0,
    missingCount: 0,
    missingReasons: [],
    completeness: "unknown",
  };
}

/** Buckets placements into points; mean for hours and ratio, sum otherwise. */
export function aggregate(
  key: MetricKey,
  placed: readonly Placement[],
  window: MetricWindow,
  anyRead: boolean,
): SeriesBody {
  const unit = METRIC_DEFINITIONS[key].unit;
  const sums = new Array<number>(window.buckets).fill(0);
  const known = new Array<number>(window.buckets).fill(0);
  const members = new Array<number>(window.buckets).fill(0);
  const reasons = new Map<MissingReason, number>();
  let sample = 0;
  let stillOpen = 0;
  for (const p of placed) {
    if (p.missingReason !== null) {
      reasons.set(p.missingReason, (reasons.get(p.missingReason) ?? 0) + 1);
    }
    if (key === MetricKey.OpenAtCutoff) continue;
    if (p.countedAt === null) continue;
    const index = Math.floor(
      (p.countedAt.getTime() - window.from.getTime()) / window.bucketMs,
    );
    if (index < 0 || index >= window.buckets) continue;
    members[index] += 1;
    if (p.value === null) continue;
    sums[index] += p.value;
    known[index] += 1;
    sample += 1;
    if (
      key === MetricKey.MergeRate && p.value === 0 && p.fact?.status === "open"
    ) {
      stillOpen += 1;
    }
  }
  if (key === MetricKey.OpenAtCutoff) {
    // Open at the end of each bucket, from every fact's own lifecycle.
    for (let index = 0; index < window.buckets; index++) {
      const end = Math.min(
        window.from.getTime() + (index + 1) * window.bucketMs,
        window.to.getTime(),
      ) - 1;
      for (const p of placed) {
        if (p.fact === null) continue;
        const open = openAt(p.fact, new Date(end));
        if (open === null) continue;
        members[index] += 1;
        known[index] += 1;
        if (open) sums[index] += 1;
      }
    }
    sample = placed.filter((p) => p.value !== null).length;
  }
  const mean = unit === "hours" || unit === "ratio";
  const points = sums.map((sum, index) => {
    const at = new Date(window.from.getTime() + index * window.bucketMs)
      .toISOString();
    if (known[index] === 0) {
      // A count with no records is zero; a mean of nothing is unknown.
      if (!mean && anyRead) {
        return members[index] === 0
          ? { at, value: 0, unknownReason: null }
          : { at, value: null, unknownReason: "no_known_values" as const };
      }
      return {
        at,
        value: null,
        unknownReason: members[index] === 0
          ? "no_records" as const
          : "no_known_values" as const,
      };
    }
    return { at, value: mean ? sum / known[index] : sum, unknownReason: null };
  });
  if (stillOpen > 0) reasons.set("still_open", stillOpen);
  const missingReasons = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
  const missingCount = missingReasons.reduce(
    (total, entry) => total + (entry.reason === "still_open" ? 0 : entry.count),
    0,
  );
  return {
    points,
    sampleCount: sample,
    missingCount,
    missingReasons,
    completeness: !anyRead
      ? "unknown"
      : missingReasons.length === 0
      ? "complete"
      : "partial",
  };
}

type FactRow = {
  id: string;
  repository_id: string;
  task_id: string;
  provider_number: number;
  url: string;
  status: "open" | "closed" | "merged";
  opened_at: Date | null;
  merged_at: Date | null;
  closed_at: Date | null;
  additions: number | null;
  deletions: number | null;
  head_sha: string;
  last_observed_at: Date | null;
};

type LineCountRow = {
  pull_request_id: string;
  head_sha: string;
  counter_version: string;
  coverage: LineCount["coverage"];
  added: number;
  deleted: number;
  counted_files: number;
  excluded_files: number;
  binary_files: number;
  categories: LineCount["categories"];
};

/**
 * The organization's pull requests that can bear on the window, bounded: any
 * lifecycle time before the window's end and not finished before its start,
 * plus those registered in the window whose times are still unknown. A scope
 * larger than MAX_SCOPE_ROWS is refused rather than silently truncated.
 */
async function readFacts(
  tx: PgTransactionClient,
  organizationId: string,
  repositoryId: string | undefined,
  window: MetricWindow,
): Promise<{ facts: PullRequestFact[]; lastObserved: Map<string, Date> }> {
  const found = await tx.query<FactRow>(
    `select id, repository_id, task_id, provider_number, url, status,
            opened_at, merged_at, closed_at, additions, deletions,
            head_sha, last_observed_at
       from bakery.pull_requests
      where organization_id = $1
        and ($2::uuid is null or repository_id = $2)
        and (
          (opened_at < $4 and coalesce(merged_at, closed_at, $4) >= $3)
          or (opened_at is null and created_at >= $3 and created_at < $4)
          or (merged_at >= $3 and merged_at < $4)
          or (closed_at >= $3 and closed_at < $4)
        )
      order by id
      limit $5`,
    [
      organizationId,
      repositoryId ?? null,
      window.from,
      window.to,
      MAX_SCOPE_ROWS + 1,
    ],
  );
  if (found.rows.length > MAX_SCOPE_ROWS) {
    unprocessable("from", "window_too_large");
  }
  const ids = found.rows.map((row) => row.id);
  const transitions = ids.length === 0
    ? {
      rows: [] as {
        pull_request_id: string;
        kind: string;
        effective_at: Date;
      }[],
    }
    : await tx.query<
      { pull_request_id: string; kind: string; effective_at: Date }
    >(
      `select pull_request_id, kind, effective_at
         from bakery.pull_request_transitions
        where organization_id = $1 and pull_request_id = any($2::uuid[])
          and effective_at < $3
        order by pull_request_id, effective_at, kind`,
      [organizationId, ids, window.to],
    );
  const byPr = new Map<string, { kind: string; at: Date }[]>();
  for (const row of transitions.rows) {
    const list = byPr.get(row.pull_request_id) ?? [];
    list.push({ kind: row.kind, at: row.effective_at });
    byPr.set(row.pull_request_id, list);
  }
  const counts = ids.length === 0
    ? { rows: [] as LineCountRow[] }
    : await tx.query<LineCountRow>(
      `select pull_request_id, head_sha, counter_version, coverage, added,
              deleted, counted_files, excluded_files, binary_files, categories
         from bakery.pull_request_line_counts
        where organization_id = $1 and pull_request_id = any($2::uuid[])
          and counter_version = $3`,
      [organizationId, ids, COUNTER_VERSION],
    );
  const headOf = new Map(found.rows.map((row) => [row.id, row.head_sha]));
  const countOf = new Map<string, LineCount>();
  for (const row of counts.rows) {
    // Only the count of the head the pull request merged with is current.
    if (headOf.get(row.pull_request_id) !== row.head_sha) continue;
    countOf.set(row.pull_request_id, {
      counterVersion: row.counter_version,
      coverage: row.coverage,
      added: Number(row.added),
      deleted: Number(row.deleted),
      countedFiles: Number(row.counted_files),
      excludedFiles: Number(row.excluded_files),
      binaryFiles: Number(row.binary_files),
      categories: row.categories,
    });
  }
  const lastObserved = new Map<string, Date>();
  for (const row of found.rows) {
    if (row.last_observed_at === null) continue;
    const prior = lastObserved.get(row.repository_id);
    if (!prior || prior < row.last_observed_at) {
      lastObserved.set(row.repository_id, row.last_observed_at);
    }
  }
  return {
    lastObserved,
    facts: found.rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      taskId: row.task_id,
      providerNumber: Number(row.provider_number),
      url: row.url,
      status: row.status,
      openedAt: row.opened_at,
      mergedAt: row.merged_at,
      closedAt: row.closed_at,
      additions: row.additions === null ? null : Number(row.additions),
      deletions: row.deletions === null ? null : Number(row.deletions),
      lineCount: countOf.get(row.id) ?? null,
      transitions: byPr.get(row.id) ?? [],
    })),
  };
}

export type RepositorySource = {
  repositoryId: string;
  state: "connected" | "disconnected" | "stale";
  since: string | null;
  lastSyncAt: string | null;
};

/** The state of one repository's source, from its connection and last read. */
export function sourceState(
  input: {
    connectionStatus: string | null;
    connectionArchivedAt: Date | null;
    connectionUpdatedAt: Date | null;
    lastSyncAt: Date | null;
  },
  now: Date,
): Pick<RepositorySource, "state" | "since"> {
  if (
    input.connectionStatus === null || input.connectionArchivedAt !== null ||
    input.connectionStatus === "disabled" ||
    input.connectionStatus === "revoked"
  ) {
    const since = input.connectionArchivedAt ?? input.connectionUpdatedAt;
    return {
      state: "disconnected",
      since: input.connectionStatus === null || since === null
        ? null
        : since.toISOString(),
    };
  }
  if (
    input.connectionStatus !== "enabled" || input.lastSyncAt === null ||
    now.getTime() - input.lastSyncAt.getTime() > STALE_AFTER_MS
  ) return { state: "stale", since: null };
  return { state: "connected", since: null };
}

async function readSources(
  tx: PgTransactionClient,
  organizationId: string,
  repositoryId: string | undefined,
  now: Date,
): Promise<RepositorySource[]> {
  const found = await tx.query<{
    id: string;
    status: string | null;
    archived_at: Date | null;
    updated_at: Date | null;
    last_observed_at: Date | null;
  }>(
    `select r.id, c.status, c.archived_at, c.updated_at,
            (select max(p.last_observed_at) from bakery.pull_requests p
              where p.organization_id = r.organization_id
                and p.repository_id = r.id) as last_observed_at
       from bakery.repositories r
       left join bakery.integration_connections c
         on c.organization_id = r.organization_id
        and c.id = r.integration_connection_id
      where r.organization_id = $1 and r.archived_at is null
        and ($2::uuid is null or r.id = $2)
      order by r.id
      limit 1000`,
    [organizationId, repositoryId ?? null],
  );
  return found.rows.map((row) => ({
    repositoryId: row.id,
    lastSyncAt: row.last_observed_at?.toISOString() ?? null,
    ...sourceState({
      connectionStatus: row.status,
      connectionArchivedAt: row.archived_at,
      connectionUpdatedAt: row.updated_at,
      lastSyncAt: row.last_observed_at,
    }, now),
  }));
}

type MetricInput = {
  metric: MetricKey;
  from?: string | Date;
  to?: string | Date;
  resolution?: Resolution;
  repositoryId?: string;
};

/** metrics.get */
export async function getMetricSeries(
  context: ActionContext,
  input: MetricInput,
  now: Date = new Date(),
) {
  const { transaction: tx, organizationId } = requireWorkTransaction(context);
  const window = metricWindow(input, now);
  const repositories = await readSources(
    tx,
    organizationId,
    input.repositoryId,
    now,
  );
  const { placed, anyRecords, tasks } = await placementsFor(
    tx,
    organizationId,
    input,
    window,
  );
  const anyRead = repositories.some((r) => r.lastSyncAt !== null) ||
    anyRecords;
  const body = PRODUCTION_DELIVERY_METRICS.has(input.metric)
    ? noDeployEvidence(window)
    : aggregate(input.metric, placed, window, anyRead);
  const synced = repositories.map((r) => r.lastSyncAt).filter((v) => v !== null)
    .sort();
  const definition = METRIC_DEFINITIONS[input.metric];
  return {
    name: input.metric,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    resolution: window.resolution,
    unit: definition.unit,
    cohort: definition.cohort,
    measurementRevision: measurementRevision(input.metric),
    lastSyncAt: synced.at(-1) ?? null,
    hiddenCount: 0,
    repositories,
    summary: tasks === null ? null : cohortSummary(tasks),
    ...body,
  };
}

/** The placements behind a metric, from pull requests or delivered tasks. */
async function placementsFor(
  tx: PgTransactionClient,
  organizationId: string,
  input: MetricInput,
  window: MetricWindow,
): Promise<
  { placed: Placement[]; anyRecords: boolean; tasks: TaskTimeline[] | null }
> {
  if (PRODUCTION_DELIVERY_METRICS.has(input.metric)) {
    // No deployment records exist to place; nothing is read.
    return { placed: [], anyRecords: false, tasks: null };
  }
  if (input.metric === MetricKey.TaskLeadTime) {
    let tasks: TaskTimeline[];
    try {
      tasks = await readDeliveredTasks(
        tx,
        organizationId,
        input.repositoryId,
        window.from,
        window.to,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        unprocessable("from", "window_too_large");
      }
      throw error;
    }
    return {
      placed: taskPlacements(tasks, window),
      anyRecords: tasks.length > 0,
      tasks,
    };
  }
  const { facts } = await readFacts(
    tx,
    organizationId,
    input.repositoryId,
    window,
  );
  return {
    placed: placements(input.metric, facts, window),
    anyRecords: facts.length > 0,
    tasks: null,
  };
}

/** The cursor time of a placement; an unknown one sorts after every known. */
const UNKNOWN_TIME = "9999-12-31T23:59:59.999999Z";
function cursorTime(p: Placement): string {
  return p.countedAt === null
    ? UNKNOWN_TIME
    : p.countedAt.toISOString().replace("Z", "000Z");
}

/** The keyset order of metrics.sources: placed time, unknown last, then id. */
export function sortKey(p: Placement): [string, string] {
  return [cursorTime(p), p.fact?.id ?? p.task?.taskId ?? ""];
}

/** metrics.sources */
export function createMetricSourcesLister(secret: string) {
  return async (
    context: ActionContext,
    input: MetricInput & { cursor?: string; limit?: number },
    now: Date = new Date(),
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      unprocessable("limit", "out_of_range");
    }
    const window = metricWindow({ ...input, resolution: "day" }, now);
    const binding: CursorBinding = {
      action: "metrics.sources",
      principalId,
      organizationId,
      ordering: "countedAt:asc,id:asc",
      filters: JSON.stringify({
        metric: input.metric,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        repositoryId: input.repositoryId ?? null,
      }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const { placed } = await placementsFor(tx, organizationId, input, window);
    const rows = placed.sort((a, b) => {
      const [at, ai] = sortKey(a);
      const [bt, bi] = sortKey(b);
      return at < bt ? -1 : at > bt ? 1 : ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    const after = position
      ? [String(position.createdAt), position.id] as const
      : null;
    const start = after === null ? 0 : rows.findIndex((p) => {
      const [t, id] = sortKey(p);
      return t > after[0] || (t === after[0] && id > after[1]);
    });
    const page = start < 0 ? [] : rows.slice(start, start + limit);
    const last = page.at(-1);
    const more = start >= 0 && start + limit < rows.length;
    return {
      items: page.map((p) => sourceRow(p)),
      nextCursor: more && last
        ? await encodeCursor(secret, binding, {
          createdAt: sortKey(last)[0],
          id: sortKey(last)[1],
        })
        : null,
    };
  };
}

/** One drilldown row: a pull request, or a task with where its time went. */
function sourceRow(p: Placement) {
  const counted = {
    countedAt: p.countedAt?.toISOString() ?? null,
    value: p.value,
    missingReason: p.missingReason,
  };
  if (p.fact === null) {
    const task = p.task!;
    return {
      kind: "task" as const,
      id: task.taskId,
      repositoryId: null,
      taskId: task.taskId,
      providerNumber: null,
      url: null,
      status: "delivered" as const,
      openedAt: null,
      mergedAt: null,
      closedAt: null,
      title: task.title,
      requestedAt: task.requestedAt.toISOString(),
      deliveredAt: task.deliveredAt?.toISOString() ?? null,
      deliveryPoint: task.deliveryPoint,
      waits: waitShares(task),
      lineCount: null,
      ...counted,
    };
  }
  return {
    kind: "pullRequest" as const,
    id: p.fact.id,
    repositoryId: p.fact.repositoryId,
    taskId: p.fact.taskId,
    providerNumber: p.fact.providerNumber,
    url: p.fact.url,
    status: p.fact.status,
    openedAt: p.fact.openedAt?.toISOString() ?? null,
    mergedAt: p.fact.mergedAt?.toISOString() ?? null,
    closedAt: p.fact.closedAt?.toISOString() ?? null,
    title: null,
    requestedAt: null,
    deliveredAt: null,
    deliveryPoint: null,
    waits: null,
    lineCount: p.fact.lineCount ?? null,
    ...counted,
  };
}
