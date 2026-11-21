import { assertEquals } from "@std/assert";
import {
  automaticSinceOf,
  badgeOf,
  countsOf,
  formOf,
  isDirty,
  isSavable,
  labelIsUnsafe,
  policyOfForm,
  problemsOf,
  readAgeOf,
  type SettingsForm,
} from "../../apps/web/src/pages/issues/settings-model.ts";
import type { TicketSourceResponse } from "../../apps/web/src/api/client.ts";

const source = (
  policy: unknown,
  extra: Partial<TicketSourceResponse> = {},
): TicketSourceResponse =>
  ({
    id: "source-1",
    enabled: true,
    policy,
    policyRevision: 3,
    syncHealth: "healthy",
    lastSyncedAt: "2026-11-16T12:00:00Z",
    lastProblemCode: null,
    version: 7,
    ...extra,
  }) as TicketSourceResponse;

const policy = (over: Record<string, unknown> = {}) => ({
  version: 1,
  labels: { execute: "bakery", planOnly: null, hold: "hold" },
  delegation: null,
  automatic: { enabled: false, since: null },
  readiness: { requireAcceptanceCriteria: true },
  approval: { plan: "human_approval" },
  preset: "fixed-coding",
  ...over,
});

const form = (over: Partial<SettingsForm> = {}): SettingsForm => ({
  ...formOf(source(policy())),
  ...over,
});

Deno.test("a label name is unsafe when the schema says so", () => {
  assertEquals(labelIsUnsafe("bakery"), false);
  assertEquals(labelIsUnsafe(" ready for agent "), true);
  assertEquals(labelIsUnsafe(""), true);
  assertEquals(labelIsUnsafe("x".repeat(51)), true);
  assertEquals(labelIsUnsafe("bad\tlabel"), true);
  assertEquals(labelIsUnsafe("see https://example.test"), true);
  assertEquals(labelIsUnsafe("a {{b}}"), true);
  assertEquals(labelIsUnsafe("cost ${x}"), true);
});

Deno.test("a saved policy fills the form, and a missing one gives the defaults", () => {
  const saved = formOf(source(policy({
    labels: { execute: "go", planOnly: "plan", hold: "stop" },
    delegation: { principalId: "principal-1", externalActorIds: ["42", "43"] },
    automatic: { enabled: true, since: "2026-11-01T00:00:00Z" },
    readiness: { requireAcceptanceCriteria: false },
    approval: { plan: "automatic" },
  })));
  assertEquals(saved.start, "go");
  assertEquals(saved.planOnly, true);
  assertEquals(saved.planOnlyLabel, "plan");
  assertEquals(saved.hold, "stop");
  assertEquals(saved.requireAcceptanceCriteria, false);
  assertEquals(saved.approval, "automatic");
  assertEquals(saved.automatic, true);
  assertEquals(saved.principalId, "principal-1");
  assertEquals(saved.people.map((one) => one.id), ["42", "43"]);
  assertEquals(saved.people.map((one) => one.login), [null, null]);

  const fresh = formOf(null);
  assertEquals(fresh.enabled, false);
  assertEquals(fresh.start, "bakery");
  assertEquals(fresh.hold, "hold");
  assertEquals(fresh.planOnly, false);
  assertEquals(fresh.requireAcceptanceCriteria, true);
  assertEquals(fresh.approval, "human_approval");
  assertEquals(fresh.automatic, false);
  assertEquals(fresh.people, []);
});

Deno.test("the automatic window is read from the server, never from the form", () => {
  assertEquals(automaticSinceOf(source(policy())), null);
  assertEquals(
    automaticSinceOf(
      source(policy({
        automatic: { enabled: true, since: "2026-11-01T00:00:00Z" },
      })),
    ),
    "2026-11-01T00:00:00Z",
  );
  // The policy the form sends never carries the instant.
  const sent = policyOfForm(
    form({
      automatic: true,
      principalId: "p",
      people: [{ id: "42", login: "ada" }],
    }),
  );
  assertEquals(sent.automatic, { enabled: true });
});

