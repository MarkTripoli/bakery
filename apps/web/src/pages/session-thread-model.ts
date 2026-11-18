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
