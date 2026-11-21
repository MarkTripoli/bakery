import { assert, assertEquals } from "@std/assert";
import {
  availablePlugins,
  capabilitiesOf,
  installedPlugins,
  latestVersion,
  type PluginInstall,
  type PluginPackage,
  type PluginVersion,
} from "../../apps/web/src/app/plugins.ts";

const org = "00000000-0000-4000-8000-000000000001";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const pkg = (n: number, displayName: string): PluginPackage => ({
  id: id(n),
  organizationId: org,
  name: displayName.toLowerCase(),
  displayName,
  provenance: {},
  license: "MIT",
  visibility: "private",
  listingStatus: "unlisted",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  version: 1,
} as PluginPackage);

const ver = (
  n: number,
  packageId: string,
  versionName: string,
  publishedAt: string | null,
  requested: string[] = [],
): PluginVersion => ({
  id: id(n),
  organizationId: org,
  pluginPackageId: packageId,
  versionName,
  sdkRange: "^1",
  manifest: { requestedCapabilities: requested },
  bundleDigest: "sha256:" + "a".repeat(64),
  sourceEvidence: {},
  buildEvidence: {},
  publishedAt,
  createdAt: publishedAt ?? "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  version: 1,
} as PluginVersion);

const install = (
  n: number,
  packageId: string,
  versionId: string,
  status: string,
  scope = "organization",
): PluginInstall => ({
  id: id(n),
  organizationId: org,
  pluginPackageId: packageId,
  pluginVersionId: versionId,
  scope,
  ownerPrincipalId: scope === "personal" ? id(99) : null,
  status,
  stateSchemaVersion: 1,
  activatedAt: null,
  disabledAt: null,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  version: 3,
} as PluginInstall);

const notes = pkg(1, "Notes");
const board = pkg(2, "Board");
const v1 = ver(11, notes.id, "1.0.0", "2026-11-03T00:00:00.000Z");
const v2 = ver(12, notes.id, "1.1.0", "2026-11-05T00:00:00.000Z", [
  "ui.page",
  "state.read",
]);
const draft = ver(13, notes.id, "2.0.0-draft", null);
const b1 = ver(21, board.id, "0.3.0", "2026-11-04T00:00:00.000Z");
const versions = new Map([
  [notes.id, [v1, v2, draft]],
  [board.id, [b1]],
]);

Deno.test("the latest version is the newest one that finished publishing", () => {
  assertEquals(latestVersion([v1, v2, draft])?.id, v2.id);
  assertEquals(latestVersion([draft]), null);
  assertEquals(latestVersion([]), null);
});

Deno.test("an install shows its state in words and offers an update only when newer", () => {
  const rows = installedPlugins(
    [
      install(31, notes.id, v1.id, "enabled"),
      install(32, board.id, b1.id, "staged"),
    ],
    [notes, board],
    versions,
  );
  assertEquals(rows.map((row) => [row.name, row.state, row.versionName]), [
    ["Board", "ready", "0.3.0"],
    ["Notes", "on", "1.0.0"],
  ]);
  assertEquals(rows[1].update, { versionId: v2.id, versionName: "1.1.0" });
  assertEquals(rows[0].update, null);
  assertEquals(rows[1].installVersion, 3);
});

Deno.test("no update is offered on the newest version, or over an unfinished one", () => {
  const rows = installedPlugins(
    [
      install(33, notes.id, v2.id, "disabled"),
    ],
    [notes],
    versions,
  );
  assertEquals(rows[0].state, "off");
  assertEquals(rows[0].update, null);
});

Deno.test("a removed install is not listed, and a failed one reads not working", () => {
  const rows = installedPlugins(
    [
      install(34, notes.id, v1.id, "uninstalled"),
      install(35, board.id, b1.id, "failed"),
    ],
    [notes, board],
    versions,
  );
  assertEquals(rows.map((row) => [row.name, row.state]), [[
    "Board",
    "notWorking",
  ]]);
});

Deno.test("available lists what is published and not installed for the organization", () => {
  const none = availablePlugins([], [notes, board], versions);
  assertEquals(none.map((row) => [row.name, row.versionName]), [
    ["Board", "0.3.0"],
    ["Notes", "1.1.0"],
  ]);

  const orgInstalled = availablePlugins(
    [install(36, notes.id, v1.id, "enabled")],
    [notes, board],
    versions,
  );
  assertEquals(orgInstalled.map((row) => row.name), ["Board"]);

  // Installed only privately: still available to the organization, and marked.
  const privateOnly = availablePlugins(
    [install(37, notes.id, v1.id, "enabled", "personal")],
    [notes, board],
    versions,
  );
  assertEquals(privateOnly.map((row) => [row.name, row.havePrivately]), [
    ["Board", false],
    ["Notes", true],
  ]);

  // A removed install no longer counts.
  assertEquals(
    availablePlugins(
      [install(38, notes.id, v1.id, "uninstalled")],
      [notes],
      versions,
    ).map((row) => [row.name, row.havePrivately]),
    [["Notes", false]],
  );
});

