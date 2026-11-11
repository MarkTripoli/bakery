import { assertEquals } from "@std/assert";
import {
  readWorkerConfig,
  readWorkerLaunchPermissions,
} from "../../apps/worker/src/config.ts";
import { createDispatchLaunch } from "../../apps/server/scripts/run-dispatch.ts";

const workerEnvironment = {
  BAKERY_SERVER_URL: "http://127.0.0.1:8000",
  BAKERY_WORKER_STATE_DIR: "/tmp/bakery-sentry-worker-state",
  BAKERY_WORKER_CAPABILITIES: "git",
  BAKERY_SENTRY_ENABLED: "true",
  BAKERY_SENTRY_ENVIRONMENT: "preview",
  BAKERY_SENTRY_RELEASE: "bakery@test-release",
  BAKERY_WORKER_SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/123",
};

Deno.test("enabled worker grants only its API and project ingest host, without new filesystem or system authority", () => {
  const disabled = readWorkerLaunchPermissions({
    ...workerEnvironment,
    BAKERY_SENTRY_ENABLED: "false",
  }, "/workspace");
  const enabled = readWorkerLaunchPermissions(workerEnvironment, "/workspace");
  assertEquals(enabled.net, ["127.0.0.1:8000", "o1.ingest.us.sentry.io:443"]);
  assertEquals(enabled.read, disabled.read);
  assertEquals(enabled.write, disabled.write);
  assertEquals(enabled.run, disabled.run);
  assertEquals(enabled.sys, disabled.sys);
  assertEquals(readWorkerConfig(workerEnvironment).sentry?.enabled, true);
});

Deno.test("test worker never grants ingest authority despite an explicit telemetry override", () => {
  const environment = { ...workerEnvironment, BAKERY_ENV: "test" };
  assertEquals(readWorkerConfig(environment).sentry, { enabled: false });
  assertEquals(readWorkerLaunchPermissions(environment, "/workspace").net, [
    "127.0.0.1:8000",
  ]);
});

Deno.test("dispatch receives API telemetry configuration while excluding browser, worker and build credentials", () => {
  const inherited = {
    ...workerEnvironment,
    PATH: "/usr/bin",
    BAKERY_SERVER_SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/456",
    BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
    VITE_SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/789",
    SENTRY_AUTH_TOKEN: "build-secret-sentinel",
    BETTER_AUTH_SECRET: "auth-secret-sentinel",
  };
  const launch = createDispatchLaunch("src/dispatch.ts", inherited);
  assertEquals(launch.clearEnv, true);
  assertEquals(
    launch.env.BAKERY_SERVER_SENTRY_DSN,
    inherited.BAKERY_SERVER_SENTRY_DSN,
  );
  assertEquals(
    launch.env.BAKERY_SENTRY_RELEASE,
    inherited.BAKERY_SENTRY_RELEASE,
  );
  assertEquals(
    launch.env.BAKERY_PUBLIC_BASE_URL,
    inherited.BAKERY_PUBLIC_BASE_URL,
  );
  for (
    const excluded of [
      "BAKERY_WORKER_SENTRY_DSN",
      "VITE_SENTRY_DSN",
      "SENTRY_AUTH_TOKEN",
      "BETTER_AUTH_SECRET",
    ]
  ) {
    assertEquals(launch.env[excluded], undefined);
  }
});
