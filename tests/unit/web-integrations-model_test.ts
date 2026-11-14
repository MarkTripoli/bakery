import { assertEquals } from "@std/assert";
import {
  type CheckedHealth,
  connectionHealth,
  type ConnectionStatus,
  filterRepositories,
  permissionsOf,
  savedSelection,
  SEARCH_AFTER,
  selectionChanges,
  setupSteps,
} from "../../apps/web/src/pages/integrations/model.ts";

const checkedAt = "2026-11-14T10:00:00.000Z";
const facts = (
  status: ConnectionStatus,
  lastCheckedAt: string | null = checkedAt,
) => ({
  status,
  lastCheckedAt,
});

Deno.test("each server status reads as one badge, one sentence and one fix", () => {
  const rows: ReadonlyArray<
    [ConnectionStatus, string, string, boolean, string]
  > = [
    ["enabled", "working", "success", false, "manage"],
    ["pending", "finishSetup", "neutral", true, "finishSetup"],
    ["disabled", "turnedOff", "neutral", true, "turnOn"],
    ["degraded", "needsAttention", "warning", true, "reconnect"],
    ["revoked", "removed", "danger", true, "connectAgain"],
  ];
  for (const [status, kind, tone, banner, action] of rows) {
    assertEquals(
      connectionHealth(facts(status)),
      { kind, tone, banner, action },
      status,
    );
  }
});

Deno.test("an enabled connection that was never checked says so and offers Check now", () => {
  assertEquals(connectionHealth(facts("enabled", null)).kind, "notChecked");
  assertEquals(connectionHealth(facts("enabled", null)).action, "checkNow");
  // A check the page just ran counts, even before the read catches up.
  assertEquals(
    connectionHealth(facts("enabled", null), "healthy").kind,
    "working",
  );
});

Deno.test("a check's finer answer refines a degraded connection", () => {
  const cases: ReadonlyArray<[CheckedHealth, string, string]> = [
    ["auth_required", "authRequired", "danger"],
    ["degraded", "limited", "warning"],
  ];
  for (const [checked, kind, tone] of cases) {
    const health = connectionHealth(facts("degraded"), checked);
    assertEquals([health.kind, health.tone, health.action], [
      kind,
      tone,
      "reconnect",
    ]);
  }
  // An unknown or healthy answer leaves the connection's own status standing.
  assertEquals(
    connectionHealth(facts("degraded"), "unknown").kind,
    "needsAttention",
  );
  assertEquals(
    connectionHealth(facts("degraded"), "healthy").kind,
    "needsAttention",
  );
});

Deno.test("a check never overrides a connection that is off, removed or not set up", () => {
  for (const status of ["disabled", "revoked", "pending"] as const) {
    const plain = connectionHealth(facts(status));
    assertEquals(
      connectionHealth(facts(status), "auth_required"),
      plain,
      status,
    );
    assertEquals(connectionHealth(facts(status), "degraded"), plain, status);
  }
});

Deno.test("setup steps show only while a connection waits to be set up", () => {
  for (
    const status of ["enabled", "disabled", "degraded", "revoked"] as const
  ) {
    assertEquals(setupSteps(facts(status), 3), null, status);
  }
  const pending = facts("pending");
  assertEquals(setupSteps(pending, 0), [
    { id: "install", status: "done" },
    { id: "repositories", status: "waiting" },
    { id: "turnOn", status: "upcoming" },
  ]);
  assertEquals(setupSteps(pending, 2), [
    { id: "install", status: "done" },
    { id: "repositories", status: "done" },
    { id: "turnOn", status: "waiting" },
  ]);
  // Before the repositories are read, nothing is claimed done.
  assertEquals(setupSteps(pending, null)?.[1]?.status, "waiting");
});

Deno.test("granted permissions list the known ones first in a fixed order", () => {
  assertEquals(
    permissionsOf({
      checks: "write",
      contents: "write",
      metadata: "read",
      zeta: "admin",
      issues: "write",
      pull_requests: "write",
    }),
    [
      { key: "metadata:read", known: "metadata:read" },
      { key: "contents:write", known: "contents:write" },
      { key: "issues:write", known: "issues:write" },
      { key: "pull_requests:write", known: "pull_requests:write" },
      { key: "checks:write", known: "checks:write" },
      { key: "zeta:admin", known: null },
    ],
  );
  assertEquals(permissionsOf({}), []);
});

Deno.test("saving a selection sends the differences, adding before removing", () => {
  const saved = [
    { id: "a", selected: true },
    { id: "b", selected: false },
    { id: "c", selected: true },
    { id: "d", selected: false },
  ];
  assertEquals([...savedSelection(saved)], ["a", "c"]);
  assertEquals(selectionChanges(saved, new Set(["a", "c"])), []);
  assertEquals(selectionChanges(saved, new Set(["b", "c", "d"])), [
    { id: "b", selected: true },
    { id: "d", selected: true },
    { id: "a", selected: false },
  ]);
  // Ticking a repository that is not in the loaded list changes nothing.
  assertEquals(selectionChanges(saved, new Set(["a", "c", "zz"])), []);
});

Deno.test("the repository filter ignores case and spacing and keeps order", () => {
  const items = [
    { name: "Acme/Billing" },
    { name: "acme/web" },
    { name: "other/tools" },
  ];
  assertEquals(filterRepositories(items, "  ACME "), [items[0], items[1]]);
  assertEquals(filterRepositories(items, ""), items);
  assertEquals(filterRepositories(items, "nothing"), []);
  assertEquals(SEARCH_AFTER, 10);
});
