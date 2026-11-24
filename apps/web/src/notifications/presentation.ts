import type { MessageKey, Translator } from "@bakery/i18n";
import type { NotificationResponse } from "../api/client.ts";

/** The kinds the contract defines, in the order the design's table lists them. */
export type NotificationKind = NotificationResponse["kind"];

export type NotificationCopy = Readonly<{
  /** Which lane the row draws: a person's avatar or an event tile. */
  readonly lane: "person" | "event";
  /** The event tile when there is no person behind the notification. */
  readonly tile?: "check" | "warning" | "shield" | "question" | "document";
  /** Line 1's message, with the arguments it needs. */
  readonly headline: MessageKey;
  /**
   * Line 2's message when the generic destination title is wrong for the kind,
   * such as a document version that reads "Version 3 · Task title".
   */
  readonly destination?: MessageKey;
}>;

/**
 * One row's wording, chosen by kind alone. The kind is a stable code, so this
 * map is the only place that knows what a kind is called: the row never shows
 * an internal action name, an id, or a raw enum.
 */
export const NOTIFICATION_COPY: Readonly<
  Record<NotificationKind, NotificationCopy>
> = Object.freeze({
  mention: {
    lane: "person",
    headline: "notifications.kind.mention",
  },
  comment_mention: {
    lane: "person",
    headline: "notifications.kind.commentMention",
  },
  comment: {
    lane: "person",
    headline: "notifications.kind.comment",
  },
  run_completed: {
    lane: "event",
    tile: "check",
    headline: "notifications.kind.runCompleted",
  },
  run_failed: {
    lane: "event",
    tile: "warning",
    headline: "notifications.kind.runFailed",
  },
  step_failed: {
    lane: "event",
    tile: "warning",
    headline: "notifications.kind.stepFailed",
  },
  approval_requested: {
    lane: "event",
    tile: "shield",
    headline: "notifications.kind.approvalRequested",
  },
  question_asked: {
    lane: "event",
    tile: "question",
    headline: "notifications.kind.questionAsked",
  },
  document_version: {
    lane: "event",
    tile: "document",
    headline: "notifications.kind.documentVersion",
    destination: "notifications.kind.documentVersion.subtitle",
  },
});

/**
 * The document's own version number, from the anchor the server writes as
 * `version:{number}`. Anything else is not a number to show, so the row
 * leaves the number out rather than print the anchor.
 */
export function versionOfAnchor(anchor: string | null): string | null {
  const match = anchor === null ? null : /^version:(\d+)$/.exec(anchor);
  return match === null ? null : match[1];
}

/** Whether the row belongs in the Mentions view. */
export function isMentionKind(kind: NotificationKind): boolean {
  return kind === "mention" || kind === "comment_mention";
}

/**
 * The three inbox views, matching the contract's filter enum. Kept here so the
 * page and the URL agree on exactly three spellings.
 */
export const NOTIFICATION_VIEWS = ["all", "unread", "mentions"] as const;
export type NotificationView = (typeof NOTIFICATION_VIEWS)[number];

export function isNotificationView(value: unknown): value is NotificationView {
  return typeof value === "string" &&
    (NOTIFICATION_VIEWS as readonly string[]).includes(value);
}

/**
 * The day heading a row falls under. Grouping is by calendar day in the
 * viewer's own time zone, so "Yesterday" means yesterday where they are, not
 * where the server is.
 */
export type NotificationDayGroup = "today" | "yesterday" | "thisWeek" | "older";

export function dayGroupOf(
  createdAt: string,
  now: Date = new Date(),
): NotificationDayGroup {
  const created = new Date(createdAt);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfCreated = new Date(
    created.getFullYear(),
    created.getMonth(),
    created.getDate(),
  );
  const days = Math.round(
    (startOfToday.getTime() - startOfCreated.getTime()) / 86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "thisWeek";
  return "older";
}

export const DAY_GROUP_ORDER: readonly NotificationDayGroup[] = [
  "today",
  "yesterday",
  "thisWeek",
  "older",
];

export const DAY_GROUP_LABEL: Readonly<
  Record<NotificationDayGroup, MessageKey>
> = Object.freeze({
  today: "notifications.group.today",
  yesterday: "notifications.group.yesterday",
  thisWeek: "notifications.group.thisWeek",
  older: "notifications.group.older",
});

/** Groups newest-first rows into the day headings, preserving their order. */
export function groupByDay(
  rows: readonly NotificationResponse[],
  now: Date = new Date(),
): readonly (readonly [
  NotificationDayGroup,
  readonly NotificationResponse[],
])[] {
  const groups = new Map<NotificationDayGroup, NotificationResponse[]>();
  for (const row of rows) {
    const group = dayGroupOf(row.createdAt, now);
    const bucket = groups.get(group);
    if (bucket) bucket.push(row);
    else groups.set(group, [row]);
  }
  return DAY_GROUP_ORDER.filter((group) => groups.has(group)).map((group) =>
    [group, groups.get(group)!] as const
  );
}

/**
 * The badge state the bell draws. `null` is an unknown count and is drawn as a
 * hollow ring; it is never folded into `0`, because a confident zero that later
 * turns out wrong is worse than admitting the number is not known yet.
 */
export type BellStatus =
  | { state: "unread"; count: number }
  | { state: "none" }
  | {
    state: "unknown";
  };

export function bellStatusOf(
  count: number | null | undefined,
  failed = false,
): BellStatus {
  if (failed || count === null || count === undefined) {
    return { state: "unknown" };
  }
  return count > 0 ? { state: "unread", count } : { state: "none" };
}

/**
 * The bell's accessible name for a status.
 *
 * The badge is a drawn cap ("99+"), so the name is where the true count lives.
 * Both ways the bell reaches the screen — its own button on a phone and a
 * popover's trigger from 744px up — take the name from here, so a screen reader
 * hears the same number either way instead of the desktop trigger announcing a
 * bare "Notifications" while the badge shows a count.
 */
export function bellAccessibleName(
  status: BellStatus,
  translate: Translator,
): string {
  switch (status.state) {
    case "unread":
      return translate("notifications.bell.unread", { count: status.count });
    case "unknown":
      return translate("notifications.bell.unknown");
    default:
      return translate("notifications.bell.label");
  }
}
