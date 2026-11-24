import type { MetricSeries, MetricsQuery } from "../../api/client.ts";

export const OVER_TIME_SHOWS = [
  "merged",
  "opened",
  "open",
  "closed",
  "lines",
  "taskTime",
] as const;
export type OverTimeShow = typeof OVER_TIME_SHOWS[number];

export function isOverTimeShow(value: unknown): value is OverTimeShow {
  return typeof value === "string" &&
    (OVER_TIME_SHOWS as readonly string[]).includes(value);
}

type MetricKey = MetricsQuery["metric"];

export const OVER_TIME_METRIC: Readonly<Record<OverTimeShow, MetricKey>> = {
  merged: "prs.merged",
  opened: "prs.opened",
  open: "prs.openAtCutoff",
  closed: "prs.closedUnmerged",
  lines: "prs.changedLines",
  taskTime: "tasks.leadTimeHours",
};

export const WEEKLY_ABOVE_DAYS = 90;
const DAY_MS = 86_400_000;

export type ChartStep = "day" | "week";

export function windowDays(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
}

export function chartStep(days: number): ChartStep {
  return days > WEEKLY_ABOVE_DAYS ? "week" : "day";
}

export type ChartPoint = Readonly<{
  from: Date;
  to: Date;
  value: number | null;
}>;

export type Gap = Readonly<{ from: Date; to: Date; buckets: number }>;

function known(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function combine(show: OverTimeShow, values: readonly (number | null)[]) {
  const present = known(values);
  if (present.length === 0) return null;
  if (show === "open") return present.at(-1) ?? null;
  if (show === "taskTime") return median(present);
  return present.reduce((sum, value) => sum + value, 0);
}

export function chartPoints(
  series: MetricSeries,
  show: OverTimeShow,
  step: ChartStep,
): ChartPoint[] {
  const days = series.points.map((point) => {
    const from = new Date(point.at);
    return { from, to: new Date(from.getTime() + DAY_MS), value: point.value };
  });
  if (step === "day") return days;
  const weeks: ChartPoint[] = [];
  for (let start = 0; start < days.length; start += 7) {
    const chunk = days.slice(start, start + 7);
    weeks.push({
      from: chunk[0].from,
      to: chunk[chunk.length - 1].to,
      value: combine(show, chunk.map((day) => day.value)),
    });
  }
  return weeks;
}

export function gapsOf(points: readonly ChartPoint[]): Gap[] {
  const gaps: Gap[] = [];
  let run: ChartPoint[] = [];
  const close = () => {
    if (run.length > 0) {
      gaps.push({
        from: run[0].from,
        to: run[run.length - 1].to,
        buckets: run.length,
      });
    }
    run = [];
  };
  for (const point of points) {
    if (point.value === null) run.push(point);
    else close();
  }
  close();
  return gaps;
}

export function gapDays(gaps: readonly Gap[]): number {
  return gaps.reduce(
    (sum, gap) => sum + windowDays(gap.from, gap.to),
    0,
  );
}

export function hasLine(points: readonly ChartPoint[]): boolean {
  return points.some((point) => point.value !== null);
}
