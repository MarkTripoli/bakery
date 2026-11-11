import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  coordinatorModels,
  createFirstAdmin,
  forceApprovalExpiry,
  killWorker,
  type ProcessRunner,
  restartInngest,
  restartServer,
  runtime,
  spendSettledUsd,
  startWorker,
  storedStatus,
  waitReady,
} from "../../apps/web/tests/helpers/m1-stack-control.ts";
import { parseOperatorStepLine } from "../../scripts/evidence/prove-m1.ts";
import {
  scrubSecrets,
  stackSecretValues,
  stateScriptEnvironment,
} from "../../apps/web/tests/helpers/m1-stack-env.ts";

const OWNER_PASSWORD = "owner-pw-0123456789";
const AUTH_SECRET = "auth-secret-secret-secret-0123456789";
const DATABASE_PASSWORD = "db-pw-ABCDEFGH";
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";

/** A complete first-start stack.env, as the orchestrator writes it. */
function stackEnv(): Record<string, string> {
  return {
    BAKERY_ENV: "development",
    BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: "40",
    BAKERY_BUDGET_RESERVATION_TTL_SECONDS: "3600",
    BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: "86400",
    BETTER_AUTH_SECRET: AUTH_SECRET,
    BAKERY_INNGEST_EVENT_KEY: "event-key-0001",
    INNGEST_EVENT_KEY: "event-key-0001",
    BAKERY_INNGEST_SIGNING_KEY: "ab".repeat(32),
    INNGEST_SIGNING_KEY: "ab".repeat(32),
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:41000",
    BAKERY_WEB_PORT: "41000",
    BAKERY_SERVER_PORT: "41001",
    BAKERY_POSTGRES_PORT: "41002",
    BAKERY_INNGEST_PORT: "41003",
    DATABASE_URL:
      `postgres://owner:${DATABASE_PASSWORD}@127.0.0.1:41002/bakery`,
    DOCKER_HOST: "unix:///run/user/1000/formation-docker.sock",
  };
}

