import { assertEquals, assertThrows } from "@std/assert";
import {
  readWorkerConfig,
  readWorkerEnvironment,
  WORKER_RUNTIME_ENVIRONMENT_NAMES,
} from "../../apps/worker/src/config.ts";

const HARNESS_PREFIXES = ["CODEX", "PI", "CLAUDE"] as const;

/**
 * Runs `body` with the given process environment values set and restores every
 * touched name afterwards, so the real `readWorkerEnvironment()` allow-list
 * read is what feeds the config under test.
 */
function withProcessEnvironment(
  values: Record<string, string>,
  body: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(values)) {
    previous.set(name, Deno.env.get(name));
  }
  try {
    for (const [name, value] of Object.entries(values)) {
      Deno.env.set(name, value);
    }
    body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

const workerBase = {
  BAKERY_SERVER_URL: "http://127.0.0.1:8000",
  BAKERY_WORKER_STATE_DIR: "/tmp/bakery-worker-config-test-state",
  BAKERY_WORKER_CAPABILITIES: "git",
};

for (const prefix of HARNESS_PREFIXES) {
  Deno.test(`the ${prefix} harness model and effort names are in the worker env allow-list`, () => {
    const names: readonly string[] = WORKER_RUNTIME_ENVIRONMENT_NAMES;
    for (const suffix of ["MODEL", "EFFORT"]) {
      const name = `BAKERY_${prefix}_HARNESS_${suffix}`;
      assertEquals(
        names.includes(name),
        true,
        `WORKER_RUNTIME_ENVIRONMENT_NAMES omits ${name}`,
      );
    }
  });

  Deno.test(`readWorkerEnvironment delivers the ${prefix} harness model and effort pins to the harness settings`, () => {
    withProcessEnvironment({
      ...workerBase,
      [`BAKERY_${prefix}_HARNESS`]: "1",
      [`BAKERY_${prefix}_HARNESS_REPOSITORY`]: "/tmp/bakery-harness-repo",
      [`BAKERY_${prefix}_HARNESS_MODEL`]: "claude-sonnet-5-5",
      [`BAKERY_${prefix}_HARNESS_EFFORT`]: "high",
    }, () => {
      const environment = readWorkerEnvironment();
      assertEquals(
        environment[`BAKERY_${prefix}_HARNESS_MODEL`],
        "claude-sonnet-5-5",
      );
      assertEquals(environment[`BAKERY_${prefix}_HARNESS_EFFORT`], "high");
      const config = readWorkerConfig();
      assertEquals(config.codingHarness?.model, "claude-sonnet-5-5");
      assertEquals(config.codingHarness?.effort, "high");
    });
  });
}

Deno.test("an invalid claude model pin set in the process environment faults instead of being dropped", () => {
  withProcessEnvironment({
    ...workerBase,
    BAKERY_CLAUDE_HARNESS: "1",
    BAKERY_CLAUDE_HARNESS_REPOSITORY: "/tmp/bakery-harness-repo",
    BAKERY_CLAUDE_HARNESS_MODEL: "bad model with spaces",
  }, () => {
    assertThrows(
      () => readWorkerConfig(),
      Error,
      "BAKERY_CLAUDE_HARNESS_MODEL_INVALID",
    );
  });
});
