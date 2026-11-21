/**
 * What the batch pages say, decided apart from the screens (#58, UX revision 2).
 *
 * The rules are the design's tables. Every function is pure so a table row can
 * be tested without a browser, and none returns a sentence: they return
 * catalogue keys with their values, and the page owns the words.
 */
import type { BatchIssueResponse, BatchResponse } from "../../api/client.ts";

export type BatchState = BatchResponse["state"];
export type BatchIssueState = BatchIssueResponse["state"];
export type ContinueMode = BatchResponse["continueMode"];

/** A value that is itself a catalogue key, such as a reason phrase. */
export type Phrase = Readonly<{ phrase: string }>;

/** Marks a catalogue key as a phrase to translate, so free text is never mistaken for one. */
export function phrase(key: string): Phrase {
  return { phrase: key };
}

/**
 * A catalogue key and the values its sentence needs. A value that is a `Phrase`
 * is translated before the sentence is filled, so each language orders its own
 * clause. Any other string is free text (a name, a repository) and is used as is.
 */
export type Message = Readonly<{
  key: string;
  params?: Readonly<Record<string, string | number | Phrase>>;
}>;

/** A batch is live until it has finished or been stopped; only a live batch is read again. */
export function isLive(state: BatchState): boolean {
  return state !== "finished" && state !== "stopped";
}

/** How often a live batch is read again, in milliseconds. */
export const LIVE_READ_MS = 10_000;

// ---- money, time and the three meters ------------------------------------

