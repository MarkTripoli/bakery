import type { ContractOutput } from "@bakery/contracts/contracts";

/**
 * What the session thread draws, decided here and nowhere else, so the grouping
 * rules of the binding design (#405) are plain functions a unit test can hold.
 * Nothing in this file knows about React.
 */
export type SessionFeedItem = ContractOutput<"SessionFeedItem">;

/** Statuses that start or pause a session: a line, not the end of it. */
const STEP_STATUSES = new Set(["starting", "active", "waiting"]);

export type SessionEnd = Readonly<{
  outcome: "completed" | "failed" | "cancelled";
  reason: string | null;
  occurredAt: string;
}>;

export type SessionStep =
  | Readonly<{
    kind: "tool";
    id: string;
    name: string;
    phase: "started" | "completed" | "failed";
    occurredAt: string;
  }>
  | Readonly<{
    kind: "file";
    id: string;
    path: string;
    change: "created" | "modified" | "deleted" | "renamed";
    occurredAt: string;
  }>
  | Readonly<{
    kind: "output";
    id: string;
    text: string;
    lines: number;
    errors: boolean;
    occurredAt: string;
  }>
  | Readonly<{
    kind: "artifact";
    id: string;
    artifactId: string;
    name: string;
    version: number | null;
    occurredAt: string;
  }>
  | Readonly<{
    kind: "status";
    id: string;
    status: "starting" | "active" | "waiting";
    occurredAt: string;
  }>
  | Readonly<{ kind: "redacted"; id: string; occurredAt: string }>;

export type SessionUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}>;

export type SessionTurn = Readonly<{
  /** The message that opened the turn; null for work before the first one. */
  message: SessionFeedItem | null;
  /** A delivery receipt for this person message was in the feed. */
  receipt: boolean;
  steps: readonly SessionStep[];
  usage: SessionUsage | null;
  counts: Readonly<{ steps: number; files: number; failed: number }>;
}>;

export type SessionThreadModel = Readonly<{
  turns: readonly SessionTurn[];
  end: SessionEnd | null;
}>;

