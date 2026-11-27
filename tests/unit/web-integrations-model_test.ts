import { assertEquals } from "@std/assert";
import {
  type CheckedHealth,
  connectionHealth,
  type ConnectionStatus,
  filterRepositories,
  isTicked,
  permissionsOf,
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
    { id: "repositories", status: "current" },
    { id: "turnOn", status: "upcoming" },
  ]);
  assertEquals(setupSteps(pending, 2), [
    { id: "install", status: "done" },
    { id: "repositories", status: "done" },
    { id: "turnOn", status: "current" },
  ]);
  // Before the repositories are read, nothing is claimed done.
  assertEquals(setupSteps(pending, null)?.[1]?.status, "current");
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
  // The contract types the map as unknown, so anything else reads as none.
  for (
    const odd of [null, undefined, "contents:write", 7, ["contents:write"]]
  ) {
    assertEquals(permissionsOf(odd), [], String(odd));
  }
  assertEquals(permissionsOf({ contents: "write", note: 3 }), [
    { key: "contents:write", known: "contents:write" },
  ]);
});

Deno.test("saving a selection sends what was toggled, adding before removing", () => {
  const saved = [
    { id: "a", selected: true },
    { id: "b", selected: false },
    { id: "c", selected: true },
    { id: "d", selected: false },
  ];
  assertEquals(selectionChanges(saved, new Set()), []);
  assertEquals(selectionChanges(saved, new Set(["b", "d"])), [
    { id: "b", selected: true },
    { id: "d", selected: true },
  ]);
  assertEquals(selectionChanges(saved, new Set(["a"])), [
    { id: "a", selected: false },
  ]);
  // A swap adds first, so a connection that is on is never left with none.
  assertEquals(selectionChanges(saved, new Set(["a", "b", "c"])), [
    { id: "b", selected: true },
    { id: "a", selected: false },
    { id: "c", selected: false },
  ]);
  // Toggling something that is not in the loaded list changes nothing.
  assertEquals(selectionChanges(saved, new Set(["zz"])), []);
});

Deno.test("a repository loaded after the edit began keeps what was saved for it", () => {
  const page1 = [{ id: "a", selected: false }, { id: "b", selected: false }];
  const toggled = new Set(["b"]);
  // The next page arrives with a repository that is already selected.
  const both = [...page1, { id: "x", selected: true }];
  assertEquals(selectionChanges(page1, toggled), [{ id: "b", selected: true }]);
  assertEquals(selectionChanges(both, toggled), [{ id: "b", selected: true }]);
  assertEquals(both.map((item) => isTicked(item, toggled)), [
    false,
    true,
    true,
  ]);
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

Deno.test("a check that never reached the provider does not read as working", () => {
  const after = {
    status: "enabled",
    lastCheckedAt: "2026-11-27T10:00:00.000Z",
    health: "unknown",
  } as const;
  assertEquals(connectionHealth(after).kind, "notChecked");
  assertEquals(connectionHealth(after, "unknown").kind, "notChecked");
  assertEquals(
    connectionHealth({ ...after, health: "healthy" }).kind,
    "working",
  );
});

Deno.test("a degraded connection that reports its scopes says which way it is degraded", () => {
  const degraded = {
    status: "degraded",
    lastCheckedAt: null,
    grantedScopeNames: ["chat:write"],
  } as const;
  assertEquals(
    connectionHealth({ ...degraded, health: "degraded" }).kind,
    "limited",
  );
  assertEquals(
    connectionHealth({ ...degraded, health: "auth_required" }).kind,
    "authRequired",
  );
  assertEquals(
    connectionHealth({
      ...degraded,
      health: "degraded",
      grantedScopeNames: null,
    }).kind,
    "needsAttention",
  );
});