/** A decimal string from the server as a number of dollars; a missing or bad value is zero, never NaN. */
export function dollars(value: string | null): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** "Nov 20, 4:12 AM" in the given zone: the year is left out, a batch is hours or days old. */
export function formatBatchTime(
  iso: string,
  locale: string,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

export function formatDollars(value: number, locale: string): string {
  const whole = Number.isInteger(value);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** "3 h 41 min" under a day's worth of hours; the unit words come from the catalogue. */
export function splitDuration(
  seconds: number,
): { hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

export type MeterReading = Readonly<{
  /** The figure on the bar, in the unit of `limit`. */
  value: number;
  limit: number;
  /** Warning tone from 90% of the limit, and when over it. */
  state: "ok" | "warning";
  /** How far past the limit, or null while within it. */
  over: number | null;
}>;

/** Warning begins at nine tenths of a limit. */
export const WARNING_SHARE = 0.9;

export function meter(value: number, limit: number): MeterReading {
  const over = limit > 0 && value > limit ? value - limit : null;
  const warn = limit > 0 && value / limit >= WARNING_SHARE;
  return { value, limit, state: warn ? "warning" : "ok", over };
}

export function meters(batch: BatchResponse): {
  issues: MeterReading;
  time: MeterReading;
  spend: MeterReading;
} {
  return {
    issues: meter(batch.issuesDone, batch.maxIssues),
    time: meter(batch.elapsedSeconds, batch.maxHours * 3600),
    spend: meter(dollars(batch.spentUsd), dollars(batch.maxSpendUsd)),
  };
}

// ---- the issues table ----------------------------------------------------

/** The rows the table shows: worked-on and merged in order, then those passed over (they have no number). */
export function tableIssues(
  batch: BatchResponse,
): {
  numbered: { row: BatchIssueResponse; position: number }[];
  passedOver: BatchIssueResponse[];
} {
  const all = [...(batch.issues ?? [])].sort((a, b) => a.position - b.position);
  const numbered = all.filter((row) => row.state !== "passed_over").map((
    row,
    index,
  ) => ({ row, position: index + 1 }));
  return {
    numbered,
    passedOver: all.filter((row) => row.state === "passed_over"),
  };
}

/** The issue being worked on, if one has started. */
export function currentIssue(
  batch: BatchResponse,
): { row: BatchIssueResponse; position: number } | null {
  return tableIssues(batch).numbered.find(({ row }) =>
    row.state === "started"
  ) ??
    null;
}

/** The last issue that was worked on, merged or not: what a paused or waiting batch speaks of. */
export function lastWorkedOn(
  batch: BatchResponse,
): { row: BatchIssueResponse; position: number } | null {
  const numbered = tableIssues(batch).numbered;
  return numbered.length === 0 ? null : numbered[numbered.length - 1]!;
}

const ISSUE_STATE_KEY: Record<BatchIssueState, string> = {
  started: "batches.issueState.working",
  merged: "batches.issueState.merged",
  failed: "batches.issueState.failed",
  cancelled: "batches.issueState.cancelled",
  passed_over: "batches.issueState.passedOver",
};

export function issueStateKey(state: BatchIssueState): string {
  return ISSUE_STATE_KEY[state];
}

export const ISSUE_STATE_TONE: Record<
  BatchIssueState,
  "neutral" | "success" | "warning" | "danger" | "information"
> = {
  started: "information",
  merged: "success",
  failed: "danger",
  cancelled: "warning",
  passed_over: "neutral",
};

// ---- state badge, why it ended -------------------------------------------

const STATE_KEY: Record<BatchState, string> = {
  running: "batches.state.running",
  waiting: "batches.state.waiting",
  paused: "batches.state.paused",
  finishing: "batches.state.finishing",
  stopping: "batches.state.stopping",
  finished: "batches.state.finished",
  stopped: "batches.state.stopped",
};

export function stateKey(state: BatchState): string {
  return STATE_KEY[state];
}

export const STATE_TONE: Record<
  BatchState,
  "neutral" | "success" | "warning" | "danger" | "information"
> = {
  running: "information",
  waiting: "warning",
  paused: "warning",
  finishing: "information",
  stopping: "warning",
  finished: "success",
  stopped: "neutral",
};

/** The reasons a batch can end, as the design words them; any other gives no reason after "Finished". */
const FINISH_REASON_KEY: Record<string, string> = {
  issues_reached: "batches.finish.issuesReached",
  time_exhausted: "batches.finish.timeExhausted",
  spend_exhausted: "batches.finish.spendExhausted",
  nothing_eligible: "batches.finish.nothingEligible",
  issue_failed: "batches.finish.issueFailed",
  issue_cancelled: "batches.finish.issueCancelled",
  authority_lost: "batches.finish.authorityLost",
  finished_by_person: "batches.finish.finishedByPerson",
};

export function finishReasonKey(reason: string | null): string | null {
  return reason === null ? null : FINISH_REASON_KEY[reason] ?? null;
}

/** What the "Why it ended" column of the list says for a batch: a reason once it ended, a muted line while live. */
export function whyItEnded(batch: BatchResponse): Message | null {
  if (batch.state === "finished") {
    const key = finishReasonKey(batch.finishReason);
    return key === null ? null : { key };
  }
  if (batch.state === "stopped") return { key: "batches.finish.stopped" };
  return {
    key: batch.state === "waiting"
      ? "batches.why.asks"
      : "batches.why.stillGoing",
  };
}

// ---- header buttons and the banner ---------------------------------------

export type HeaderButton = "pause" | "stop" | "cancelNow";

/** The buttons in the page header for a state (the design's last column). */
export function headerButtons(batch: BatchResponse): HeaderButton[] {
  switch (batch.state) {
    case "running":
    case "waiting":
      return ["pause", "stop"];
    case "paused":
    case "finishing":
      return ["stop"];
    case "stopping":
      return batch.stopCancelledCurrent ? [] : ["cancelNow"];
    default:
      return [];
  }
}

export type BannerAction =
  | "openTask"
  | "finishHere"
  | "startNext"
  | "resume"
  | "startAnother";

export type Banner = Readonly<{
  tone: "information" | "warning" | "success" | "neutral";
  title: Message;
  body: Message;
  actions: readonly BannerAction[];
}>;

/** What the caller knows that the batch alone does not carry: names, times and issue numbers. */
export type BannerFacts = Readonly<{
  /** The issue number of the one being worked on, when known. */
  currentNumber: string | null;
  /** The number of the last issue worked on. */
  lastNumber: string | null;
  /** The name of who paused or stopped it, or a plain stand-in. */
  who: string;
  /** When that happened, already formatted. */
  when: string;
  /** The spend sentence values for a finish over the limit. */
  spent: string;
  limit: string;
}>;

function ordinalOf(batch: BatchResponse): number {
  return currentIssue(batch)?.position ?? batch.issuesDone + 1;
}

/** The banner for a batch, one row of the design's table. */
export function bannerFor(batch: BatchResponse, facts: BannerFacts): Banner {
  const current = currentIssue(batch);
  const n = facts.currentNumber ?? "";
  const last = facts.lastNumber ?? "";
  const limitWord: Message | null = limitReasonMessage(
    batch.finishReason,
    batch,
  );
  switch (batch.state) {
    case "running":
      return current === null
        ? {
          tone: "information",
          title: { key: "batches.banner.choosing.title" },
          body: { key: "batches.banner.choosing.body" },
          actions: [],
        }
        : {
          tone: "information",
          title: {
            key: "batches.banner.working.title",
            params: {
              number: n,
              ordinal: ordinalOf(batch),
              max: batch.maxIssues,
            },
          },
          body: { key: "batches.banner.working.body" },
          actions: ["openTask"],
        };
    case "waiting":
      return {
        tone: "warning",
        title: {
          key: "batches.banner.waiting.title",
          params: { number: last },
        },
        body: { key: "batches.banner.waiting.body" },
        actions: ["finishHere", "startNext"],
      };
    case "paused":
      if (batch.pauseReason === "starting_not_available") {
        return {
          tone: "warning",
          title: { key: "batches.banner.pausedNoStart.title" },
          body: { key: "batches.banner.pausedNoStart.body" },
          actions: ["resume"],
        };
      }
      if (batch.pauseReason === "paused_by_person") {
        return {
          tone: "warning",
          title: {
            key: "batches.banner.pausedByPerson.title",
            params: { name: facts.who, time: facts.when },
          },
          body: current !== null
            ? {
              key: "batches.banner.pausedByPerson.running",
              params: { number: n },
            }
            : last !== ""
            ? {
              key: "batches.banner.pausedByPerson.merged",
              params: { number: last },
            }
            : { key: "batches.banner.pausedByPerson.nothing" },
          actions: current !== null ? ["openTask", "resume"] : ["resume"],
        };
      }
      return {
        tone: "warning",
        title: { key: "batches.banner.paused.title" },
        body: { key: "batches.banner.paused.body" },
        actions: ["resume"],
      };
    case "finishing":
      return {
        tone: "information",
        title: {
          key: "batches.banner.finishing.title",
          params: {
            reason: phrase(limitWord?.key ?? "batches.limit.generic"),
            number: n,
            max: batch.maxIssues,
          },
        },
        body: { key: "batches.banner.finishing.body" },
        actions: ["openTask"],
      };
    case "stopping":
      return batch.stopCancelledCurrent
        ? {
          tone: "warning",
          title: {
            key: "batches.banner.cancelling.title",
            params: { number: n },
          },
          body: { key: "batches.banner.cancelling.body" },
          actions: ["openTask"],
        }
        : {
          tone: "warning",
          title: {
            key: "batches.banner.stopping.title",
            params: { number: n },
          },
          body: { key: "batches.banner.stopping.body", params: { number: n } },
          actions: ["openTask"],
        };
    case "finished": {
      const reasonKey = finishReasonKey(batch.finishReason);
      return {
        tone: "success",
        title: reasonKey === null
          ? { key: "batches.banner.finished.titleBare" }
          : {
            key: "batches.banner.finished.title",
            params: {
              reason: phrase(reasonKey),
              number: last,
              max: batch.maxIssues,
              name: facts.who,
            },
          },
        body: {
          key: batch.finishReason === "spend_exhausted" &&
              dollars(batch.spentUsd) > dollars(batch.maxSpendUsd)
            ? "batches.banner.finished.bodyOver"
            : "batches.banner.finished.body",
          params: {
            done: batch.issuesDone,
            max: batch.maxIssues,
            number: last,
            spent: facts.spent,
            limit: facts.limit,
          },
        },
        actions: ["startAnother"],
      };
    }
    case "stopped":
      return {
        tone: "neutral",
        title: {
          key: "batches.banner.stopped.title",
          params: { name: facts.who, time: facts.when },
        },
        body: {
          key: batch.stopCancelledCurrent
            ? "batches.banner.stopped.cancelled"
            : "batches.banner.stopped.finishedFirst",
          params: { number: last },
        },
        actions: ["startAnother"],
      };
  }
}

/** The limit a finishing batch hit, as the catalogue key of its short phrase. */
function limitReasonMessage(
  reason: string | null,
  _batch: BatchResponse,
): Message | null {
  switch (reason) {
    case "time_exhausted":
      return { key: "batches.limit.time" };
    case "spend_exhausted":
      return { key: "batches.limit.spend" };
    case "issues_reached":
      return { key: "batches.limit.issues" };
    default:
      return null;
  }
}

/** The Stop dialog's two choices: shown only when an issue is running. */
export function stopChoices(batch: BatchResponse): "choice" | "nothingRunning" {
  return currentIssue(batch) === null ? "nothingRunning" : "choice";
}

// ---- the start form ------------------------------------------------------

export type StartForm = Readonly<{
  repositoryId: string;
  maxIssues: string;
  maxHours: string;
  maxSpend: string;
  continueMode: ContinueMode | "";
}>;

export const START_DEFAULTS: StartForm = {
  repositoryId: "",
  maxIssues: "5",
  maxHours: "8",
  maxSpend: "",
  continueMode: "",
};

export const LIMITS = {
  issues: { min: 1, max: 20 },
  hours: { min: 1, max: 24 },
  spendMax: 4000,
} as const;

export type StartErrors = Partial<
  Record<
    "repositoryId" | "maxIssues" | "maxHours" | "maxSpend" | "continueMode",
    string
  >
>;

function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

/** The dollars typed, as a number of cents-precision, or null when not an amount above zero and up to the cap. */
export function parseSpend(text: string): number | null {
  const clean = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean);
  return n > 0 && n <= LIMITS.spendMax ? n : null;
}

/** Each field's problem as a catalogue key; empty when the form can be sent. */
export function validateStart(form: StartForm): StartErrors {
  const errors: Record<string, string> = {};
  if (form.repositoryId === "") {
    errors.repositoryId = "batches.start.error.repositoryNone";
  }
  if (wholeIn(form.maxIssues, LIMITS.issues.min, LIMITS.issues.max) === null) {
    errors.maxIssues = "batches.start.error.maxIssues";
  }
  if (wholeIn(form.maxHours, LIMITS.hours.min, LIMITS.hours.max) === null) {
    errors.maxHours = "batches.start.error.maxHours";
  }
  if (parseSpend(form.maxSpend) === null) {
    errors.maxSpend = "batches.start.error.maxSpend";
  }
  if (form.continueMode === "") {
    errors.continueMode = "batches.start.error.continueMode";
  }
  return errors;
}

/** The body the server takes, or null while the form has a problem. */
export function startBody(form: StartForm): {
  repositoryId: string;
  maxIssues: number;
  maxHours: number;
  maxSpendUsd: string;
  continueMode: ContinueMode;
} | null {
  if (Object.keys(validateStart(form)).length > 0) return null;
  return {
    repositoryId: form.repositoryId,
    maxIssues: Number(form.maxIssues.trim()),
    maxHours: Number(form.maxHours.trim()),
    maxSpendUsd: parseSpend(form.maxSpend)!.toFixed(2),
    continueMode: form.continueMode as ContinueMode,
  };
}

/** True when the person has changed anything from the form's opening values. */
export function isDirty(form: StartForm, preselected: string): boolean {
  return form.repositoryId !== preselected ||
    form.maxIssues !== START_DEFAULTS.maxIssues ||
    form.maxHours !== START_DEFAULTS.maxHours ||
    form.maxSpend !== START_DEFAULTS.maxSpend ||
    form.continueMode !== START_DEFAULTS.continueMode;
}

/** The values the side column's sentences use; a missing value shows as an ellipsis. */
export function planValues(
  form: StartForm,
  repositoryName: string | null,
  locale: string,
): Record<"repository" | "issues" | "hours" | "spend" | "mode", string> {
  const issues = wholeIn(form.maxIssues, LIMITS.issues.min, LIMITS.issues.max);
  const hours = wholeIn(form.maxHours, LIMITS.hours.min, LIMITS.hours.max);
  const spend = parseSpend(form.maxSpend);
  return {
    repository: repositoryName ?? "…",
    issues: issues === null ? "…" : String(issues),
    hours: hours === null ? "…" : String(hours),
    spend: spend === null ? "…" : formatDollars(spend, locale),
    mode: form.continueMode,
  };
}
