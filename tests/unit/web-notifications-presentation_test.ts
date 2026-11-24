import { assert, assertEquals } from "@std/assert";
import {
  bellAccessibleName,
  bellStatusOf,
  DAY_GROUP_ORDER,
  dayGroupOf,
  groupByDay,
  isMentionKind,
  isNotificationView,
  NOTIFICATION_COPY,
  NOTIFICATION_VIEWS,
} from "../../apps/web/src/notifications/presentation.ts";
import { englishCatalog } from "../../packages/i18n/src/catalog.ts";

const KINDS = [
  "mention",
  "comment_mention",
  "comment",
  "run_completed",
  "run_failed",
  "step_failed",
  "approval_requested",
  "question_asked",
  "document_version",
] as const;

Deno.test("an unknown count is never drawn as zero", () => {
  // The bell's hollow ring exists for exactly this: a confident 0 that later
  // turns out wrong is worse than admitting the number is not known yet.
  assertEquals(bellStatusOf(null), { state: "unknown" });
  assertEquals(bellStatusOf(undefined), { state: "unknown" });
  // A failed read with no cached value is unknown, not empty.
  assertEquals(bellStatusOf(null, true), { state: "unknown" });
  assertEquals(bellStatusOf(0), { state: "none" });
  assertEquals(bellStatusOf(3), { state: "unread", count: 3 });
  assertEquals(bellStatusOf(128), { state: "unread", count: 128 });
});

Deno.test("every kind has wording, and every string exists in the catalog", () => {
  assertEquals(Object.keys(NOTIFICATION_COPY).sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    const copy = NOTIFICATION_COPY[kind];
    assert(copy.headline in englishCatalog, `${kind} headline is translated`);
    if (copy.destination !== undefined) {
      assert(
        copy.destination in englishCatalog,
        `${kind} destination is translated`,
      );
    }
  }
});

Deno.test("the kinds with no person behind them draw an event tile", () => {
  // A person caused the first three; the rest are the system reporting itself,
  // so the actor lane must not pretend there is an avatar.
  for (const kind of ["mention", "comment_mention", "comment"] as const) {
    assertEquals(NOTIFICATION_COPY[kind].lane, "person");
  }
  for (
    const kind of [
      "run_completed",
      "run_failed",
      "step_failed",
      "approval_requested",
      "question_asked",
      "document_version",
    ] as const
  ) {
    assertEquals(NOTIFICATION_COPY[kind].lane, "event");
    assert(NOTIFICATION_COPY[kind].tile, `${kind} names its tile`);
  }
});

Deno.test("only the two mention kinds reach the Mentions view", () => {
  assertEquals(
    KINDS.filter(isMentionKind),
    ["mention", "comment_mention"],
  );
});

Deno.test("the views are exactly the contract's three spellings", () => {
  assertEquals([...NOTIFICATION_VIEWS], ["all", "unread", "mentions"]);
  for (const view of NOTIFICATION_VIEWS) assert(isNotificationView(view));
  for (const other of ["", "archived", "ALL", null, 3, undefined]) {
    assertEquals(isNotificationView(other), false);
  }
});

Deno.test("day groups follow the viewer's calendar, not the server's", () => {
  // A date built at local midnight must land in that local day whatever the
  // host time zone is, which is why this is compared as a group and not as a
  // raw timestamp.
  const now = new Date();
  const daysAgo = (n: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - n);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  };
  assertEquals(dayGroupOf(daysAgo(0), now), "today");
  assertEquals(dayGroupOf(daysAgo(1), now), "yesterday");
  assertEquals(dayGroupOf(daysAgo(3), now), "thisWeek");
  assertEquals(dayGroupOf(daysAgo(30), now), "older");
  // A future timestamp (clock skew between hosts) reads as today, never a
  // negative day count.
  assertEquals(dayGroupOf(daysAgo(-1), now), "today");
});

Deno.test("grouping keeps newest-first order and drops empty headings", () => {
  const now = new Date();
  const at = (n: number, id: string) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
    d.setHours(12, 0, 0, 0);
    return { id, createdAt: d.toISOString() };
  };
  const rows = [
    at(0, "a"),
    at(0, "b"),
    at(2, "c"),
    at(40, "d"),
  ] as never[];
  const groups = groupByDay(rows, now);
  assertEquals(groups.map(([group]) => group), ["today", "thisWeek", "older"]);
  assertEquals(groups[0][1].map((row) => row.id), ["a", "b"]);
  // "yesterday" had no rows, so it must not draw an empty heading.
  assertEquals(groups.some(([group]) => group === "yesterday"), false);
  assertEquals([...DAY_GROUP_ORDER], [
    "today",
    "yesterday",
    "thisWeek",
    "older",
  ]);
});

Deno.test("the bell's name carries the true count, not the drawn cap", () => {
  // The badge is a drawn cap ("99+"), so the name is the only place the real
  // number survives. Both ways the bell reaches the screen take the name from
  // here, so a screen reader hears the count on a phone and on a desktop
  // instead of the desktop trigger announcing a bare "Notifications".
  const translate = (key: string, values?: Record<string, unknown>) =>
    key === "notifications.bell.unread"
      ? `Notifications, ${values?.count} unread`
      : key === "notifications.bell.unknown"
      ? "Notifications, count unavailable"
      : key === "notifications.bell.noneUnread"
      ? "Notifications, none unread"
      : "Notifications";

  assertEquals(
    bellAccessibleName({ state: "unread", count: 6 }, translate),
    "Notifications, 6 unread",
  );
  assertEquals(
    bellAccessibleName({ state: "unread", count: 120 }, translate),
    "Notifications, 120 unread",
  );
  assertEquals(
    bellAccessibleName({ state: "unknown" }, translate),
    "Notifications, count unavailable",
  );
  assertEquals(
    bellAccessibleName({ state: "none" }, translate),
    "Notifications, none unread",
  );
});
