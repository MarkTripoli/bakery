import { assertEquals, assertThrows } from "@std/assert";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";

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