type MutableTurn = {
  message: SessionFeedItem | null;
  receipt: boolean;
  steps: SessionStep[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
};

const numberOf = (value: string | null | undefined): number => {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
};

function stepOf(item: SessionFeedItem): SessionStep | null {
  if (item.redacted) {
    return { kind: "redacted", id: item.id, occurredAt: item.occurredAt };
  }
  switch (item.kind) {
    case "tool":
      return item.tool
        ? {
          kind: "tool",
          id: item.id,
          name: item.tool.name,
          phase: item.tool.phase,
          occurredAt: item.occurredAt,
        }
        : null;
    case "file_change":
      return item.fileChange
        ? {
          kind: "file",
          id: item.id,
          path: item.fileChange.path,
          change: item.fileChange.change,
          occurredAt: item.occurredAt,
        }
        : null;
    case "terminal":
      return item.terminal
        ? {
          kind: "output",
          id: item.id,
          text: item.terminal.text,
          lines: item.terminal.text.split("\n").length,
          errors: item.terminal.stream === "stderr",
          occurredAt: item.occurredAt,
        }
        : null;
    case "artifact":
      return item.artifact
        ? {
          kind: "artifact",
          id: item.id,
          artifactId: item.artifact.artifactId,
          name: item.artifact.name,
          version: item.artifact.version,
          occurredAt: item.occurredAt,
        }
        : null;
    default:
      return null;
  }
}

/**
 * Appends a step, folding it into the one before when they are the same thing:
 * a tool's started and finished events (one call id) are one line that takes
 * the latest phase, and consecutive terminal items are one block of output.
 */
function appendStep(
  steps: SessionStep[],
  step: SessionStep,
  callIds: Map<string, number>,
  callId: string | null,
): void {
  if (step.kind === "tool" && callId !== null) {
    const at = callIds.get(callId);
    if (at !== undefined) {
      steps[at] = { ...step, id: steps[at].id };
      return;
    }
    callIds.set(callId, steps.length);
  }
  const previous = steps.at(-1);
  if (step.kind === "output" && previous?.kind === "output") {
    const text = `${previous.text}\n${step.text}`;
    steps[steps.length - 1] = {
      ...previous,
      text,
      lines: text.split("\n").length,
      errors: previous.errors || step.errors,
      occurredAt: step.occurredAt,
    };
    return;
  }
  steps.push(step);
}

/**
 * Groups the feed the way a reader thinks about it (the binding design):
 * a turn starts at every message, and every other item up to the next message
 * is that message's work; a delivery receipt annotates the person message it
 * follows; usage is a total for the turn, not a step; and a finished, failed or
 * interrupted status ends the session instead of being a line. Work before the
 * first message keeps a turn with no message, shown under "Session started".
 */
export function buildSessionThread(
  items: readonly SessionFeedItem[],
): SessionThreadModel {
  const turns: MutableTurn[] = [];
  const callIdsByTurn = new Map<MutableTurn, Map<string, number>>();
  let end: SessionEnd | null = null;
  const turnFor = (): MutableTurn => {
    const current = turns.at(-1);
    if (current) return current;
    const created: MutableTurn = {
      message: null,
      receipt: false,
      steps: [],
      usage: null,
    };
    turns.push(created);
    return created;
  };
  for (const item of items) {
    if (item.kind === "message" && !item.redacted) {
      turns.push({ message: item, receipt: false, steps: [], usage: null });
      continue;
    }
    if (item.kind === "delivered_input") {
      const current = turns.at(-1);
      if (current?.message && current.steps.length === 0) {
        current.receipt = true;
      }
      continue;
    }
    if (item.kind === "status" && item.status) {
      const to = item.status.toStatus;
      if (STEP_STATUSES.has(to)) {
        const turn = turnFor();
        turn.steps.push({
          kind: "status",
          id: item.id,
          status: to as "starting" | "active" | "waiting",
          occurredAt: item.occurredAt,
        });
      } else {
        end = {
          outcome: to === "finished"
            ? "completed"
            : to === "failed"
            ? "failed"
            : "cancelled",
          reason: item.status.reason,
          occurredAt: item.occurredAt,
        };
      }
      continue;
    }
    if (item.kind === "usage" && item.usage) {
      const turn = turnFor();
      const total = turn.usage ??
        { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      total.inputTokens += numberOf(item.usage.inputTokens);
      total.outputTokens += numberOf(item.usage.outputTokens);
      total.costUsd += numberOf(item.usage.costUsd);
      turn.usage = total;
      continue;
    }
    const step = stepOf(item);
    if (!step) continue;
    const turn = turnFor();
    let callIds = callIdsByTurn.get(turn);
    if (!callIds) {
      callIds = new Map();
      callIdsByTurn.set(turn, callIds);
    }
    appendStep(
      turn.steps,
      step,
      callIds,
      item.kind === "tool" ? item.tool?.callId ?? null : null,
    );
  }
  return {
    turns: turns.map((turn) => ({
      ...turn,
      counts: {
        steps: turn.steps.length,
        files: turn.steps.filter((step) => step.kind === "file").length,
        failed:
          turn.steps.filter((step) =>
            step.kind === "tool" && step.phase === "failed"
          ).length,
      },
    })),
    end,
  };
}

/** Folder and file name of a path, so the folder can truncate and the name never. */
export function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** Counts shown in the fine print that ends a turn's work. */
export function formatUsage(
  locale: string | undefined,
  usage: SessionUsage,
): { inputTokens: string; outputTokens: string; cost: string } {
  const tokens = new Intl.NumberFormat(locale);
  const cost = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  return {
    inputTokens: tokens.format(usage.inputTokens),
    outputTokens: tokens.format(usage.outputTokens),
    cost: cost.format(usage.costUsd),
  };
}

/** The most step lines one turn draws before "Show N more". */
export const MAX_STEP_LINES = 30;

/** Whether a turn's work starts open: the live turn while running, or a failure. */
export function opensByDefault(
  turn: SessionTurn,
  isNewest: boolean,
  running: boolean,
): boolean {
  return (isNewest && running) || turn.counts.failed > 0 ||
    turn.steps.some((step) => step.kind === "output" && step.errors);
}

/**
 * A quiet relative time, in the locale's own short form: "15m", "2h", "3d".
 * The exact instant travels beside it as the element's datetime and title, so a
 * shortened label never hides when something happened.
 */
export function relativeTime(
  iso: string,
  locale: string | undefined,
  now: Date,
): { exact: string; label: string } {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return { exact: iso, label: iso };
  const minutes = Math.round((now.getTime() - then) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "narrow",
  });
  const label = Math.abs(minutes) < 60
    ? format.format(-minutes, "minute")
    : Math.abs(minutes) < 60 * 24
    ? format.format(-Math.round(minutes / 60), "hour")
    : format.format(-Math.round(minutes / (60 * 24)), "day");
  return { exact: iso, label };
}

/** What the line above the composer says about a session, from its status and thread. */
export type SessionNowSummary =
  | Readonly<{ kind: "working"; toolName?: string; since?: string }>
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "failed"; reason?: string }>
  | Readonly<{ kind: "idle" }>;

