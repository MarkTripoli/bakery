import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  readWorkerConfig,
  readWorkerLaunchPermissions,
} from "../../apps/worker/src/config.ts";

const base = {
  BAKERY_SERVER_URL: "http://127.0.0.1:8000",
  BAKERY_WORKER_STATE_DIR: "/tmp/bakery-worker-state",
  BAKERY_WORKER_CAPABILITIES: "git",
  HOME: "/home/bakery",
};

function harnessEnv(
  overrides: Record<string, string>,
): Record<string, string> {
  return { ...base, BAKERY_CODEX_HARNESS: "1", ...overrides };
}

Deno.test("the codex harness time limit rejects values below 1s and above 1h", () => {
  for (const invalid of ["999", "0", "-1000", "3600001", "86400000"]) {
    assertThrows(
      () =>
        readWorkerConfig(
          harnessEnv({
            BAKERY_CODEX_HARNESS_REPOSITORY: "/tmp/bakery-repo",
            BAKERY_CODEX_HARNESS_TIME_LIMIT_MS: invalid,
          }),
        ),
      Error,
      "BAKERY_CODEX_HARNESS_TIME_LIMIT_MS_INVALID",
      `expected ${invalid} to be rejected`,
    );
  }
});

Deno.test("the codex harness time limit accepts the exact bounds and rejects non-integers", () => {
  for (const valid of ["1000", "3600000"]) {
    const config = readWorkerConfig(
      harnessEnv({
        BAKERY_CODEX_HARNESS_REPOSITORY: "/tmp/bakery-repo",
        BAKERY_CODEX_HARNESS_TIME_LIMIT_MS: valid,
      }),
    );
    assert(config.codexHarness !== undefined);
    assert(config.codexHarness.timeLimitMs === Number.parseInt(valid, 10));
  }
  for (const malformed of ["abc", "1.5", "1e4"]) {
    assertThrows(
      () =>
        readWorkerConfig(
          harnessEnv({
            BAKERY_CODEX_HARNESS_REPOSITORY: "/tmp/bakery-repo",
            BAKERY_CODEX_HARNESS_TIME_LIMIT_MS: malformed,
          }),
        ),
      Error,
      "BAKERY_CODEX_HARNESS_TIME_LIMIT_MS_INVALID",
    );
  }
});

Deno.test("the codex harness repository is required when the flag is enabled and forbidden without it", () => {
  assertThrows(
    () => readWorkerConfig(harnessEnv({})),
    Error,
    "BAKERY_CODEX_HARNESS_REPOSITORY_INVALID",
  );
  assertThrows(
    () =>
      readWorkerConfig({
        ...base,
        BAKERY_CODEX_HARNESS_REPOSITORY: "/tmp/bakery-repo",
      }),
    Error,
    "BAKERY_CODEX_HARNESS_REPOSITORY_WITHOUT_ENABLE",
  );
  assert(
    readWorkerConfig({ ...base }).codexHarness === undefined,
    "the flag off must leave the codex harness disabled",
  );
});

Deno.test("the worker rejects multiple enabled coding harnesses", () => {
  assertThrows(
    () =>
      readWorkerConfig({
        ...base,
        BAKERY_CODEX_HARNESS: "1",
        BAKERY_CODEX_HARNESS_REPOSITORY: "/tmp/codex-repo",
        BAKERY_PI_HARNESS: "1",
        BAKERY_PI_HARNESS_REPOSITORY: "/tmp/pi-repo",
      }),
    Error,
    "BAKERY_CODING_HARNESS_CONFLICT",
  );
});

Deno.test("the generic Claude harness keys use the shared defaults", () => {
  const config = readWorkerConfig({
    ...base,
    BAKERY_CLAUDE_HARNESS: "1",
    BAKERY_CLAUDE_HARNESS_REPOSITORY: "/tmp/claude-repo",
  });
  assertEquals(config.codingHarness?.name, "claude");
  assertEquals(config.codingHarness?.repository, "/tmp/claude-repo");
  assertEquals(config.codingHarness?.executable, "claude");
  assertEquals(config.codexHarness, undefined);
});

Deno.test("Claude harness permissions include its repository, state, executable, and auth source", () => {
  const permissions = readWorkerLaunchPermissions(
    {
      ...base,
      BAKERY_CLAUDE_HARNESS: "1",
      BAKERY_CLAUDE_HARNESS_REPOSITORY: "/tmp/claude-repo",
    },
    "/tmp/bakery-root",
  );
  assert(permissions.read.includes("/tmp/claude-repo"));
  assert(permissions.read.includes("/home/bakery/.claude"));
  assert(permissions.write.includes("/tmp/claude-repo"));
  assert(permissions.write.includes("/tmp/bakery-worker-state"));
  assert(permissions.run.includes("claude"));
  assertEquals(permissions.run, [
    Deno.execPath(),
    "/usr/bin/bwrap",
    "/usr/bin/ldd",
    "/usr/bin/kill",
    "/usr/bin/setsid",
    "/usr/bin/git",
    "claude",
  ]);
  assert(permissions.read.includes("/usr/bin/setsid"));
  const disabled = readWorkerLaunchPermissions(base, "/tmp/bakery-root");
  assert(!disabled.read.includes("/home/bakery/.claude"));
  assertEquals(disabled.run, [
    Deno.execPath(),
    "/usr/bin/bwrap",
    "/usr/bin/ldd",
    "/usr/bin/kill",
  ]);
  assert(!disabled.read.includes("/usr/bin/setsid"));
});