type Call = {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

/**
 * Runs `work` against a temp state dir holding `stack.env` and both state
 * scripts, with the runtime seam replaced: no docker, no network, no clock, and
 * the process environment untouched. `ambient` is the spec's own environment.
 */
async function withControls(
  ambient: Record<string, string | undefined>,
  fakeRun: (call: Call) => Promise<{ stdout: string; stderr: string }>,
  work: (state: string, calls: Call[]) => Promise<void>,
) {
  const state = await Deno.makeTempDir({ prefix: "m1-control-" });
  const original = { ...runtime };
  const calls: Call[] = [];
  try {
    await Deno.writeTextFile(
      `${state}/stack.env`,
      Object.entries(stackEnv()).map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
    );
    await Deno.writeTextFile(`${state}/worker-launch.sh`, "#!/bin/sh\n");
    await Deno.writeTextFile(`${state}/worker-kill.sh`, "#!/bin/sh\n");
    runtime.env = () => ({
      BAKERY_M1_STATE_DIR: state,
      BAKERY_M1_COMPOSE_PROJECT: "bakery-m1-test",
      BAKERY_REAL_PASSWORD: OWNER_PASSWORD,
      ...ambient,
    });
    runtime.run = ((file, args, options) => {
      const call: Call = {
        file,
        args,
        cwd: options.cwd,
        env: options.env,
      };
      calls.push(call);
      return fakeRun(call);
    }) satisfies ProcessRunner;
    runtime.sleep = () => Promise.resolve();
    await work(state, calls);
  } finally {
    Object.assign(runtime, original);
    await Deno.remove(state, { recursive: true });
  }
}

const unused = () => Promise.resolve({ stdout: "", stderr: "" });

Deno.test("every control refuses to run without BAKERY_REAL_API_M1=1", async () => {
  await withControls(
    { BAKERY_REAL_API_M1: undefined },
    unused,
    async (state, calls) => {
      const attempts: [string, () => Promise<unknown>][] = [
        ["restartServer", restartServer],
        ["restartInngest", restartInngest],
        ["killWorker", killWorker],
        ["startWorker", startWorker],
        ["waitReady", () => waitReady("http://127.0.0.1:1", 1)],
        ["spendSettledUsd", spendSettledUsd],
        ["storedStatus", () => storedStatus(APPROVAL_ID)],
        ["forceApprovalExpiry", () => forceApprovalExpiry(APPROVAL_ID)],
      ];
      for (const [name, attempt] of attempts) {
        await assertRejects(
          attempt,
          Error,
          `M1_STACK_CONTROL_DISABLED:${name}`,
        );
      }
      // Any other value than "1" refuses too.
      runtime.env = () => ({
        BAKERY_REAL_API_M1: "true",
        BAKERY_M1_STATE_DIR: state,
        BAKERY_M1_COMPOSE_PROJECT: "bakery-m1-test",
      });
      await assertRejects(
        killWorker,
        Error,
        "M1_STACK_CONTROL_DISABLED:killWorker",
      );
      assertEquals(calls, [], "nothing was spawned");
      const written = [...Deno.readDirSync(state)].map((entry) => entry.name);
      assert(!written.includes("fault-log.txt"), "nothing was logged");
    },
  );
});

Deno.test("the worker launcher and killer run with the allow-listed environment", async () => {
  const ambient = {
    BAKERY_REAL_API_M1: "1",
    BAKERY_SCRIPTED_COORDINATOR_DIR: "/ambient/scripted",
    BAKERY_WORKER_SCRIPTED_HARNESS_DIR: "/ambient/harness",
    BAKERY_FS_UNRELATED: "ambient-value",
    BAKERY_ENV: "test",
    BETTER_AUTH_SECRET: "AMBIENT-SECRET-VALUE",
    DOCKER_HOST: "unix:///ambient/wrong.sock",
    PATH: "/usr/bin:/bin",
    HOME: "/home/proof",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  };
  await withControls(ambient, unused, async (state, calls) => {
    await startWorker();
    await killWorker();
    assertEquals(calls.length, 2);
    assertEquals(calls.map((call) => call.file), ["bash", "bash"]);
    assertEquals(calls.map((call) => call.args), [
      [`${state}/worker-launch.sh`],
      [`${state}/worker-kill.sh`],
    ]);
    for (const call of calls) {
      assertEquals(call.cwd, state);
      for (
        const leaked of [
          "BAKERY_SCRIPTED_COORDINATOR_DIR",
          "BAKERY_WORKER_SCRIPTED_HARNESS_DIR",
          "BAKERY_FS_UNRELATED",
          "BAKERY_REAL_API_M1",
          "BAKERY_REAL_PASSWORD",
          "BAKERY_M1_STATE_DIR",
        ]
      ) {
        assert(!(leaked in call.env), `${leaked} reached a state script`);
      }
      // The stack file, not the spec, decides what compose-like tools see.
      assertEquals(call.env.BAKERY_ENV, "development");
      assertEquals(call.env.BETTER_AUTH_SECRET, AUTH_SECRET);
      assertEquals(call.env.DOCKER_HOST, stackEnv().DOCKER_HOST);
      // What `systemd-run --user` needs.
      assertEquals(call.env.PATH, "/usr/bin:/bin");
      assertEquals(call.env.HOME, "/home/proof");
      assertEquals(call.env.XDG_RUNTIME_DIR, "/run/user/1000");
      assertEquals(
        call.env.DBUS_SESSION_BUS_ADDRESS,
        "unix:path=/run/user/1000/bus",
      );
    }
    const log = await Deno.readTextFile(`${state}/fault-log.txt`);
    assert(log.includes("done worker-launch.sh exit=0"));
    assert(log.includes("done worker-kill.sh exit=0"));
  });
});

Deno.test("stateScriptEnvironment omits the session bus when the spec has none", () => {
  const environment = stateScriptEnvironment(
    {
      PATH: "/usr/bin",
      BAKERY_ENV: "test",
      BAKERY_SCRIPTED_COORDINATOR_DIR: "/x",
    },
    stackEnv(),
  );
  assertEquals(environment.BAKERY_ENV, "development");
  assert(!("DBUS_SESSION_BUS_ADDRESS" in environment));
  assert(!("BAKERY_SCRIPTED_COORDINATOR_DIR" in environment));
});

Deno.test("a failing child's stderr is scrubbed from the fault log and the thrown error", async () => {
  const leaking = (call: Call) =>
    Promise.reject(
      Object.assign(
        new Error(
          `Command failed: ${call.file} ${call.args.join(" ")}\n` +
            `connection to postgres://owner:${DATABASE_PASSWORD}@127.0.0.1:41002 refused; ` +
            `auth ${AUTH_SECRET}; owner ${OWNER_PASSWORD}; signing ${
              "ab".repeat(32)
            }`,
        ),
        { code: 1, stderr: `stderr ${AUTH_SECRET} ${DATABASE_PASSWORD}` },
      ),
    );
  await withControls({ BAKERY_REAL_API_M1: "1" }, leaking, async (state) => {
    await Deno.writeTextFile(`${state}/enrollment-token`, "token-0123456789\n");
    const secrets = [
      DATABASE_PASSWORD,
      AUTH_SECRET,
      OWNER_PASSWORD,
      "ab".repeat(32),
    ];
    const errors: Error[] = [];
    for (
      const attempt of [
        () => storedStatus(APPROVAL_ID),
        () => spendSettledUsd(),
        () => forceApprovalExpiry(APPROVAL_ID),
        () => restartServer(),
        () => startWorker(),
      ]
    ) {
      errors.push(await assertRejects(attempt, Error));
    }
    const log = await Deno.readTextFile(`${state}/fault-log.txt`);
    assert(log.includes("[redacted]"), "the scrub left its marker");
    assert(log.includes("FAILED"), "the failure was logged");
    for (const secret of secrets) {
      assert(!log.includes(secret), `fault-log.txt holds ${secret}`);
      for (const error of errors) {
        assert(!error.message.includes(secret), `error holds ${secret}`);
      }
    }
  });
});

Deno.test("a wait-ready timeout scrubs a secret carried in the URL", async () => {
  const refused = () => Promise.reject(new TypeError("connection refused"));
  await withControls({ BAKERY_REAL_API_M1: "1" }, unused, async (state) => {
    runtime.fetch = refused as unknown as typeof fetch;
    const error = await assertRejects(
      () => waitReady(`http://127.0.0.1:1/${AUTH_SECRET}`, 1),
      Error,
      "M1_WAIT_READY_TIMEOUT",
    );
    assert(!error.message.includes(AUTH_SECRET));
    const log = await Deno.readTextFile(`${state}/fault-log.txt`);
    assert(!log.includes(AUTH_SECRET));
    assert(log.includes("[redacted]"));
  });
});

Deno.test("the expiry step keeps one fault-log line shape", async () => {
  const sql = "update bakery.questions set expires_at = now() where id = $1";
  const database = (call: Call) =>
    Promise.resolve({
      stdout: JSON.stringify({
        sql,
        approvalId: APPROVAL_ID,
        rowCount: call.args.includes("expire") ? 1 : null,
      }) + "\n",
      stderr: "",
    });
  await withControls(
    { BAKERY_REAL_API_M1: "1" },
    database,
    async (state, calls) => {
      await forceApprovalExpiry(APPROVAL_ID);
      // The database helper child sees the owner URL and nothing else secret.
      assertEquals(calls[0].file, "deno");
      assertEquals(calls[0].env.DATABASE_URL, stackEnv().DATABASE_URL);
      assert(!calls[0].args.join(" ").includes(DATABASE_PASSWORD));
      const lines = (await Deno.readTextFile(`${state}/fault-log.txt`)).split(
        "\n",
      ).filter((entry) => entry.includes(" forceApprovalExpiry "));
      assertEquals(lines.length, 1);
      assert(
        /^\d{4}-\d\d-\d\dT[\d:.]+Z forceApprovalExpiry /.test(lines[0]),
        lines[0],
      );
      assertEquals(
        lines[0].slice(lines[0].indexOf(" forceApprovalExpiry ") + 1),
        `forceApprovalExpiry approvalId=${APPROVAL_ID} rowCount=1 sql=${sql}`,
      );
    },
  );
});

Deno.test("the first-admin step passes the password by environment and logs a JSON record", async () => {
  const seed = () =>
    Promise.resolve({
      stdout: JSON.stringify({
        organizationId: "22222222-2222-4222-8222-222222222222",
        status: "created",
      }) + "\n",
      stderr: "",
    });
  await withControls(
    { BAKERY_REAL_API_M1: "1" },
    seed,
    async (state, calls) => {
      const admin = await createFirstAdmin(
        "owner@example.test",
        OWNER_PASSWORD,
      );
      assertEquals(admin.status, "created");
      assertEquals(calls[0].file, "deno");
      assertEquals(calls[0].env.WEB_AUTH_SEED_PASSWORD, OWNER_PASSWORD);
      assertEquals(
        calls[0].env.BAKERY_PUBLIC_BASE_URL,
        "http://127.0.0.1:41000",
      );
      assert(!calls[0].args.join(" ").includes(OWNER_PASSWORD));
      const log = await Deno.readTextFile(`${state}/fault-log.txt`);
      const line = log.split("\n").find((entry) => entry.includes('{"m1"'))!;
      const record = JSON.parse(line.slice(line.indexOf('{"m1"')));
      assertEquals(record.name, "first-admin-createsuperuser");
      assertEquals(record.exitCode, 0);
      assert(record.command.endsWith("web-auth-seed.ts owner@example.test"));
      assert(!log.includes(OWNER_PASSWORD));
    },
  );
  const failing = () =>
    Promise.reject(
      new Error(`web-auth-seed exited 1: bad password ${OWNER_PASSWORD}`),
    );
  await withControls({ BAKERY_REAL_API_M1: "1" }, failing, async (state) => {
    const error = await assertRejects(
      () => createFirstAdmin("owner@example.test", OWNER_PASSWORD),
      Error,
    );
    assert(!error.message.includes(OWNER_PASSWORD));
    const log = await Deno.readTextFile(`${state}/fault-log.txt`);
    assert(!log.includes(OWNER_PASSWORD));
    assert(log.includes('"exitCode":1'));
  });
});

Deno.test("stackSecretValues and scrubSecrets cover keys, URLs, passwords and extras", () => {
  const secrets = stackSecretValues(stackEnv(), [
    "extra-token-1",
    "x",
    undefined,
  ]);
  for (
    const expected of [
      AUTH_SECRET,
      DATABASE_PASSWORD,
      stackEnv().DATABASE_URL,
      "ab".repeat(32),
      "event-key-0001",
      "extra-token-1",
    ]
  ) {
    assert(secrets.includes(expected), `${expected} is not a secret`);
  }
  // Short values and plain settings are not secrets.
  assert(!secrets.includes("x"));
  assert(!secrets.includes("development"));
  assert(!secrets.includes("41001"));
  // Longest first: a URL is replaced whole before its password.
  assertEquals(
    secrets.indexOf(stackEnv().DATABASE_URL) <
      secrets.indexOf(DATABASE_PASSWORD),
    true,
  );
  assertEquals(
    scrubSecrets(
      `url ${stackEnv().DATABASE_URL} and ${DATABASE_PASSWORD} twice ${DATABASE_PASSWORD}`,
      secrets,
    ),
    "url [redacted] and [redacted] twice [redacted]",
  );
});

Deno.test("the coordinator model read is read only and returns what the database holds", async () => {
  const rows = [{
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptStatus: "completed",
    model: "claude-sonnet-5-5",
    claudeCodeVersion: "2.1.312",
  }];
  const database = () =>
    Promise.resolve({
      stdout: JSON.stringify({ sql: "select 1", rowCount: 1, rows }) + "\n",
      stderr: "",
    });
  await withControls(
    { BAKERY_REAL_API_M1: "1" },
    database,
    async (state, calls) => {
      assertEquals(await coordinatorModels(APPROVAL_ID), rows);
      assertEquals(calls[0].args.slice(-2), [
        "coordinator-models",
        APPROVAL_ID,
      ]);
      const log = await Deno.readTextFile(`${state}/fault-log.txt`);
      assert(log.includes("coordinatorModels"));
      assert(log.includes("claude-sonnet-5-5"));
    },
  );
});

Deno.test("the owner-database child never receives the spec's secrets (review F11)", async () => {
  const database = (call: Call) =>
    Promise.resolve({
      stdout: JSON.stringify({
        sql: "x",
        rowCount: call.args.includes("expire") ? 1 : null,
        totalUsd: "0.5",
        status: "open",
        rows: [],
      }) + "\n",
      stderr: "",
    });
  const ambient = {
    BAKERY_REAL_API_M1: "1",
    PATH: "/usr/bin:/bin",
    HOME: "/home/proof",
    DENO_DIR: "/home/proof/.cache/deno",
    BETTER_AUTH_SECRET: "AMBIENT-AUTH-SECRET",
    BAKERY_SCRIPTED_COORDINATOR_DIR: "/ambient/scripted",
  };
  await withControls(ambient, database, async (_state, calls) => {
    await spendSettledUsd();
    await storedStatus(APPROVAL_ID);
    await forceApprovalExpiry(APPROVAL_ID);
    await coordinatorModels(APPROVAL_ID);
    assertEquals(calls.length, 4);
    for (const call of calls) {
      assertEquals(Object.keys(call.env).sort(), [
        "DATABASE_URL",
        "DENO_DIR",
        "HOME",
        "PATH",
      ]);
      assertEquals(call.env.DATABASE_URL, stackEnv().DATABASE_URL);
    }
  });
});

Deno.test("the helpers' own fault-log lines are operator steps the orchestrator parses", async () => {
  const sql = "update bakery.questions set expires_at = now() where id = $1";
  const run = (call: Call) =>
    Promise.resolve({
      stdout: JSON.stringify(
        call.args.includes("expire")
          ? { sql, approvalId: APPROVAL_ID, rowCount: 1 }
          : {
            organizationId: "22222222-2222-4222-8222-222222222222",
            status: "created",
          },
      ) + "\n",
      stderr: "",
    });
  await withControls({ BAKERY_REAL_API_M1: "1" }, run, async (state) => {
    await createFirstAdmin("owner@example.test", OWNER_PASSWORD);
    await forceApprovalExpiry(APPROVAL_ID);
    const steps = (await Deno.readTextFile(`${state}/fault-log.txt`)).split(
      "\n",
    )
      .map((line) => parseOperatorStepLine(line))
      .filter((step) => step !== undefined);
    assertEquals(steps.map((step) => step.name), [
      "first-admin-createsuperuser",
      "force-approval-expiry",
    ]);
    assertEquals(steps.map((step) => step.exitCode), [0, 0]);
    assert(steps[1].command.includes(`$1 = ${APPROVAL_ID}`));
    assert(steps[1].command.startsWith("update bakery.questions"));
  });
});
