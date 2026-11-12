import { assertEquals, assertThrows } from "@std/assert";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { draftIsolationOptionsFor } from "../../apps/server/src/modules/knowledge/draft-isolation.ts";

// The server's draft isolation launcher comes from RuntimeConfig, read once
// with the rest of the environment; the app never reads the environment
// itself, so a production app run with a scoped --allow-env starts (#306).
const server = {
  BAKERY_APP_DATABASE_URL: "postgres://app@127.0.0.1:5432/bakery",
  BETTER_AUTH_SECRET: "s".repeat(32),
};

Deno.test("the server config carries the draft isolation launcher", () => {
  assertEquals(
    readRuntimeConfig(server, "server").draftIsolationLauncher,
    "systemd",
  );
  assertEquals(
    readRuntimeConfig(
      { ...server, BAKERY_DRAFT_ISOLATION: "process" },
      "server",
    ).draftIsolationLauncher,
    "process",
  );
});

Deno.test("an unknown launcher fails start-up instead of falling back", () => {
  assertThrows(
    () =>
      readRuntimeConfig(
        { ...server, BAKERY_DRAFT_ISOLATION: "docker" },
        "server",
      ),
    Error,
    "DRAFT_ISOLATION_CONFIG_INVALID",
  );
});

Deno.test("a worker config has no draft isolation launcher", () => {
  assertEquals(
    readRuntimeConfig({ BAKERY_DRAFT_ISOLATION: "process" }, "worker")
      .draftIsolationLauncher,
    undefined,
  );
});

Deno.test("the app's isolation takes its launcher from the config, systemd when unset", () => {
  assertEquals(
    draftIsolationOptionsFor(
      readRuntimeConfig(
        { ...server, BAKERY_DRAFT_ISOLATION: "process" },
        "server",
      ),
    ),
    { launcher: "process" },
  );
  assertEquals(
    draftIsolationOptionsFor(readRuntimeConfig(server, "server")),
    { launcher: "systemd" },
  );
  // A config without the field (a test or tool config) never falls back to
  // the weaker process launcher.
  assertEquals(draftIsolationOptionsFor({}), { launcher: "systemd" });
});

Deno.test("createApp builds its one isolation from the config, through draftIsolationOptionsFor", async () => {
  // The behaviour of the process launcher can't be observed portably here
  // (its fixed path exists only in the container), so this rail pins the
  // hand-off itself: one isolation, built from the app's config. Ignoring
  // the config, or reading the environment again, breaks this line.
  const source = await Deno.readTextFile(
    new URL("../../apps/server/src/app.ts", import.meta.url),
  );
  const calls = source.match(/createDraftIsolation\([^;]*\);/g) ?? [];
  assertEquals(calls, [
    "createDraftIsolation(draftIsolationOptionsFor(options.config));",
  ]);
  assertEquals(/Deno\.env|process\.env/.test(source), false);
});