Deno.test("problems name the field, and two equal labels are one problem", () => {
  assertEquals(problemsOf(form()), {});
  assertEquals(problemsOf(form({ start: "  " })), { start: "empty" });
  assertEquals(problemsOf(form({ hold: "a\tb" })), { hold: "unsafe" });
  assertEquals(
    problemsOf(form({ planOnly: true, planOnlyLabel: "" })),
    { planOnlyLabel: "empty" },
  );
  assertEquals(
    problemsOf(form({ start: "Bakery", hold: "bakery" })),
    { sameLabels: true },
  );
  // Automatic start needs someone to run as and someone who may trigger it.
  assertEquals(problemsOf(form({ automatic: true })), {
    principal: "missing",
    people: "missing",
  });
  assertEquals(
    isSavable(
      form({
        automatic: true,
        principalId: "p",
        people: [{ id: "42", login: null }],
      }),
    ),
    true,
  );
});

Deno.test("dirty compares the form with the saved policy, including the people", () => {
  const saved = source(policy({
    delegation: { principalId: "principal-1", externalActorIds: ["42"] },
    automatic: { enabled: true, since: "2026-11-01T00:00:00Z" },
  }));
  const unchanged = formOf(saved);
  assertEquals(isDirty(unchanged, saved), false);
  assertEquals(isDirty({ ...unchanged, start: "other" }, saved), true);
  assertEquals(
    isDirty(
      { ...unchanged, people: [{ id: "42", login: "ada" }] },
      saved,
    ),
    false,
  );
  assertEquals(
    isDirty({ ...unchanged, people: [{ id: "43", login: null }] }, saved),
    true,
  );
  // A saved delegation survives a save that does not touch automatic start.
  const sent = policyOfForm(unchanged);
  assertEquals(sent.delegation, {
    principalId: "principal-1",
    externalActorIds: ["42"],
  });
  assertEquals(isDirty(formOf(null), null), false);
});

Deno.test("the badge uses the Issues page's trouble mapping", () => {
  assertEquals(badgeOf(source(policy(), { syncHealth: "healthy" })), "working");
  assertEquals(
    badgeOf(source(policy(), { syncHealth: "degraded" })),
    "trouble",
  );
  assertEquals(
    badgeOf(source(policy(), { syncHealth: "auth_required" })),
    "reconnecting",
  );
  assertEquals(
    badgeOf(source(policy(), { syncHealth: "unknown", lastSyncedAt: null })),
    "trouble",
  );
  // A repository that never took issues has nothing to report yet.
  assertEquals(badgeOf(null), "notReadYet");
});

Deno.test("how long ago the read was, in whole units", () => {
  const now = Date.parse("2026-11-16T12:30:00Z");
  assertEquals(readAgeOf(source(policy()), now), { unit: "minute", count: 30 });
  assertEquals(readAgeOf(source(policy(), { lastSyncedAt: null }), now), null);
});

Deno.test("the counts come from each issue's own verdict, and say when they were read", () => {
  const counts = countsOf([
    {
      latestReadiness: {
        verdict: "ready",
        evaluatedAt: "2026-11-16T10:00:00Z",
      },
    },
    {
      latestReadiness: {
        verdict: "waiting",
        evaluatedAt: "2026-11-16T11:00:00Z",
      },
    },
    {
      latestReadiness: {
        verdict: "rejected",
        evaluatedAt: "2026-11-16T09:00:00Z",
      },
    },
    // Nobody has judged this one: it waits, and it cannot move the read time.
    { latestReadiness: null },
  ]);
  assertEquals(counts.canStart, 1);
  assertEquals(counts.waiting, 2);
  assertEquals(counts.cannotStart, 1);
  assertEquals(counts.evaluatedAt, "2026-11-16T09:00:00Z");
  assertEquals(countsOf([]), {
    canStart: 0,
    waiting: 0,
    cannotStart: 0,
    evaluatedAt: null,
  });
});