/**
 * The status decides the line, and the thread adds detail to it: a session that
 * is starting is waiting to start; an active one is working, naming the tool
 * that is still running when there is one; a failed one says why when the feed
 * does. Finished, interrupted and any status the client does not know say
 * nothing, because guessing would tell the reader something untrue.
 */
export function summarizeNow(
  status: string,
  model: SessionThreadModel,
): SessionNowSummary {
  switch (status) {
    case "starting":
      return { kind: "waiting" };
    case "active": {
      const steps = model.turns.flatMap((turn) => turn.steps);
      const running = [...steps].reverse().find((step) =>
        step.kind === "tool" && step.phase === "started"
      );
      return running && running.kind === "tool"
        ? { kind: "working", toolName: running.name, since: running.occurredAt }
        : { kind: "working" };
    }
    case "failed":
      return model.end?.reason
        ? { kind: "failed", reason: model.end.reason }
        : { kind: "failed" };
    default:
      return { kind: "idle" };
  }
}

/** Statuses of a session that is still doing something. */
export const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "active",
  "waiting",
]);

/** The session a step's thread shows: the newest one still running, else the newest. */
export function pickSession<
  Session extends { status: string; createdAt: string },
>(sessions: readonly Session[]): Session | null {
  const newest = (list: readonly Session[]) =>
    [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return newest(
    sessions.filter((session) => LIVE_SESSION_STATUSES.has(session.status)),
  ) ??
    newest(sessions);
}

/**
 * The newest events of one session, in sequence order and bounded. Events
 * arrive in order, so each is appended; only a late one is sorted into place,
 * and a repeat of a sequence replaces it instead of showing twice. Past `max`
 * the oldest fall off and the window says it is no longer the whole session.
 */
export function createFeedWindow(max: number) {
  const ordered: SessionFeedItem[] = [];
  const seen = new Set<string>();
  let newest: bigint | null = null;
  let unsorted = false;
  let truncated = false;
  /** The newest sequence that fell off the front: nothing at or below it comes back. */
  let dropped: bigint | null = null;
  const bySequence = (a: SessionFeedItem, b: SessionFeedItem) => {
    const left = BigInt(a.sequence);
    const right = BigInt(b.sequence);
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
  };
  return {
    take(item: SessionFeedItem): void {
      if (seen.has(item.sequence)) {
        // The repeat is nearly always among the newest, so look from the end.
        for (let at = ordered.length - 1; at >= 0; at -= 1) {
          if (ordered[at].sequence === item.sequence) {
            ordered[at] = item;
            break;
          }
        }
        return;
      }
      const key = BigInt(item.sequence);
      // A replay of an event the window already let go would displace a newer one.
      if (dropped !== null && key <= dropped) return;
      seen.add(item.sequence);
      ordered.push(item);
      if (newest === null || key > newest) newest = key;
      else unsorted = true;
      if (ordered.length > max) {
        for (const gone of ordered.splice(0, ordered.length - max)) {
          seen.delete(gone.sequence);
          const goneKey = BigInt(gone.sequence);
          if (dropped === null || goneKey > dropped) dropped = goneKey;
        }
        truncated = true;
      }
    },
    /** The window as a new array, so a caller can hand it to React. */
    items(): SessionFeedItem[] {
      if (unsorted) {
        ordered.sort(bySequence);
        unsorted = false;
      }
      return ordered.slice();
    },
    /** The newest sequence seen, where a stream resumes from. */
    newest(): string | undefined {
      return newest === null ? undefined : newest.toString();
    },
    truncated(): boolean {
      return truncated;
    },
    /** Marks the window as partial when history itself was cut short. */
    markTruncated(): void {
      truncated = true;
    },
  };
}

/** How long to wait before the next stream attempt: 1 s, doubling, at most 15 s. */
export function backoffDelay(retries: number): number {
  return Math.min(1_000 * 2 ** retries, 15_000);
}
