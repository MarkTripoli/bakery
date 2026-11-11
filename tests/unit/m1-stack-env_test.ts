import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  AMBIENT_ENV_NAMES,
  composeEnvironment,
  COORDINATOR_TURN_MODELS_SQL,
  databaseHelperEnvironment,
  FORCE_APPROVAL_EXPIRY_SQL,
  parseStackEnv,
  readStackEnv,
  REQUIRED_STACK_ENV_KEYS,
  restartEnvironment,
  type StackEnv,
} from "../../apps/web/tests/helpers/m1-stack-env.ts";

/** A complete first-start stack.env, as the orchestrator writes it. */
function stackEnv(): Record<string, string> {
  return {
    BAKERY_ENV: "development",
    BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: "40",
    BAKERY_BUDGET_RESERVATION_TTL_SECONDS: "3600",
    BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: "86400",
    BETTER_AUTH_SECRET: "secret-secret-secret-secret-secret-0123",
    BAKERY_INNGEST_EVENT_KEY: "event-key-1",
    INNGEST_EVENT_KEY: "event-key-1",
    BAKERY_INNGEST_SIGNING_KEY: "ab".repeat(32),
    INNGEST_SIGNING_KEY: "ab".repeat(32),
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:41000",
    BAKERY_WEB_PORT: "41000",
    BAKERY_SERVER_PORT: "41001",
    BAKERY_POSTGRES_PORT: "41002",
    BAKERY_INNGEST_PORT: "41003",
    DATABASE_URL: "postgres://owner:pw=with=equals@127.0.0.1:41002/bakery",
    DOCKER_HOST: "unix:///run/user/1000/formation-docker.sock",
  };
}

Deno.test("the required key list names the sixteen first-start variables", () => {
  assertEquals(
    [...REQUIRED_STACK_ENV_KEYS].sort(),
    Object.keys(stackEnv()).sort(),
  );
});

Deno.test("restartEnvironment returns every stack.env key and value unchanged", () => {
  const source: StackEnv = {
    ...stackEnv(),
    BAKERY_S3_FIXTURE_PORT: "41004",
    EXTRA_EMPTY: "",
  };
  const restart = restartEnvironment(source);
  assertEquals(restart, { ...source });
  assertEquals(Object.keys(restart).sort(), Object.keys(source).sort());
  // A copy: mutating the restart environment leaves the parsed file alone.
  restart.BAKERY_ENV = "test";
  assertEquals(source.BAKERY_ENV, "development");
});

Deno.test("restartEnvironment rejects a stack.env missing any required key", () => {
  for (const key of REQUIRED_STACK_ENV_KEYS) {
    const incomplete = stackEnv();
    delete incomplete[key];
    const error = assertThrows(() => restartEnvironment(incomplete), Error);
    assertEquals(error.message, `M1_STACK_ENV_MISSING:${key}`);
  }
});

Deno.test("restartEnvironment rejects a required key held empty", () => {
  const error = assertThrows(
    () =>
      restartEnvironment({
        ...stackEnv(),
        BAKERY_BUDGET_RESERVATION_TTL_SECONDS: " ",
      }),
    Error,
  );
  assertEquals(
    error.message,
    "M1_STACK_ENV_EMPTY:BAKERY_BUDGET_RESERVATION_TTL_SECONDS",
  );
});

Deno.test("restartEnvironment rejects unequal key pairs without printing values", () => {
  const events = assertThrows(
    () => restartEnvironment({ ...stackEnv(), INNGEST_EVENT_KEY: "other-key" }),
    Error,
  );
  assertEquals(
    events.message,
    "M1_STACK_ENV_PAIR_MISMATCH:INNGEST_EVENT_KEY:BAKERY_INNGEST_EVENT_KEY",
  );
  const signing = assertThrows(
    () =>
      restartEnvironment({
        ...stackEnv(),
        BAKERY_INNGEST_SIGNING_KEY: "cd".repeat(32),
      }),
    Error,
  );
  assertEquals(
    signing.message,
    "M1_STACK_ENV_PAIR_MISMATCH:INNGEST_SIGNING_KEY:BAKERY_INNGEST_SIGNING_KEY",
  );
  for (
    const value of [
      "other-key",
      "cd".repeat(32),
      "ab".repeat(32),
      "event-key-1",
    ]
  ) {
    assert(!events.message.includes(value) && !signing.message.includes(value));
  }
});

Deno.test("restartEnvironment rejects an unresolved or invalid pinned port", () => {
  for (
    const key of [
      "BAKERY_WEB_PORT",
      "BAKERY_SERVER_PORT",
      "BAKERY_POSTGRES_PORT",
      "BAKERY_INNGEST_PORT",
    ]
  ) {
    for (const bad of ["0", "65536", "-1", "4100x", "4.1"]) {
      const error = assertThrows(
        () => restartEnvironment({ ...stackEnv(), [key]: bad }),
        Error,
      );
      assertEquals(error.message, `M1_STACK_ENV_PORT_INVALID:${key}`);
    }
  }
});