Deno.test("Pi harness keys use shared defaults and include the agent source", () => {
  const config = readWorkerConfig({
    ...base,
    BAKERY_PI_HARNESS: "1",
    BAKERY_PI_HARNESS_REPOSITORY: "/tmp/pi-repo",
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
  });
  assertEquals(config.codingHarness?.name, "pi");
  assertEquals(config.codingHarness?.repository, "/tmp/pi-repo");
  assertEquals(config.codingHarness?.executable, "pi");
  assertEquals(config.codexHarness, undefined);

  const permissions = readWorkerLaunchPermissions(
    {
      ...base,
      BAKERY_PI_HARNESS: "1",
      BAKERY_PI_HARNESS_REPOSITORY: "/tmp/pi-repo",
      PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    },
    "/tmp/bakery-root",
  );
  assert(permissions.read.includes("/tmp/pi-repo"));
  assert(permissions.read.includes("/tmp/pi-agent"));
  assert(permissions.write.includes("/tmp/pi-repo"));
  assert(permissions.write.includes("/tmp/bakery-worker-state"));
  assert(permissions.run.includes("pi"));
});

Deno.test("the harness config parses model and effort selectors", () => {
  const config = readWorkerConfig({
    ...base,
    BAKERY_CLAUDE_HARNESS: "1",
    BAKERY_CLAUDE_HARNESS_REPOSITORY: "/tmp/claude-repo",
    BAKERY_CLAUDE_HARNESS_MODEL: "claude-opus-5-5",
    BAKERY_CLAUDE_HARNESS_EFFORT: "ultracode",
  });
  assertEquals(config.codingHarness?.model, "claude-opus-5-5");
  assertEquals(config.codingHarness?.effort, "ultracode");

  const piConfig = readWorkerConfig({
    ...base,
    BAKERY_PI_HARNESS: "1",
    BAKERY_PI_HARNESS_REPOSITORY: "/tmp/pi-repo",
    BAKERY_PI_HARNESS_MODEL: "openai/gpt-5.6-luna",
    BAKERY_PI_HARNESS_EFFORT: "high",
  });
  assertEquals(piConfig.codingHarness?.model, "openai/gpt-5.6-luna");
  assertEquals(piConfig.codingHarness?.effort, "high");
});

Deno.test("the harness config rejects malformed model and effort selectors", () => {
  assertThrows(
    () =>
      readWorkerConfig({
        ...base,
        BAKERY_CLAUDE_HARNESS: "1",
        BAKERY_CLAUDE_HARNESS_REPOSITORY: "/tmp/claude-repo",
        BAKERY_CLAUDE_HARNESS_MODEL: "bad model with spaces",
      }),
    Error,
    "BAKERY_CLAUDE_HARNESS_MODEL_INVALID",
  );
  assertThrows(
    () =>
      readWorkerConfig({
        ...base,
        BAKERY_PI_HARNESS: "1",
        BAKERY_PI_HARNESS_REPOSITORY: "/tmp/pi-repo",
        BAKERY_PI_HARNESS_EFFORT: "$(rm -rf /)",
      }),
    Error,
    "BAKERY_PI_HARNESS_EFFORT_INVALID",
  );
});

Deno.test("Codex auth source resolves BAKERY_CODEX_AUTH_SOURCE_DIR, then CODEX_HOME, then HOME/.codex, and reaches the grants (#418)", () => {
  const codex = harnessEnv({ BAKERY_CODEX_HARNESS_REPOSITORY: "/tmp/repo" });
  assertEquals(
    readWorkerConfig(codex).codexAuthSourceDir,
    "/home/bakery/.codex",
  );
  const withCodexHome = { ...codex, CODEX_HOME: "/srv/codex-home" };
  assertEquals(
    readWorkerConfig(withCodexHome).codexAuthSourceDir,
    "/srv/codex-home",
  );
  const explicit = {
    ...withCodexHome,
    BAKERY_CODEX_AUTH_SOURCE_DIR: "/srv/codex-auth",
  };
  assertEquals(
    readWorkerConfig(explicit).codexAuthSourceDir,
    "/srv/codex-auth",
  );
  const grants = readWorkerLaunchPermissions(explicit, "/tmp/bakery-root");
  assert(grants.read.includes("/srv/codex-auth"));
  assert(!grants.read.includes("/srv/codex-home"));
  assert(!grants.read.includes("/home/bakery/.codex"));
  assertEquals(
    readWorkerLaunchPermissions(codex, "/tmp/bakery-root").read.includes(
      "/home/bakery/.codex",
    ),
    true,
  );
  // Another harness, or none, never resolves a Codex auth source.
  assertEquals(readWorkerConfig({ ...base }).codexAuthSourceDir, undefined);
  // No source and no HOME fails closed at launch.
  const { HOME: _home, ...noHome } = codex;
  assertThrows(
    () => readWorkerConfig(noHome),
    Error,
    "HOME_REQUIRED_FOR_CODEX_HARNESS",
  );
});