Deno.test("a plugin with nothing finished publishing is not offered", () => {
  const only = new Map([[notes.id, [draft]]]);
  assertEquals(availablePlugins([], [notes], only), []);
});

Deno.test("what a version can do is its manifest's list, in the page's order", () => {
  assertEquals(capabilitiesOf(v2), ["state.read", "ui.page"]);
  assertEquals(capabilitiesOf(v1), []);
  assert(
    capabilitiesOf(
      ver(41, notes.id, "x", null, ["bogus", "jobs.schedule"]),
    ).join() === "jobs.schedule",
    "anything outside the fixed list is ignored",
  );
});

Deno.test("what a move between versions adds and takes away", async () => {
  const { capabilityDifference } = await import(
    "../../apps/web/src/app/plugins.ts"
  );
  assertEquals(
    capabilityDifference(["state.read", "ui.page"], [
      "ui.page",
      "jobs.schedule",
    ]),
    { added: ["jobs.schedule"], removed: ["state.read"] },
  );
  assertEquals(capabilityDifference(["ui.page"], ["ui.page"]), {
    added: [],
    removed: [],
  });
});

Deno.test("who may change an install and who may install", async () => {
  const { mayChangeInstall, mayInstall } = await import(
    "../../apps/web/src/app/plugins.ts"
  );
  const me = id(50);
  const admin = { role: "admin" as const, principalId: id(60) };
  const dev = { role: "developer" as const, principalId: me };
  const viewer = { role: "viewer" as const, principalId: id(61) };
  const orgInstall = { scope: "organization" as const, ownerPrincipalId: null };
  const mine = { scope: "personal" as const, ownerPrincipalId: me };
  assertEquals(mayChangeInstall(orgInstall, admin), true);
  assertEquals(mayChangeInstall(orgInstall, dev), false);
  assertEquals(mayChangeInstall(mine, dev), true);
  // An administrator does not change someone else's private install.
  assertEquals(mayChangeInstall(mine, admin), false);
  assertEquals(mayInstall("organization", admin), true);
  assertEquals(mayInstall("organization", dev), false);
  assertEquals(mayInstall("personal", dev), true);
  assertEquals(mayInstall("personal", viewer), false);
});

Deno.test("the recorded failure is read off an install, and a malformed one is ignored", async () => {
  const { updateFailureOf, installedPlugins } = await import(
    "../../apps/web/src/app/plugins.ts"
  );
  const failure = {
    versionId: v2.id,
    versionName: "1.1.0",
    reason: "plugin_sdk_incompatible",
    at: "2026-11-19T21:00:00.000Z",
  };
  const withFailure = {
    ...install(61, notes.id, v1.id, "enabled"),
    lastUpdateFailure: failure,
  } as PluginInstall;
  assertEquals(updateFailureOf(withFailure), failure);
  assertEquals(updateFailureOf(undefined), null);
  assertEquals(
    updateFailureOf({ lastUpdateFailure: null } as PluginInstall),
    null,
  );
  assertEquals(
    updateFailureOf(
      { lastUpdateFailure: { versionId: 7 } } as unknown as PluginInstall,
    ),
    null,
  );
  const rows = installedPlugins([withFailure], [notes], versions);
  assertEquals(rows[0].updateFailure, failure);
});

Deno.test("a fingerprint shows its first 8 and last 4 characters", async () => {
  const { shortFingerprint } = await import(
    "../../apps/web/src/app/plugins.ts"
  );
  assertEquals(shortFingerprint("sha256:" + "ab".repeat(32)), "abababab…abab");
  assertEquals(
    shortFingerprint("sha256:0123456789abcdef0123456789abcdef"),
    "01234567…cdef",
  );
  assertEquals(shortFingerprint("sha256:abc"), "abc");
});

Deno.test("sizes read in bytes, KB and MB", async () => {
  const { formatBytes } = await import("../../apps/web/src/app/plugins.ts");
  assertEquals(formatBytes(0, "en"), "0 B");
  assertEquals(formatBytes(812, "en"), "812 B");
  assertEquals(formatBytes(1536, "en"), "1.5 KB");
  assertEquals(formatBytes(5 * 1024 * 1024, "en"), "5 MB");
});

Deno.test("the publisher's details become rows in the publisher's words, judged by nothing", async () => {
  const { evidenceRows } = await import("../../apps/web/src/app/plugins.ts");
  assertEquals(
    evidenceRows({
      repository: "example/notes",
      checks: ["typecheck", "lint"],
      status: "passed",
      nested: { a: 1 },
      empty: null,
    }),
    [
      { name: "repository", value: "example/notes" },
      { name: "checks", value: "typecheck, lint" },
      { name: "status", value: "passed" },
      { name: "nested", value: '{"a":1}' },
      { name: "empty", value: "" },
    ],
  );
  // Not an object: nothing to show rather than a guess.
  assertEquals(evidenceRows(null), []);
  assertEquals(evidenceRows("text"), []);
  assertEquals(evidenceRows(["a"]), []);
});
