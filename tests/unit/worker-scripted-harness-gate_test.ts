import { assertEquals, assertThrows } from "@std/assert";
import {
  readWorkerConfig,
  readWorkerLaunchPermissions,
} from "../../apps/worker/src/config.ts";

const base = {
  BAKERY_SERVER_URL: "http://127.0.0.1:8000",
  BAKERY_WORKER_STATE_DIR: "/tmp/bakery-worker-state",
  BAKERY_WORKER_CAPABILITIES: "git",
};
const dir = "/tmp/bakery-scripted-harness";

Deno.test("the scripted harness directory is rejected outside the test environment", () => {
  for (const BAKERY_ENV of ["production", "development", undefined]) {
    const env = {
      ...base,
      ...(BAKERY_ENV === undefined ? {} : { BAKERY_ENV }),
      BAKERY_WORKER_SCRIPTED_HARNESS_DIR: dir,
    };
    if (BAKERY_ENV === "production") {
      env.BAKERY_SERVER_URL = "https://bakery.example.test";
    }
    assertThrows(
      () => readWorkerConfig(env),
      Error,
      "BAKERY_WORKER_SCRIPTED_HARNESS_DIR_TEST_ONLY",
    );
    assertThrows(
      () => readWorkerLaunchPermissions(env, "/workspace"),
      Error,
      "BAKERY_WORKER_SCRIPTED_HARNESS_DIR_TEST_ONLY",
    );
  }
});

Deno.test("the test environment accepts the directory and grants only that path", () => {
  const env = {
    ...base,
    BAKERY_ENV: "test",
    BAKERY_WORKER_SCRIPTED_HARNESS_DIR: dir,
  };
  assertEquals(readWorkerConfig(env).scriptedHarnessDir, dir);
  const permissions = readWorkerLaunchPermissions(env, "/workspace");
  assertEquals(permissions.read.includes(dir), true);
  assertEquals(permissions.write.includes(dir), true);
  assertEquals(
    readWorkerConfig({ ...base, BAKERY_ENV: "test" }).scriptedHarnessDir,
    undefined,
  );
  assertEquals(
    readWorkerLaunchPermissions({ ...base, BAKERY_ENV: "test" }, "/workspace")
      .write.includes(dir),
    false,
  );
});

Deno.test("a relative scripted harness directory is invalid", () => {
  assertThrows(
    () =>
      readWorkerConfig({
        ...base,
        BAKERY_ENV: "test",
        BAKERY_WORKER_SCRIPTED_HARNESS_DIR: "relative/dir",
      }),
    Error,
    "BAKERY_WORKER_SCRIPTED_HARNESS_DIR",
  );
});