Deno.test("parseStackEnv keeps values verbatim and reports problems by line or key", () => {
  const parsed = parseStackEnv(
    [
      "# first-start environment",
      "",
      "DATABASE_URL=postgres://u:p=q@127.0.0.1:5/db?x=1",
      "SPACED= keep leading and trailing ",
      'QUOTED="kept"',
      "WINDOWS=line\r",
    ].join("\n"),
  );
  assertEquals(parsed, {
    DATABASE_URL: "postgres://u:p=q@127.0.0.1:5/db?x=1",
    SPACED: " keep leading and trailing ",
    QUOTED: '"kept"',
    WINDOWS: "line",
  });
  const invalid = assertThrows(
    () => parseStackEnv("A=1\nnot a pair secret-value"),
    Error,
  );
  assertEquals(invalid.message, "M1_STACK_ENV_LINE_INVALID:2");
  const duplicate = assertThrows(() => parseStackEnv("A=1\nA=2"), Error);
  assertEquals(duplicate.message, "M1_STACK_ENV_DUPLICATE_KEY:A");
});

Deno.test("readStackEnv reads the file and restartEnvironment round-trips it", async () => {
  const directory = await Deno.makeTempDir({ prefix: "m1-stack-env-" });
  try {
    const file = `${directory}/stack.env`;
    const source = stackEnv();
    await Deno.writeTextFile(
      file,
      Object.entries(source).map(([key, value]) => `${key}=${value}`).join(
        "\n",
      ) + "\n",
    );
    assertEquals(readStackEnv(file), source);
    assertEquals(restartEnvironment(readStackEnv(file)), source);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("composeEnvironment takes compose variables only from stack.env", () => {
  const ambient = {
    PATH: "/usr/bin",
    HOME: "/home/proof",
    XDG_RUNTIME_DIR: "/run/user/1000",
    BAKERY_SCRIPTED_COORDINATOR_DIR:
      "/workspace/tests/fixtures/scripted-coordinator",
    BAKERY_ENV: "test",
    DOCKER_HOST: "unix:///wrong.sock",
    BETTER_AUTH_SECRET: "ambient-secret",
  };
  const composed = composeEnvironment(ambient, stackEnv());
  assertEquals(composed, {
    PATH: "/usr/bin",
    HOME: "/home/proof",
    XDG_RUNTIME_DIR: "/run/user/1000",
    ...stackEnv(),
  });
  assert(!("BAKERY_SCRIPTED_COORDINATOR_DIR" in composed));
  for (const name of Object.keys(composed)) {
    assert(
      (AMBIENT_ENV_NAMES as readonly string[]).includes(name) ||
        name in stackEnv(),
      `unexpected variable ${name}`,
    );
  }
  assertThrows(
    () => composeEnvironment(ambient, { ...stackEnv(), DOCKER_HOST: "" }),
    Error,
    "M1_STACK_ENV_EMPTY:DOCKER_HOST",
  );
});

Deno.test("the approval expiry statement is the recorded operator step 3", () => {
  assertEquals(
    FORCE_APPROVAL_EXPIRY_SQL,
    "update bakery.questions set expires_at = now() - interval '1 minute' where id = $1 and kind = 'approval'",
  );
});

Deno.test("the owner-database child gets the allow-list, Deno variables and the URL only", () => {
  const environment = databaseHelperEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/proof",
    DENO_DIR: "/home/proof/.cache/deno",
    DENO_TLS_CA_STORE: "system",
    BETTER_AUTH_SECRET: "ambient-auth-secret",
    BAKERY_REAL_PASSWORD: "owner-password",
    BAKERY_SCRIPTED_COORDINATOR_DIR: "/ambient/scripted",
    DATABASE_URL: "postgres://ambient@127.0.0.1/other",
  }, "postgres://owner:pw@127.0.0.1:41002/bakery");
  assertEquals(environment, {
    PATH: "/usr/bin",
    HOME: "/home/proof",
    DENO_DIR: "/home/proof/.cache/deno",
    DENO_TLS_CA_STORE: "system",
    DATABASE_URL: "postgres://owner:pw@127.0.0.1:41002/bakery",
  });
});

Deno.test("the coordinator model query is one read-only select by conversation", () => {
  assert(/^select /i.test(COORDINATOR_TURN_MODELS_SQL));
  assert(
    !/\b(insert|update|delete|alter|drop|create|truncate)\b/i.test(
      COORDINATOR_TURN_MODELS_SQL,
    ),
  );
  assert(COORDINATOR_TURN_MODELS_SQL.includes("$1"));
  assert(COORDINATOR_TURN_MODELS_SQL.includes("conversation_turn_id"));
  assert(COORDINATOR_TURN_MODELS_SQL.includes("{result,model}"));
});
