import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertStackEnvComplete,
  formatStackEnv,
  M1_EQUAL_STACK_ENV_PAIRS,
  M1_FAILURE_FILE,
  M1_FIRST_START_ENV_KEYS,
  M1_JOURNEY_TIMEOUT_MS,
  M1_MANIFEST_FILE,
  M1_REGRESSION_TIMEOUT_MS,
  M1_REQUIRED_STACK_ENV_KEYS,
  M1_STATE_FILES,
  type M1CommandResult,
  type M1CommandSpec,
  type M1FileSystem,
  M1ProofError,
  type M1ProofFailure,
  type M1ProofManifest,
  M1Redactor,
  type M1Services,
  microUsd,
  parseArguments,
  parseOperatorStepLine,
  runM1Proof,
  systemdEnvLine,
} from "../../scripts/evidence/prove-m1.ts";
import {
  billingFile,
  derivePricingSnapshotRows,
  M1_AGENTS,
  M1_PROOF_MODEL,
  pricingSnapshotSql,
} from "../../scripts/evidence/m1-billing.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SHA8 = "01234567";
const PROJECT = `bakery-m1-${SHA8}`;
const UNIT = `${PROJECT}-worker`;
const STATE = `/state/m1-${SHA8}`;
const OUT = "/out";
const ROOT = "/repo";
const CLAUDE = "/opt/claude/bin/claude";
const HOST_ID = "be13b309-8856-4f31-8bdd-00421282a904";
const ENROLLMENT_TOKEN = "enroll-token-value-1234567890";
const SERVER_CONTAINER = "serverc0ffee";
/** The id compose gives the server after the first restart recreates it. */
const RECREATED_SERVER_CONTAINER = "serverbeef";
const DISPATCHER = `${PROJECT}-server-run-1`;
const FAKE_SOURCE = `${ROOT}/tests/fixtures/fake-harness/fake-claude-slow.sh`;
const FAKE_SCRIPT = "#!/bin/sh\necho fake\n";
/** The exact line `forceApprovalExpiry` (m1-stack-control.ts) appends. */
const EXPIRY_SQL =
  "update bakery.questions set expires_at = now() - interval '1 minute' where id = $1 and kind = 'approval'";
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_LINE =
  `2026-10-30T10:00:00.000Z forceApprovalExpiry approvalId=${APPROVAL_ID} rowCount=1 sql=${EXPIRY_SQL}`;

type Call = M1CommandSpec & { readonly line: string };

type Result = { code?: number; stdout?: string; stderr?: string };

/** An in-memory file system that records every write with its mode. */
class FakeFileSystem implements M1FileSystem {
  readonly files = new Map<string, { text: string; mode: number }>();
  readonly directories = new Set<string>();
  readonly writes: { path: string; text: string; mode: number }[] = [];
  /** Paths whose reads fail, to model a file the scrub cannot read. */
  readonly failReads = new Set<string>();

  seed(path: string, text: string): void {
    this.files.set(path, { text, mode: 0o644 });
  }

  readText(path: string): Promise<string> {
    if (this.failReads.has(path)) {
      return Promise.reject(new Error(`unreadable in-memory file ${path}`));
    }
    const file = this.files.get(path);
    if (!file) return Promise.reject(new Deno.errors.NotFound(path));
    return Promise.resolve(file.text);
  }

  readBytes(path: string): Promise<Uint8Array> {
    return this.readText(path).then((text) => new TextEncoder().encode(text));
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(
      this.files.has(path) || this.directories.has(path) ||
        [...this.files.keys()].some((file) => file.startsWith(`${path}/`)),
    );
  }

  writeText(path: string, text: string, mode = 0o644): Promise<void> {
    this.files.set(path, { text, mode });
    this.writes.push({ path, text, mode });
    return Promise.resolve();
  }

  makeDirectory(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  listFiles(directory: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.files.keys()].filter((file) => file.startsWith(`${directory}/`))
        .sort(),
    );
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  text(path: string): string {
    const file = this.files.get(path);
    if (!file) throw new Error(`missing in-memory file ${path}`);
    return file.text;
  }
}

class FakeHost {
  readonly fs = new FakeFileSystem();
  readonly calls: Call[] = [];
  readonly events: string[] = [];
  readonly background: { stopped: boolean; spec: M1CommandSpec }[] = [];
  readonly headReads: string[] = [];
  environment: Record<string, string> = {
    HOME: "/home/test",
    PATH: "/usr/bin:/bin",
    DOCKER_HOST: "unix:///run/test/docker.sock",
    XDG_RUNTIME_DIR: "/run/user/1000",
    // Must not reach any child: it is not on the allow-list.
    UNRELATED_SECRET_VARIABLE: "unrelated-secret-value-9999",
  };
  head = REVISION;
  headAfter: string | undefined;
  dirtySources = "";
  dirtyFull = "";
  memAvailableKb = 8_000_000;
  existingProject = "";
  spend = "12.340000";
  spendAfterJourney: string | undefined;
  serverScriptedDir = "";
  serverEnvironment = "development";
  workerScriptedDir = "";
  portAfter = "8000/tcp -> 127.0.0.1:34003";
  portReads = 0;
  composeDownCode = 0;
  projectLeftAfterDown = "";
  composeDownDone = false;
  downAttempted = false;
  workerActive = true;
  writeHostId = true;
  /** Per-call exit code override; return undefined to keep the default. */
  fail: (call: Call) => number | undefined = () => undefined;
  /** Per-call stdout override. */
  stdout: (call: Call) => string | undefined = () => undefined;
  journeyCode = 0;
  regressionCode = 0;
  /** Lowers the orchestrator's scan size limit so a tiny file is oversize. */
  maxScanBytes: number | undefined;
  /** Extra evidence files the journey leaves behind. */
  extraEvidence: Record<string, string> = {};
  /** Content of a binary trace the journey leaves in the evidence dir. */
  trace: ((call: Call) => string) | undefined;

  constructor() {
    this.fs.seed("/proc/meminfo", "");
    this.fs.seed("/home/test/.claude/.credentials.json", "{}");
    this.fs.seed(FAKE_SOURCE, FAKE_SCRIPT);
  }

  services(): Partial<M1Services> {
    this.fs.seed(
      "/proc/meminfo",
      `MemTotal: 16000000 kB\nMemAvailable: ${this.memAvailableKb} kB\n`,
    );
    let clock = Date.parse("2026-10-30T10:00:00.000Z");
    let random = 0;
    return {
      runner: {
        run: (spec) => Promise.resolve(this.run(spec)),
        start: (spec) => {
          const entry = { stopped: false, spec };
          this.background.push(entry);
          this.events.push("preview:start");
          return Promise.resolve({
            stop: () => {
              entry.stopped = true;
              this.events.push("preview:stop");
              return Promise.resolve();
            },
          });
        },
      },
      fileSystem: this.fs,
      environment: this.environment,
      root: ROOT,
      now: () => new Date(clock += 1_000),
      // One distinct character per call so no secret contains another.
      randomHex: (bytes) => "0123456789abcdef"[random++ % 16].repeat(bytes * 2),
      pickPort: () => Promise.resolve(18_520),
      sleep: () => Promise.resolve(),
      acquireLock: (path) => {
        this.events.push(`lock:acquire:${path}`);
        return Promise.resolve(() => {
          this.events.push("lock:release");
          return Promise.resolve();
        });
      },
      waitForHttp: (url) => {
        this.events.push(`http:${url}`);
        return Promise.resolve();
      },
      ...(this.maxScanBytes === undefined
        ? {}
        : { maxScanBytes: this.maxScanBytes }),
      lockPath: "/run/test/bakery-verification.lock",
      stateRoot: "/state",
    };
  }

  private run(spec: M1CommandSpec): M1CommandResult {
    const line = [spec.command, ...spec.args].join(" ");
    const call: Call = { ...spec, line };
    this.calls.push(call);
    this.events.push(`call:${line}`);
    const forced = this.fail(call);
    const result = this.respond(call);
    const stdout = this.stdout(call) ?? result.stdout ?? "";
    return {
      code: forced ?? result.code ?? 0,
      stdout,
      stderr: result.stderr ?? "",
    };
  }

  private respond(call: Call): Result {
    const { command, args } = call;
    const line = call.line;
    if (command === "git") {
      if (args[0] === "rev-parse") {
        const read = this.headReads.length === 0
          ? this.head
          : this.headAfter ?? this.head;
        this.headReads.push(read);
        return { stdout: `${read}\n` };
      }
      if (args[0] === "status") {
        return {
          stdout: args.includes("--") ? this.dirtySources : this.dirtyFull,
        };
      }
      if (args[0] === "-C" && args.includes("rev-parse")) {
        return { stdout: `${REVISION}\n` };
      }
      return {};
    }
    if (command === "sh" && args[1] === "command -v claude") {
      return { stdout: `${CLAUDE}\n` };
    }
    if (command === CLAUDE) return { stdout: "2.1.0 (Claude Code)\n" };
    if (command === "id") return { stdout: "1000\n" };
    if (command === "mv" || command === "mkdir") return {};
    if (command === "bash" && args[0] === "scripts/dev/compose-up.sh") {
      return {
        stdout: "BAKERY_POSTGRES_PORT=34001\nBAKERY_INNGEST_PORT=34002\n" +
          "BAKERY_SERVER_PORT=34003\nBAKERY_SERVER_HOST=127.0.0.1\n" +
          "BAKERY_PUBLIC_BASE_URL=http://127.0.0.1:34003\n" +
          "DATABASE_URL=postgres://bakery:bakery-local-bakery@127.0.0.1:34001/bakery\n",
      };
    }
    if (command === "bash" && args[0] === "scripts/dev/compose-down.sh") {
      this.downAttempted = true;
      // The real script runs `docker compose config -q` first, which aborts
      // without BETTER_AUTH_SECRET before anything is removed.
      if (!call.env.BETTER_AUTH_SECRET) {
        return {
          code: 1,
          stderr: "required variable BETTER_AUTH_SECRET is missing a value",
        };
      }
      if (this.composeDownCode === 0) this.composeDownDone = true;
      return { code: this.composeDownCode };
    }
    if (command === "bash" && args[0].endsWith("worker-kill.sh")) return {};
    if (command === "bash" && args[0].endsWith("worker-launch.sh")) return {};
    if (command === "docker") return this.respondDocker(call);
    if (command === "pnpm" && args.includes("vite") && args.includes("build")) {
      return {};
    }
    if (command === "pnpm" && args.includes("playwright")) {
      return this.respondPlaywright(call);
    }
    if (command === "systemctl") {
      if (args.includes("is-active")) {
        return this.workerActive
          ? { stdout: "active\n" }
          : { code: 3, stdout: "inactive\n" };
      }
      if (args.includes("show")) return { stdout: "4242\n" };
    }
    if (command === "sh" && args[1]?.includes("/proc/4242/environ")) {
      return {
        stdout: `BAKERY_ENV=development\n${
          this.workerScriptedDir
            ? `BAKERY_WORKER_SCRIPTED_HARNESS_DIR=${this.workerScriptedDir}\n`
            : ""
        }`,
      };
    }
    if (command === "sh") return {};
    throw new Error(`unscripted command: ${line}`);
  }

  /** The journey restarts the server, which recreates its container. */
  private serverRecreated(): boolean {
    return this.calls.some((call) =>
      call.args.includes("playwright") &&
      call.args.includes("--project=desktop-real-m1")
    );
  }

  private respondDocker(call: Call): Result {
    const { args } = call;
    if (args[0] === "ps") {
      if (this.composeDownDone) return { stdout: this.projectLeftAfterDown };
      if (this.downAttempted) return { stdout: "leaked-container\n" };
      return { stdout: this.existingProject };
    }
    if (args[0] === "port") {
      if (this.serverRecreated() && args[1] === SERVER_CONTAINER) {
        return { code: 1, stderr: "Error: No such container: " + args[1] };
      }
      this.portReads += 1;
      return {
        stdout: `${
          this.portReads === 1 ? "8000/tcp -> 127.0.0.1:34003" : this.portAfter
        }\n`,
      };
    }
    if (args[0] === "inspect") return { stdout: "true\n" };
    if (args[0] === "rm") return {};
    if (args[0] === "compose") {
      if (args.includes("ps")) {
        return {
          stdout: `${
            this.serverRecreated()
              ? RECREATED_SERVER_CONTAINER
              : SERVER_CONTAINER
          }\n`,
        };
      }
      if (args.includes("run")) return { stdout: `${DISPATCHER}\n` };
      if (args.includes("exec") && args.includes("server")) {
        return {
          stdout:
            `BAKERY_SCRIPTED_COORDINATOR_DIR=${this.serverScriptedDir}\n` +
            `BAKERY_ENV=${this.serverEnvironment}\n`,
        };
      }
      if (args.includes("exec") && args.includes("postgres")) {
        if (args.includes("-Atqc")) {
          const afterJourney = this.calls.some((call) =>
            call.args.includes("playwright") &&
            call.args.includes("--project=desktop-real-m1")
          );
          return {
            stdout: `${
              afterJourney ? this.spendAfterJourney ?? this.spend : this.spend
            }\n`,
          };
        }
        return { stdout: "INSERT 0 2\n" };
      }
    }
    throw new Error(`unscripted docker command: ${call.line}`);
  }

  private respondPlaywright(call: Call): Result {
    const journey = call.args.includes("--project=desktop-real-m1");
    if (journey) {
      if (this.writeHostId) {
        this.fs.seed(`${STATE}/worker-host-id.txt`, `${HOST_ID}\n`);
      }
      this.fs.seed(`${STATE}/enrollment-token`, `${ENROLLMENT_TOKEN}\n`);
      this.fs.seed(`${STATE}/fault-log.txt`, `${OPERATOR_LINE}\n`);
      this.fs.seed(
        `${OUT}/journey/ids.json`,
        JSON.stringify({ taskId: "t-1" }),
      );
      this.fs.seed(`${OUT}/journey/shot.png`, "PNG\u0000bytes");
      // Text evidence under an extension the scrub must not depend on.
      this.fs.seed(
        `${OUT}/journey/console.ndjson`,
        JSON.stringify({
          line:
            `enrollment ${ENROLLMENT_TOKEN} password ${call.env.BAKERY_REAL_PASSWORD}`,
        }) + "\n",
      );
      if (this.trace) {
        this.fs.seed(`${OUT}/journey/trace.zip`, this.trace(call));
      }
      // Sorts after journey/, so an early abort of the scrub would miss it.
      this.fs.seed(
        `${OUT}/playwright/journey/report.txt`,
        `owner ${call.env.BAKERY_REAL_PASSWORD} token ${ENROLLMENT_TOKEN}\n`,
      );
      for (const [name, text] of Object.entries(this.extraEvidence)) {
        this.fs.seed(`${OUT}/${name}`, text);
      }
    } else {
      this.fs.seed(`${OUT}/fs06/evidence.json`, "{}");
    }
    // The spec echoes secrets and credentials a real run could leak.
    return {
      code: journey ? this.journeyCode : this.regressionCode,
      stdout: [
        `password ${call.env.BAKERY_REAL_PASSWORD}`,
        `auth ${call.env.BETTER_AUTH_SECRET}`,
        "Cookie: better-auth.session_token=SESSIONVALUE1234567890",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        `enrollment ${ENROLLMENT_TOKEN}`,
        "token=plain-token-value-abcdef",
      ].join("\n"),
    };
  }
}

async function runProof(
  host: FakeHost,
  extra: { keepStackOnFailure?: boolean } = {},
): Promise<M1ProofManifest> {
  return await runM1Proof({
    out: OUT,
    ...extra,
    services: host.services(),
  });
}

async function expectFailure(
  host: FakeHost,
  code: string,
  extra: { keepStackOnFailure?: boolean } = {},
): Promise<M1ProofFailure> {
  const error = await assertRejects(
    () => runProof(host, extra),
    M1ProofError,
  );
  assertEquals((error as M1ProofError).code, code);
  assert(
    !host.fs.files.has(`${OUT}/${M1_MANIFEST_FILE}`),
    "a failed proof must not write a manifest",
  );
  return JSON.parse(
    host.fs.text(`${OUT}/${M1_FAILURE_FILE}`),
  ) as M1ProofFailure;
}

function callIndex(host: FakeHost, needle: string): number {
  return host.calls.findIndex((call) => call.line.includes(needle));
}

function stackEnvOf(host: FakeHost): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of host.fs.text(`${STATE}/stack.env`).split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    parsed[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return parsed;
}

function composeDownCalled(host: FakeHost): boolean {
  return host.calls.some((call) =>
    call.args[0] === "scripts/dev/compose-down.sh"
  );
}

// ---- the passing proof --------------------------------------------------------

Deno.test("a clean run writes a revision-bound manifest after both legs and cleanup", async () => {
  const host = new FakeHost();
  const manifest = await runProof(host);

  assertEquals(
    JSON.parse(host.fs.text(`${OUT}/${M1_MANIFEST_FILE}`)),
    JSON.parse(JSON.stringify(manifest)),
  );
  assertEquals(manifest.schema, "bakery.m1-proof/v1");
  assertEquals(manifest.composeProject, PROJECT);
  assertEquals(manifest.cleanup, "passed");
  assertEquals(manifest.spendCapUsd, 40);
  assertEquals(manifest.spendSettledUsd, "12.340000");
  assertEquals(manifest.workingTreeDirty, false);
  assertEquals(manifest.adapters, {
    scriptedCoordinator: false,
    scriptedHarness: false,
  });
  assertEquals(manifest.ids.workerHostId, HOST_ID);
  assertEquals(manifest.ids["journey.taskId"], "t-1");
  assertEquals(manifest.ids.workerUnit, UNIT);
  assertEquals(manifest.ids.harnessRepoHead, REVISION);

  // The revision is the head read after the run.
  assertEquals(manifest.revision, host.headReads.at(-1));
  assertEquals(host.headReads.length, 2);

  // Every command carries its exit code and a captured-output path.
  assert(manifest.commands.length > 20);
  for (const command of manifest.commands) {
    assertEquals(typeof command.exitCode, "number");
    assert(command.outputPath.length > 0);
  }
  assert(manifest.commands.every((command) => command.exitCode === 0));

  // Files are hashed and the manifest is not among them.
  const shot = manifest.files.find((file) => file.path === "journey/shot.png");
  assert(shot !== undefined);
  assertEquals(shot.bytes, 9);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("PNG\u0000bytes"),
  );
  assertEquals(
    shot.sha256,
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
      .join(""),
  );
  assert(!manifest.files.some((file) => file.path === M1_MANIFEST_FILE));
  assert(!host.fs.files.has(`${OUT}/${M1_FAILURE_FILE}`));
});

Deno.test("steps run in order: lock, stack, journey, regression leg, teardown", async () => {
  const host = new FakeHost();
  await runProof(host);

  const lock = host.events.findIndex((event) =>
    event.startsWith("lock:acquire")
  );
  const firstCompose = host.events.findIndex((event) =>
    event.includes("compose-up.sh")
  );
  assert(
    lock >= 0 && lock < firstCompose,
    "the lock is taken before the stack",
  );
  assertEquals(host.events.at(-1), "lock:release");
  assertEquals(
    host.events.filter((event) => event.startsWith("lock:")).length,
    2,
  );
  assertStringIncludes(host.events[lock], "bakery-verification.lock");

  const order = [
    "compose-up.sh",
    "run -d",
    "exec -T server",
    "psql",
    "vite build",
    "--project=desktop-real-m1",
    "worker-kill.sh",
    "worker-launch.sh",
    "run-observation-real-harness.spec",
    "compose-down.sh",
  ];
  let previous = -1;
  for (const needle of order) {
    const index = host.calls.findIndex((call, position) =>
      position > previous && call.line.includes(needle)
    );
    assert(index > previous, `${needle} must come after step ${previous}`);
    previous = index;
  }
  assertEquals(host.background.length, 1);
  assert(host.background[0].stopped, "the preview must be stopped");
  assert(
    host.events.indexOf("preview:stop") <
      host.events.indexOf("lock:release"),
  );
});

Deno.test("children get an allow-listed environment, never the caller's secrets", async () => {
  const host = new FakeHost();
  await runProof(host);
  for (const call of host.calls) {
    assert(
      !("UNRELATED_SECRET_VARIABLE" in call.env),
      `${call.line} inherited an unrelated variable`,
    );
  }
});

// ---- stack.env ----------------------------------------------------------------

Deno.test("stack.env is written whole, mode 0600, with every required first-start key", async () => {
  const host = new FakeHost();
  await runProof(host);
  const write = host.fs.writes.find((entry) =>
    entry.path === `${STATE}/stack.env`
  );
  assert(write !== undefined);
  assertEquals(write.mode, 0o600);

  const env = stackEnvOf(host);
  assertEquals(
    M1_REQUIRED_STACK_ENV_KEYS.length,
    16,
    "the required key list is the Phase 2 contract",
  );
  for (const key of M1_REQUIRED_STACK_ENV_KEYS) {
    assert(env[key] !== undefined && env[key] !== "", `${key} is missing`);
  }
  for (const [first, second] of M1_EQUAL_STACK_ENV_PAIRS) {
    assertEquals(env[first], env[second]);
  }
  assertEquals(env.BAKERY_ENV, "development");
  assertEquals(env.BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD, "40");
  assertEquals(env.BAKERY_BUDGET_RESERVATION_TTL_SECONDS, "3600");
  assertEquals(env.BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS, "86400");
  // The web origin, not the server URL compose-up.sh writes.
  assertEquals(env.BAKERY_WEB_PORT, "18520");
  assertEquals(env.BAKERY_PUBLIC_BASE_URL, "http://127.0.0.1:18520");
  assertEquals(env.BAKERY_SERVER_PORT, "34003");
  assertEquals(env.BAKERY_POSTGRES_PORT, "34001");
  assertEquals(env.BAKERY_INNGEST_PORT, "34002");
  assertEquals(env.DOCKER_HOST, "unix:///run/test/docker.sock");
  assertStringIncludes(env.DATABASE_URL, "@127.0.0.1:34001/bakery");
  assert(env.BETTER_AUTH_SECRET.length >= 32);
  assertEquals(env.BAKERY_INNGEST_SIGNING_KEY.length, 64);
});

Deno.test("a restart that loads stack.env verbatim repeats the first-start environment", async () => {
  const host = new FakeHost();
  await runProof(host);
  const env = stackEnvOf(host);
  const firstStart = host.calls.find((call) =>
    call.args[0] === "scripts/dev/compose-up.sh"
  );
  assert(firstStart !== undefined);
  for (const key of M1_FIRST_START_ENV_KEYS) {
    assertEquals(
      firstStart.env[key],
      env[key],
      `${key} differs between the first start and stack.env`,
    );
  }
  for (const key of ["BAKERY_SERVER_PORT", "BAKERY_POSTGRES_PORT"]) {
    assertEquals(
      firstStart.env[key],
      undefined,
      "ports float on the first start",
    );
  }
  // Every later compose call loads the whole file, resolved ports included.
  const later = host.calls.filter((call) =>
    call.command === "docker" && call.args[0] === "compose"
  );
  assert(later.length >= 5);
  for (const call of later) {
    for (const [key, value] of Object.entries(env)) {
      assertEquals(call.env[key], value, `${call.line} dropped ${key}`);
    }
  }
});

Deno.test("stack.env validation names keys only and rejects incomplete files", () => {
  const complete: Record<string, string> = {
    BAKERY_ENV: "development",
    BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: "40",
    BAKERY_BUDGET_RESERVATION_TTL_SECONDS: "3600",
    BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: "86400",
    BETTER_AUTH_SECRET: "s".repeat(40),
    BAKERY_INNGEST_EVENT_KEY: "event-key",
    INNGEST_EVENT_KEY: "event-key",
    BAKERY_INNGEST_SIGNING_KEY: "ab".repeat(32),
    INNGEST_SIGNING_KEY: "ab".repeat(32),
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:18520",
    BAKERY_WEB_PORT: "18520",
    BAKERY_SERVER_PORT: "34003",
    BAKERY_POSTGRES_PORT: "34001",
    BAKERY_INNGEST_PORT: "34002",
    DATABASE_URL: "postgres://bakery:pw@127.0.0.1:34001/bakery",
    DOCKER_HOST: "unix:///run/test/docker.sock",
  };
  assertStackEnvComplete(complete);
  assertStringIncludes(formatStackEnv(complete), "BAKERY_ENV=development\n");
  for (const key of M1_REQUIRED_STACK_ENV_KEYS) {
    const missing = { ...complete };
    delete missing[key];
    assertThrows(
      () => assertStackEnvComplete(missing),
      M1ProofError,
      key,
    );
    assertThrows(
      () => assertStackEnvComplete({ ...complete, [key]: "" }),
      M1ProofError,
      key,
    );
  }
  assertThrows(
    () => assertStackEnvComplete({ ...complete, INNGEST_EVENT_KEY: "other" }),
    M1ProofError,
    "M1_STACK_ENV_PAIR_MISMATCH",
  );
  assertThrows(
    () => assertStackEnvComplete({ ...complete, BAKERY_SERVER_PORT: "0" }),
    M1ProofError,
    "M1_STACK_ENV_PORT_INVALID",
  );
  const error = assertThrows(
    () => assertStackEnvComplete({ ...complete, BAKERY_ENV: "" }),
    M1ProofError,
  );
  assert(!error.message.includes("s".repeat(40)), "values must not be named");
});

// ---- billing ------------------------------------------------------------------

Deno.test("billing.json and the snapshot rows come from the same constants", async () => {
  const host = new FakeHost();
  await runProof(host);

  const billing = JSON.parse(host.fs.text(`${STATE}/billing.json`));
  assertEquals(billing, JSON.parse(JSON.stringify(billingFile())));
  assertEquals(billing.agents, JSON.parse(JSON.stringify(M1_AGENTS)));

  const rows = derivePricingSnapshotRows();
  assertEquals(billing.pricingSnapshots, JSON.parse(JSON.stringify(rows)));
  assertEquals(rows.map((row) => row.billingType).sort(), [
    "api",
    "subscription",
  ]);

  const insert = host.calls.find((call) =>
    call.args.includes("psql") && call.args.includes("-c")
  );
  assert(insert !== undefined);
  const sql = insert.args[insert.args.indexOf("-c") + 1];
  assertEquals(sql, pricingSnapshotSql(rows));
  for (const row of rows) {
    assertStringIncludes(sql, `'${row.billingType}'`);
    assertStringIncludes(sql, `'${row.model}'`);
  }
});

Deno.test("billing constants: subscription coordinator, per-run reservations 1 and 5", () => {
  assertEquals(M1_AGENTS.coordinator.config.harness, "claude_code");
  assertEquals(
    M1_AGENTS.coordinator.config.billing.billingRoute,
    "subscription",
  );
  assertEquals(M1_AGENTS.coordinator.config.billing.maxUsdReservation, 1);
  assertEquals(M1_AGENTS.coder.config.billing.maxUsdReservation, 5);
  assertEquals(M1_AGENTS.coordinator.config.billing.model, M1_PROOF_MODEL);
  assertEquals(M1_AGENTS.coder.config.billing.model, "claude-sonnet-5-5");
  assertEquals(M1_AGENTS.coordinator.config.allowedCapabilities, ["model"]);
  assertEquals(derivePricingSnapshotRows().length, 2);
  const sql = pricingSnapshotSql([{
    provider: "p'q",
    billingAccountId: "a",
    model: "m",
    billingType: "api",
    pricingMetadataSnapshot: "v1",
    sourceReference: "s",
  }]);
  assertStringIncludes(sql, "'p''q'");
  assertThrows(() => pricingSnapshotSql([]), Error, "ROWS_EMPTY");
});

Deno.test("the pricing snapshot is recorded as operator step 1 and spec steps are merged", async () => {
  const host = new FakeHost();
  const manifest = await runProof(host);
  assertEquals(manifest.operatorSteps[0].name, "pricing-snapshot");
  assertEquals(manifest.operatorSteps[0].command, pricingSnapshotSql());
  assertEquals(manifest.operatorSteps[0].exitCode, 0);
  const expiry = manifest.operatorSteps.find((step) =>
    step.name === "force-approval-expiry"
  );
  assert(expiry !== undefined);
  assertStringIncludes(
    expiry.command,
    "update bakery.questions set expires_at",
  );
  assertStringIncludes(expiry.command, "11111111-1111-4111-8111-111111111111");
  assertEquals(expiry.exitCode, 0);
});

Deno.test("operator step lines: the marker is required, a changed-row count of one succeeds", () => {
  assertEquals(parseOperatorStepLine("plain fault line"), undefined);
  assertEquals(parseOperatorStepLine('{"other":1}'), undefined);
  assertEquals(
    parseOperatorStepLine(
      '{"m1":"operator-step","name":"a","sql":"s","rowCount":0}',
    )
      ?.exitCode,
    1,
  );
  assertEquals(
    parseOperatorStepLine(
      '{"m1":"operator-step","name":"b","command":"c","exitCode":0}',
    ),
    { name: "b", command: "c", exitCode: 0 },
  );
  assertThrows(
    () => parseOperatorStepLine('{"m1":"operator-step"'),
    M1ProofError,
    "M1_OPERATOR_STEP_RECORD_INVALID",
  );
  assertThrows(
    () => parseOperatorStepLine('{"m1":"operator-step","name":"x"}'),
    M1ProofError,
    "M1_OPERATOR_STEP_RECORD_INVALID",
  );
});

// ---- worker files and the two legs -----------------------------------------------

Deno.test("the state directory holds the files the spec helpers expect", async () => {
  const host = new FakeHost();
  await runProof(host);
  for (
    const name of [
      M1_STATE_FILES.stackEnv,
      M1_STATE_FILES.billing,
      M1_STATE_FILES.workerLaunch,
      M1_STATE_FILES.workerKill,
      M1_STATE_FILES.secretsToScan,
      `${M1_STATE_FILES.fakeDirectory}/fake-claude-slow.sh`,
      `${M1_STATE_FILES.fakeDirectory}/fs06-fake.conf`,
    ]
  ) {
    assert(host.fs.files.has(`${STATE}/${name}`), `${name} is missing`);
  }
  assertEquals(host.fs.files.get(`${STATE}/worker-launch.sh`)?.mode, 0o700);
  assertEquals(host.fs.files.get(`${STATE}/worker-kill.sh`)?.mode, 0o700);
  assertEquals(host.fs.files.get(`${STATE}/secrets-to-scan.txt`)?.mode, 0o600);
  assert(host.fs.directories.has(STATE));

  const launch = host.fs.text(`${STATE}/worker-launch.sh`);
  assertStringIncludes(launch, `reset --hard ${REVISION}`);
  assertStringIncludes(launch, "clean -fdx");
  assertStringIncludes(launch, `unit=${UNIT}`);
  assertStringIncludes(launch, "scripts/run-worker.sh");
  assertStringIncludes(launch, "EnvironmentFile");
  const kill = host.fs.text(`${STATE}/worker-kill.sh`);
  assertStringIncludes(kill, "SIGKILL");
  assertStringIncludes(kill, "exit 0");
});

Deno.test("worker.env pins the proof model and effort and differs in leg 2 only by the executable", async () => {
  const host = new FakeHost();
  await runProof(host);
  const writes = host.fs.writes.filter((entry) =>
    entry.path === `${STATE}/worker.env`
  );
  assertEquals(writes.length, 2);
  const [journey, regression] = writes.map((entry) => entry.text.split("\n"));
  const executable = "BAKERY_CLAUDE_HARNESS_EXECUTABLE=";
  assert(journey.includes(`${executable}"${CLAUDE}"`));
  assert(
    regression.includes(
      `${executable}"${STATE}/fake/fake-claude-slow.sh"`,
    ),
  );
  assertEquals(
    journey.filter((line) => !line.startsWith(executable)),
    regression.filter((line) => !line.startsWith(executable)),
  );
  const text = writes[0].text;
  assertStringIncludes(text, 'BAKERY_ENV="development"');
  assertStringIncludes(text, 'BAKERY_CLAUDE_HARNESS_MODEL="claude-sonnet-5-5"');
  assertStringIncludes(text, 'BAKERY_CLAUDE_HARNESS_EFFORT="high"');
  assertStringIncludes(text, 'BAKERY_CLAUDE_HARNESS_TIME_LIMIT_MS="900000"');
  assertStringIncludes(text, 'BAKERY_CLAUDE_COORDINATOR_EFFORT="medium"');
  assertStringIncludes(
    text,
    'BAKERY_CLAUDE_COORDINATOR_TIME_LIMIT_MS="300000"',
  );
  assertStringIncludes(
    text,
    `BAKERY_CLAUDE_HARNESS_REPOSITORY="${STATE}/harness-repo"`,
  );
  assertStringIncludes(text, "BAKERY_WORKER_OUTPUT_REDACTION_SECRETS=");
  assertStringIncludes(
    text,
    `BAKERY_WORKER_CGROUP_ROOT="/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/${PROJECT}"`,
  );
  assertEquals(writes[0].mode, 0o600);
  assert(
    !text.includes("BAKERY_WORKER_SCRIPTED_HARNESS_DIR"),
    "no scripted harness variable",
  );
  assertEquals(
    host.fs.text(`${STATE}/fake/fs06-fake.conf`),
    `FS06_FAKE_COUNTER=${STATE}/fake/counter.txt\n`,
  );
  assertEquals(
    host.fs.files.get(`${STATE}/fake/fake-claude-slow.sh`)?.mode,
    0o755,
  );
  assertEquals(host.fs.text(`${STATE}/fake/fake-claude-slow.sh`), FAKE_SCRIPT);
});

Deno.test("the journey and the regression leg get the documented environment", async () => {
  const host = new FakeHost();
  await runProof(host);
  const journey = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-m1")
  );
  assert(journey !== undefined);
  assertEquals(journey.args.slice(0, 5), [
    "--dir",
    "apps/web",
    "exec",
    "playwright",
    "test",
  ]);
  assert(journey.args.includes("--workers=1"));
  const stack = stackEnvOf(host);
  const expected: Record<string, string> = {
    BAKERY_REAL_API: "1",
    BAKERY_REAL_API_M1: "1",
    BAKERY_M1_STATE_DIR: STATE,
    BAKERY_M1_COMPOSE_PROJECT: PROJECT,
    BAKERY_M1_SPEND_CAP_USD: "40",
    BAKERY_M1_CANARIES_FILE: `${STATE}/canaries.json`,
    BAKERY_M1_HARNESS_REPO: `${STATE}/harness-repo`,
    BASE_URL: "http://127.0.0.1:18520",
    BAKERY_WEB_PORT: "18520",
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:18520",
    DATABASE_URL: stack.DATABASE_URL,
    BETTER_AUTH_SECRET: stack.BETTER_AUTH_SECRET,
    INNGEST_EVENT_KEY: stack.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY: stack.INNGEST_SIGNING_KEY,
    BAKERY_REAL_EMAIL: "m1-proof-owner@example.test",
    DOCKER_HOST: "unix:///run/test/docker.sock",
  };
  for (const [key, value] of Object.entries(expected)) {
    assertEquals(journey.env[key], value, key);
  }
  assert(journey.env.BAKERY_REAL_PASSWORD.length > 12);
  assertEquals(journey.env.BAKERY_M1_STOP_AFTER, undefined);
  assertEquals(journey.env.BAKERY_SCRIPTED_COORDINATOR_DIR, undefined);
  assertEquals(journey.env.BAKERY_WORKER_SCRIPTED_HARNESS_DIR, undefined);

  const fs06 = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-harness")
  );
  assert(fs06 !== undefined);
  assertEquals(fs06.args[5], "run-observation-real-harness.spec");
  assert(fs06.args.includes("--workers=1"));
  const fs06Expected: Record<string, string> = {
    BAKERY_REAL_API: "1",
    BAKERY_REAL_API_HARNESS: "1",
    BAKERY_FS06_MODE: "start",
    BAKERY_FS06_HARNESS: "fake",
    BAKERY_FS06_CANARIES_FILE: `${STATE}/canaries.json`,
    BAKERY_FS06_HARNESS_REPO: `${STATE}/harness-repo`,
    BAKERY_FS06_WORKER_HOST_ID: HOST_ID,
    BAKERY_FS06_SHOTS: `${OUT}/fs06`,
    BAKERY_REAL_PASSWORD: journey.env.BAKERY_REAL_PASSWORD,
    BAKERY_REAL_EMAIL: "m1-proof-owner@example.test",
    DATABASE_URL: stack.DATABASE_URL,
    BETTER_AUTH_SECRET: stack.BETTER_AUTH_SECRET,
  };
  for (const [key, value] of Object.entries(fs06Expected)) {
    assertEquals(fs06.env[key], value, key);
  }
});

Deno.test("the vite preview serves the production build strictly on the web port", async () => {
  const host = new FakeHost();
  await runProof(host);
  const build = host.calls.find((call) => call.line.includes("vite build"));
  assert(build !== undefined);
  assert(build.args.includes(`${STATE}/web`));
  assert(!build.args.includes("--mode"), "default production mode");
  const preview = host.background[0].spec;
  assertEquals(preview.args.slice(0, 5), [
    "--dir",
    "apps/web",
    "exec",
    "vite",
    "preview",
  ]);
  assert(preview.args.includes("--strictPort"));
  assertEquals(preview.args[preview.args.indexOf("--port") + 1], "18520");
  assertEquals(preview.args[preview.args.indexOf("--host") + 1], "127.0.0.1");
  assertEquals(
    preview.args[preview.args.indexOf("--outDir") + 1],
    `${STATE}/web`,
  );
  assertEquals(preview.env.BAKERY_SERVER_PORT, "34003");
});

Deno.test("secrets-to-scan lists canaries, owner password, auth secret and the enrollment token", async () => {
  const host = new FakeHost();
  await runProof(host);
  const lines = host.fs.text(`${STATE}/secrets-to-scan.txt`).split("\n");
  const canaries: string[] = JSON.parse(host.fs.text(`${STATE}/canaries.json`));
  assertEquals(canaries.length, 2);
  for (const canary of canaries) assert(lines.includes(canary));
  const journey = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-m1")
  )!;
  assert(lines.includes(journey.env.BAKERY_REAL_PASSWORD));
  assert(lines.includes(stackEnvOf(host).BETTER_AUTH_SECRET));
  assert(lines.includes(ENROLLMENT_TOKEN));
  // The escaped spelling of the quote-and-backslash canary is scanned too.
  assert(lines.includes(JSON.stringify(canaries[1]).slice(1, -1)));
  assertNotEquals(canaries[1], JSON.stringify(canaries[1]).slice(1, -1));
});

Deno.test("no secret, token or cookie reaches the evidence directory or the manifest", async () => {
  const host = new FakeHost();
  const manifest = await runProof(host);
  const stack = stackEnvOf(host);
  const journey = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-m1")
  )!;
  const canaries: string[] = JSON.parse(host.fs.text(`${STATE}/canaries.json`));
  const secrets = [
    stack.BETTER_AUTH_SECRET,
    stack.BAKERY_INNGEST_EVENT_KEY,
    stack.BAKERY_INNGEST_SIGNING_KEY,
    journey.env.BAKERY_REAL_PASSWORD,
    ENROLLMENT_TOKEN,
    "SESSIONVALUE1234567890",
    "abcdefghijklmnopqrstuvwxyz",
    "plain-token-value-abcdef",
    ...canaries,
    ...canaries.map((canary) => JSON.stringify(canary).slice(1, -1)),
  ];
  const evidence = [
    JSON.stringify(manifest),
    ...(await host.fs.listFiles(OUT)).map((path) => host.fs.text(path)),
  ].join("\n");
  for (const secret of secrets) {
    assert(
      !evidence.includes(secret),
      `a secret leaked into the evidence: ${secret.slice(0, 4)}...`,
    );
  }
  const log = host.fs.text(
    `${OUT}/${
      manifest.commands.find((command) =>
        command.command.includes("--project=desktop-real-m1")
      )!.outputPath
    }`,
  );
  assertStringIncludes(log, "[REDACTED]");
  assertStringIncludes(log, "Cookie: [REDACTED]");
  assertStringIncludes(log, "Bearer [REDACTED]");
  // The state directory keeps the real values; only the evidence is redacted.
  assertStringIncludes(
    host.fs.text(`${STATE}/stack.env`),
    stack.BETTER_AUTH_SECRET,
  );
});

Deno.test("the redactor hides registered secrets, bearer tokens, cookies and key=value secrets", () => {
  const redactor = new M1Redactor();
  redactor.add("registered-secret-value");
  redactor.add("short");
  const text = redactor.apply(
    [
      "x registered-secret-value y",
      "short stays",
      "Set-Cookie: sid=abc123; Path=/",
      "authorization: Bearer abcdefghij0123",
      "send Bearer 0123456789abcdef now",
      "better-auth.session_token=tok123.sig; other=1",
      "password=hunter2 api_key=k-1 secret=s-1 token=t-1",
      "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=/state/enrollment-token",
    ].join("\n"),
  );
  for (
    const leaked of [
      "registered-secret-value",
      "sid=abc123",
      "abcdefghij0123",
      "0123456789abcdef",
      "tok123.sig",
      "hunter2",
      "k-1",
      "s-1",
      "t-1",
    ]
  ) assert(!text.includes(leaked), `${leaked} survived`);
  assertStringIncludes(text, "short stays");
  assertStringIncludes(
    text,
    "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=/state/enrollment-token",
  );
});

// ---- preflight refusals --------------------------------------------------------

async function expectRefusal(
  code: string,
  arrange: (host: FakeHost) => void,
): Promise<FakeHost> {
  const host = new FakeHost();
  arrange(host);
  const failure = await expectFailure(host, code);
  assertStringIncludes(failure.error, code);
  assertEquals(failure.cleanup, "passed");
  assert(
    !host.calls.some((call) => call.args[0] === "scripts/dev/compose-up.sh"),
    `${code}: no stack may start`,
  );
  assertEquals(host.background.length, 0);
  assert(!composeDownCalled(host), `${code}: nothing to tear down`);
  return host;
}

Deno.test("preflight refuses a dirty tree", async () => {
  const host = await expectRefusal("M1_DIRTY_TREE", (host) => {
    host.dirtySources = " M apps/web/src/router.tsx\n";
  });
  assertEquals(
    host.events.filter((event) => event.startsWith("lock:")).length,
    0,
    "a dirty tree is refused before the lock",
  );
});

Deno.test("preflight refuses a spend cap above 40 and an invalid cap", async () => {
  await expectRefusal("M1_SPEND_CAP_ABOVE_LIMIT", (host) => {
    host.environment.BAKERY_M1_SPEND_CAP_USD = "40.01";
  });
  await expectRefusal("M1_SPEND_CAP_ABOVE_LIMIT", (host) => {
    host.environment.BAKERY_M1_SPEND_CAP_USD = "400";
  });
  for (const invalid of ["abc", "0", "-5", "1e2", ""]) {
    if (invalid === "") continue;
    await expectRefusal("M1_SPEND_CAP_INVALID", (host) => {
      host.environment.BAKERY_M1_SPEND_CAP_USD = invalid;
    });
  }
});

Deno.test("a lower spend cap is passed on and lowers the installation limit", async () => {
  const host = new FakeHost();
  host.environment.BAKERY_M1_SPEND_CAP_USD = "12.5";
  host.spend = "1.000000";
  const manifest = await runProof(host);
  assertEquals(manifest.spendCapUsd, 12.5);
  assertEquals(
    stackEnvOf(host).BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD,
    "12.5",
  );
});

Deno.test("preflight refuses a missing Claude login and an unusable claude", async () => {
  await expectRefusal("M1_CLAUDE_LOGIN_MISSING", (host) => {
    host.fs.files.delete("/home/test/.claude/.credentials.json");
  });
  await expectRefusal("M1_CLAUDE_UNAVAILABLE", (host) => {
    host.fail = (call) => call.command === CLAUDE ? 1 : undefined;
  });
  await expectRefusal("M1_CLAUDE_UNAVAILABLE", (host) => {
    host.stdout = (call) =>
      call.args[1] === "command -v claude" ? "" : undefined;
  });
});

Deno.test("preflight refuses a missing DOCKER_HOST, low memory and an existing project", async () => {
  await expectRefusal("M1_DOCKER_HOST_REQUIRED", (host) => {
    delete host.environment.DOCKER_HOST;
  });
  await expectRefusal("M1_MEMORY_LOW", (host) => {
    host.memAvailableKb = 1_000_000;
  });
  await expectRefusal("M1_PROJECT_EXISTS", (host) => {
    host.existingProject = "abc123\n";
  });
});

Deno.test("an existing state directory is moved aside, never reused", async () => {
  const host = new FakeHost();
  host.fs.seed(`${STATE}/stack.env`, "OLD=1\n");
  await runProof(host);
  const move = host.calls.find((call) => call.command === "mv");
  assert(move !== undefined);
  assertEquals(move.args[0], STATE);
  assertStringIncludes(move.args[1], `${STATE}.bak-`);
});

Deno.test("the out directory must be empty and outside the source tree", async () => {
  const host = new FakeHost();
  host.fs.seed(`${OUT}/old.txt`, "x");
  await assertRejects(
    () => runProof(host),
    M1ProofError,
    "M1_OUT_DIR_NOT_EMPTY",
  );
  assertEquals(host.calls.length, 0);
  const inside = new FakeHost();
  await assertRejects(
    () =>
      runM1Proof({
        out: "/repo/apps/web/evidence",
        services: inside.services(),
      }),
    M1ProofError,
    "M1_OUT_DIR_INSIDE_SOURCE",
  );
});

// ---- guards ------------------------------------------------------------------------

Deno.test("a scripted coordinator directory on the server stops the proof before the journey", async () => {
  const host = new FakeHost();
  host.serverScriptedDir = "/workspace/tests/fixtures/scripted-coordinator";
  const failure = await expectFailure(host, "M1_SCRIPTED_COORDINATOR_PRESENT");
  assertEquals(failure.failedStep, "guard-server-env");
  assertEquals(failure.adapters.scriptedCoordinator, null);
  assertEquals(callIndex(host, "playwright"), -1);
  assertEquals(callIndex(host, "pricing"), -1);
  assert(composeDownCalled(host), "the stack must be torn down");
  assertEquals(failure.cleanup, "passed");
});

Deno.test("the empty string counts as an unset scripted coordinator directory", async () => {
  const host = new FakeHost();
  host.serverScriptedDir = "";
  const manifest = await runProof(host);
  assertEquals(manifest.adapters.scriptedCoordinator, false);
});

Deno.test("a server that is not under development stops the proof", async () => {
  const host = new FakeHost();
  host.serverEnvironment = "test";
  const failure = await expectFailure(host, "M1_SERVER_ENV_UNEXPECTED");
  assertEquals(failure.failedStep, "guard-server-env");
});

Deno.test("a scripted harness directory in the running worker stops the proof after the journey", async () => {
  const host = new FakeHost();
  host.workerScriptedDir = "/tmp/scripted-harness";
  const failure = await expectFailure(host, "M1_SCRIPTED_HARNESS_PRESENT");
  assertEquals(failure.adapters.scriptedHarness, null);
  assertEquals(callIndex(host, "run-observation-real-harness"), -1);
  assert(composeDownCalled(host));
});

Deno.test("a scripted harness directory in the restarted fake worker stops the regression leg", async () => {
  const host = new FakeHost();
  host.fail = (call) => {
    if (call.args[0]?.endsWith("worker-launch.sh")) {
      host.workerScriptedDir = "/tmp/scripted-harness";
    }
    return undefined;
  };
  const failure = await expectFailure(host, "M1_SCRIPTED_HARNESS_PRESENT");
  assertStringIncludes(failure.failedStep, "guard-worker-env-regression");
  assertEquals(failure.adapters.scriptedHarness, null);
  assertEquals(callIndex(host, "run-observation-real-harness"), -1);
  assert(composeDownCalled(host));
  assertEquals(failure.cleanup, "passed");
});

Deno.test("the journey must leave the worker unit active", async () => {
  const host = new FakeHost();
  host.workerActive = false;
  const failure = await expectFailure(host, "M1_WORKER_NOT_ACTIVE");
  assertEquals(failure.failedStep, "guard-worker-active-journey");
  assertEquals(failure.adapters.scriptedHarness, null);
  assertEquals(callIndex(host, "worker-launch.sh"), -1);
  assertEquals(callIndex(host, "run-observation-real-harness"), -1);
  assert(composeDownCalled(host));
  assertEquals(failure.cleanup, "passed");
});

Deno.test("an inactive restarted worker cannot start the regression leg", async () => {
  const host = new FakeHost();
  host.fail = (call) => {
    if (call.args[0]?.endsWith("worker-launch.sh")) host.workerActive = false;
    return undefined;
  };
  const failure = await expectFailure(host, "M1_WORKER_NOT_ACTIVE");
  assertEquals(failure.failedStep, "guard-worker-active-regression");
  assertEquals(callIndex(host, "run-observation-real-harness"), -1);
  assert(composeDownCalled(host));
  assertEquals(failure.cleanup, "passed");
});

// ---- failure paths -------------------------------------------------------------------

Deno.test("a failing journey leg writes no manifest, skips leg 2 and tears down", async () => {
  const host = new FakeHost();
  host.journeyCode = 1;
  const failure = await expectFailure(host, "M1_STEP_FAILED");
  assertEquals(failure.failedStep, "playwright-journey");
  assertEquals(callIndex(host, "run-observation-real-harness"), -1);
  assert(composeDownCalled(host));
  assertEquals(failure.cleanup, "passed");
  const journey = failure.commands.find((command) =>
    command.command.includes("--project=desktop-real-m1")
  );
  assertEquals(journey?.exitCode, 1);
  assert(host.background[0].stopped);
  assertEquals(host.events.at(-1), "lock:release");
});

Deno.test("a failing regression leg writes no manifest and tears down", async () => {
  const host = new FakeHost();
  host.regressionCode = 1;
  const failure = await expectFailure(host, "M1_STEP_FAILED");
  assertEquals(failure.failedStep, "playwright-fs06");
  assert(composeDownCalled(host));
  assertEquals(failure.cleanup, "passed");
  assertEquals(
    failure.commands.find((command) =>
      command.command.includes("--project=desktop-real-harness")
    )?.exitCode,
    1,
  );
});

Deno.test("teardown runs on every failure path after the stack starts", async () => {
  type Target = {
    label: string;
    /** A fresh predicate per run, so "first call only" targets work. */
    matcher: (host: FakeHost) => (call: Call) => boolean;
    /** The worker kill script and the unit exist from this point on. */
    workerFiles: boolean;
    cgroup: boolean;
  };
  type TargetInput =
    & Omit<Target, "workerFiles" | "cgroup">
    & Partial<Pick<Target, "workerFiles" | "cgroup">>;
  const once = (match: (call: Call) => boolean) => () => {
    let seen = false;
    return (call: Call) => {
      if (seen || !match(call)) return false;
      seen = true;
      return true;
    };
  };
  const inputs: TargetInput[] = [
    {
      label: "compose-up",
      matcher: () => (call) => call.args[0] === "scripts/dev/compose-up.sh",
    },
    {
      label: "compose ps",
      matcher: () => (call) =>
        call.args[0] === "compose" && call.args.includes("ps"),
    },
    {
      label: "dispatcher run",
      matcher: () => (call) =>
        call.args[0] === "compose" && call.args.includes("run"),
    },
    {
      label: "dispatcher inspect",
      matcher: () => (call) => call.args[0] === "inspect",
    },
    {
      label: "server guard",
      matcher: () => (call) =>
        call.args.includes("server") && call.args.includes("exec"),
    },
    {
      label: "pricing",
      matcher: () => (call) =>
        call.args.includes("-c") && call.args.includes("psql"),
    },
    {
      label: "web build",
      matcher: () => (call) => call.args.includes("build"),
    },
    {
      label: "harness clone",
      matcher: () => (call) => call.args[0] === "clone",
    },
    {
      label: "harness checkout",
      matcher: () => (call) => call.args.includes("checkout"),
    },
    {
      label: "cgroup mkdir",
      matcher: () => (call) => call.command === "mkdir",
      cgroup: true,
    },
    {
      label: "cgroup controllers",
      matcher: () => (call) =>
        call.args[1]?.includes("subtree_control") === true,
      cgroup: true,
    },
    {
      label: "journey",
      matcher: () => (call) => call.args.includes("--project=desktop-real-m1"),
      workerFiles: true,
      cgroup: true,
    },
    {
      label: "worker stop",
      matcher: once((call) =>
        call.args[0]?.endsWith("worker-kill.sh") === true
      ),
      workerFiles: true,
      cgroup: true,
    },
    {
      label: "worker start",
      matcher: () => (call) =>
        call.args[0]?.endsWith("worker-launch.sh") === true,
      workerFiles: true,
      cgroup: true,
    },
    {
      label: "fs06",
      matcher: () => (call) =>
        call.args.includes("--project=desktop-real-harness"),
      workerFiles: true,
      cgroup: true,
    },
    {
      label: "spend",
      matcher: () => (call) => call.args.includes("-Atqc"),
      workerFiles: true,
      cgroup: true,
    },
    {
      label: "head after",
      matcher: (host) => (call) =>
        call.args[0] === "rev-parse" && host.headReads.length === 1,
      workerFiles: true,
      cgroup: true,
    },
  ];
  const targets: Target[] = inputs.map((target) => ({
    workerFiles: false,
    cgroup: false,
    ...target,
  }));

  for (const target of targets) {
    const host = new FakeHost();
    const matches = target.matcher(host);
    host.fail = (call) => matches(call) ? 1 : undefined;
    const failure = await expectFailure(host, "M1_STEP_FAILED");
    const { label } = target;
    assert(failure.error.length > 0, label);
    assert(composeDownCalled(host), `${label}: compose-down must run`);
    assertEquals(failure.cleanup, "passed", label);
    assertEquals(host.events.at(-1), "lock:release", label);
    const killed = host.calls.filter((call) =>
      call.args[0]?.endsWith("worker-kill.sh") === true
    ).length;
    if (target.workerFiles) {
      assert(killed >= 1, `${label}: the worker unit must be stopped`);
      assertEquals(
        host.calls.at(-1)?.args.includes("-q") ||
          host.calls.some((call) =>
            call.args[0] === "rm"
          ),
        true,
        label,
      );
    }
    assertEquals(
      host.calls.some((call) =>
        call.command === "sh" && call.line.includes("find") &&
        call.line.includes("rmdir")
      ),
      target.cgroup,
      `${label}: the cgroup root is removed exactly once it was created`,
    );
    if (host.background.length > 0) {
      assert(host.background.every((entry) => entry.stopped), label);
    }
  }
});

Deno.test("a failed cleanup keeps the manifest from being written", async () => {
  const host = new FakeHost();
  host.composeDownCode = 1;
  const failure = await expectFailure(host, "M1_CLEANUP_FAILED");
  assertEquals(failure.cleanup, "failed");
  assertStringIncludes(failure.error, "compose-down");

  const left = new FakeHost();
  left.projectLeftAfterDown = "deadbeef\n";
  const leftFailure = await expectFailure(left, "M1_CLEANUP_FAILED");
  assertEquals(leftFailure.cleanup, "failed");
  assertStringIncludes(leftFailure.error, "project-empty");
});

Deno.test("keep-stack-on-failure leaves the stack but still writes the failure record", async () => {
  const host = new FakeHost();
  host.journeyCode = 1;
  const failure = await expectFailure(host, "M1_STEP_FAILED", {
    keepStackOnFailure: true,
  });
  assertEquals(failure.cleanup, "skipped");
  assert(!composeDownCalled(host));
  assertEquals(host.background[0].stopped, false);
  assertEquals(host.events.at(-1), "lock:release");
});

Deno.test("a changed head during the run is refused and no manifest is written", async () => {
  const host = new FakeHost();
  host.headAfter = "f".repeat(40);
  const failure = await expectFailure(host, "M1_REVISION_CHANGED");
  assertEquals(failure.revision, REVISION);
  assert(composeDownCalled(host));
});

Deno.test("sources that became dirty during the run are refused", async () => {
  const host = new FakeHost();
  host.fail = () => undefined;
  host.stdout = (call) =>
    call.args[0] === "status" && call.args.includes("--") &&
      host.headReads.length === 2
      ? " M apps/server/src/app.ts\n"
      : undefined;
  await expectFailure(host, "M1_DIRTY_TREE_AFTER_RUN");
});

Deno.test("an unrelated dirty file outside the sources is recorded, not refused", async () => {
  const host = new FakeHost();
  host.dirtyFull =
    " M docs/runbooks/task-conversation.md\n?? .agents/tasks/x\n";
  const manifest = await runProof(host);
  assertEquals(manifest.workingTreeDirty, true);
  const clean = new FakeHost();
  clean.dirtyFull = "?? .agents/tasks/g1-prove-usable-full/evidence/\n";
  assertEquals((await runProof(clean)).workingTreeDirty, false);
});

Deno.test("a stop-after debug run proves nothing and writes no manifest", async () => {
  const host = new FakeHost();
  host.environment.BAKERY_M1_STOP_AFTER = "P3";
  const failure = await expectFailure(host, "M1_PARTIAL_RUN");
  const journey = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-m1")
  )!;
  assertEquals(journey.env.BAKERY_M1_STOP_AFTER, "P3");
  assertEquals(callIndex(host, "run-observation-real-harness"), -1);
  assert(composeDownCalled(host));
  assertEquals(failure.cleanup, "passed");
});

Deno.test("spend above the cap, port drift and a missing host id each fail closed", async () => {
  const spend = new FakeHost();
  spend.spendAfterJourney = "40.000001";
  const spendFailure = await expectFailure(spend, "M1_SPEND_CAP_REACHED");
  assertEquals(callIndex(spend, "run-observation-real-harness"), -1);
  assertEquals(spendFailure.spendSettledUsd, "40.000001");

  const exactly = new FakeHost();
  exactly.spend = "40.000000";
  assertEquals((await runProof(exactly)).spendSettledUsd, "40.000000");

  const drift = new FakeHost();
  drift.portAfter = "8000/tcp -> 127.0.0.1:41999";
  await expectFailure(drift, "M1_SERVER_PORT_DRIFT");

  const noHost = new FakeHost();
  noHost.writeHostId = false;
  await expectFailure(noHost, "M1_WORKER_HOST_ID_MISSING");
});

// ---- pure helpers ---------------------------------------------------------------------

Deno.test("systemd environment lines quote and escape values", () => {
  assertEquals(systemdEnvLine("A", "plain"), 'A="plain"');
  assertEquals(systemdEnvLine("A", 'q"b\\c'), 'A="q\\"b\\\\c"');
  assertEquals(
    systemdEnvLine("A", JSON.stringify(['m1"q\\x'])),
    'A="[\\"m1\\\\\\"q\\\\\\\\x\\"]"',
  );
  assertThrows(
    () => systemdEnvLine("A", "a\nb"),
    M1ProofError,
    "M1_ENV_VALUE_INVALID",
  );
  assertThrows(
    () => systemdEnvLine("1A", "x"),
    M1ProofError,
    "M1_ENV_KEY_INVALID",
  );
});

Deno.test("micro-USD parsing is exact", () => {
  assertEquals(microUsd("0"), 0n);
  assertEquals(microUsd("40"), 40_000_000n);
  assertEquals(microUsd("40.000001"), 40_000_001n);
  assertEquals(microUsd("0.1"), 100_000n);
  assertEquals(microUsd("1.2345678"), 1_234_567n);
  assertThrows(() => microUsd("-1"), M1ProofError, "M1_USD_INVALID");
  assertThrows(() => microUsd("1e3"), M1ProofError, "M1_USD_INVALID");
});

Deno.test("command line arguments need --out and reject unknown flags", () => {
  assertEquals(parseArguments(["--out", "ev"]), {
    out: "ev",
    keepStackOnFailure: false,
  });
  assertEquals(parseArguments(["--out=ev", "--keep-stack-on-failure"]), {
    out: "ev",
    keepStackOnFailure: true,
  });
  assertThrows(() => parseArguments([]), M1ProofError, "M1_OUT_REQUIRED");
  assertThrows(
    () => parseArguments(["--out", "ev", "--force"]),
    M1ProofError,
    "M1_ARGUMENT_UNKNOWN",
  );
});

// ---- review round 1: operator step line, container id, first start, scrub -----

Deno.test("the line forceApprovalExpiry really writes becomes operator step 3, JSON form still parses", () => {
  assertEquals(parseOperatorStepLine(OPERATOR_LINE), {
    name: "force-approval-expiry",
    command: `${EXPIRY_SQL} /* $1 = ${APPROVAL_ID} */`,
    exitCode: 0,
  });
  // A changed-row count other than one is a failed step, never a silent pass.
  assertEquals(
    parseOperatorStepLine(
      `2026-10-30T10:00:00.000Z forceApprovalExpiry approvalId=${APPROVAL_ID} rowCount=0 sql=${EXPIRY_SQL}`,
    )?.exitCode,
    1,
  );
  // Failure lines and read-only helper lines are not operator steps.
  for (
    const other of [
      `2026-10-30T10:00:00.000Z forceApprovalExpiry FAILED approvalId=${APPROVAL_ID} M1_APPROVAL_EXPIRY_ROW_COUNT:0`,
      "2026-10-30T10:00:00.000Z storedStatus questionId=q-1 status=expired (read only)",
      "2026-10-30T10:00:00.000Z restartServer stop ok",
    ]
  ) assertEquals(parseOperatorStepLine(other), undefined);
  assertEquals(
    parseOperatorStepLine(
      '2026-10-30T10:00:00.000Z fault {"m1":"operator-step","name":"x","sql":"s","rowCount":1}',
    ),
    { name: "x", command: "s", exitCode: 0 },
  );
});

Deno.test("operator step 3 reaches the manifest from the helper's real fault-log line", async () => {
  const host = new FakeHost();
  const manifest = await runProof(host);
  assertEquals(
    manifest.operatorSteps.map((step) => step.name),
    ["pricing-snapshot", "force-approval-expiry"],
  );
  assertStringIncludes(
    host.fs.text(`${OUT}/journey/fault-log.txt`),
    "forceApprovalExpiry approvalId=",
  );
});

Deno.test("the port checks resolve the server container fresh after a restart recreates it", async () => {
  const host = new FakeHost();
  const manifest = await runProof(host);
  const journey = callIndex(host, "--project=desktop-real-m1");
  const after = host.calls.slice(journey);
  const ports = after.filter((call) => call.args[0] === "port");
  assert(ports.length >= 2, "checked after the journey and in finalize");
  for (const call of ports) {
    assertEquals(call.args[1], RECREATED_SERVER_CONTAINER);
  }
  const lookups = after.filter((call) =>
    call.args[0] === "compose" && call.args.includes("ps")
  );
  assertEquals(lookups.length, ports.length);
  assertEquals(manifest.ids.serverDockerPort, "8000/tcp -> 127.0.0.1:34003");
  assertEquals(
    host.calls.find((call) => call.args[0] === "port")?.args[1],
    SERVER_CONTAINER,
  );
});

Deno.test("a failed first start is torn down with the first-start environment", async () => {
  const host = new FakeHost();
  host.fail = (call) =>
    call.args[0] === "scripts/dev/compose-up.sh" ? 1 : undefined;
  const failure = await expectFailure(host, "M1_STEP_FAILED");
  assertEquals(failure.failedStep, "compose-up");
  assertEquals(failure.cleanup, "passed", "compose-down needs the secret");
  const up = host.calls.find((call) =>
    call.args[0] === "scripts/dev/compose-up.sh"
  )!;
  const down = host.calls.find((call) =>
    call.args[0] === "scripts/dev/compose-down.sh"
  );
  assert(down !== undefined);
  for (const key of M1_FIRST_START_ENV_KEYS) {
    assertEquals(down.env[key], up.env[key], key);
  }
  assert(!host.fs.files.has(`${STATE}/stack.env`));
  assertEquals(host.downAttempted && host.composeDownDone, true);
});

Deno.test("unresolvable ports after the first start still tear the stack down", async () => {
  const host = new FakeHost();
  host.stdout = (call) =>
    call.args[0] === "scripts/dev/compose-up.sh"
      ? "no ports here\n"
      : undefined;
  const failure = await expectFailure(host, "M1_PORT_UNRESOLVED");
  assertEquals(failure.cleanup, "passed");
  assert(host.composeDownDone);
});

Deno.test("a failed journey still learns, redacts and lists the enrollment token", async () => {
  const host = new FakeHost();
  host.journeyCode = 1;
  const failure = await expectFailure(host, "M1_STEP_FAILED");
  const journey = failure.commands.find((command) =>
    command.command.includes("--project=desktop-real-m1")
  )!;
  assert(
    !host.fs.text(`${OUT}/${journey.outputPath}`).includes(ENROLLMENT_TOKEN),
  );
  assert(
    !host.fs.text(`${OUT}/journey/console.ndjson`).includes(ENROLLMENT_TOKEN),
  );
  assert(
    host.fs.text(`${STATE}/secrets-to-scan.txt`).split("\n").includes(
      ENROLLMENT_TOKEN,
    ),
  );
  assert(!JSON.stringify(failure).includes(ENROLLMENT_TOKEN));
});

Deno.test("text evidence is scrubbed whatever its extension", async () => {
  const host = new FakeHost();
  const manifest = await runProof(host);
  const console = host.fs.text(`${OUT}/journey/console.ndjson`);
  assert(!console.includes(ENROLLMENT_TOKEN));
  assertStringIncludes(console, "[REDACTED]");
  assertEquals(manifest.evidenceScan.textFilesScanned > 5, true);
});

Deno.test("binary evidence is searched for secrets and listed as not text-scanned", async () => {
  const host = new FakeHost();
  host.trace = () => "PK\u0003\u0004\u0000compressed-trace";
  const manifest = await runProof(host);
  assertEquals(
    manifest.evidenceScan.notTextScanned.sort((a, b) =>
      a.path.localeCompare(b.path)
    ),
    [
      { path: "journey/shot.png", kind: "media", reason: "binary" },
      { path: "journey/trace.zip", kind: "trace", reason: "binary" },
    ],
  );
  assertEquals(manifest.evidenceScan.binaryFilesSearched, 2);
  assertStringIncludes(manifest.evidenceScan.note, "not text-scrubbed");
  // They are still hashed.
  assert(manifest.files.some((file) => file.path === "journey/trace.zip"));
});

Deno.test("a binary capture that holds a secret fails the proof", async () => {
  const host = new FakeHost();
  host.trace = (call) =>
    `PK\u0003\u0004\u0000${call.env.BAKERY_REAL_PASSWORD}\u0000`;
  const failure = await expectFailure(host, "M1_SECRET_IN_BINARY_EVIDENCE");
  assertEquals(failure.failedStep, "scrub-evidence");
  assertEquals(failure.cleanup, "passed");
  assertStringIncludes(failure.error, "journey/trace.zip");
  assert(!failure.error.includes("M1-Proof-"), "the secret is never named");
});

Deno.test("an unreadable evidence file yields a failure record, not an escaped exception", async () => {
  const host = new FakeHost();
  // Only the scrub reads this file.
  host.fail = (call) => {
    if (call.args.includes("--project=desktop-real-harness")) {
      host.fs.failReads.add(`${OUT}/journey/console.ndjson`);
    }
    return undefined;
  };
  const failure = await expectFailure(host, "M1_EVIDENCE_SCRUB_FAILED");
  assertEquals(failure.failedStep, "scrub-evidence");
  assertEquals(failure.cleanup, "passed");
  assert(composeDownCalled(host));
  assertEquals(failure.files, []);
});

Deno.test("every adapter guard is recorded with its step before the manifest claims it", async () => {
  const host = new FakeHost();
  const manifest = await runProof(host);
  const record = JSON.parse(host.fs.text(`${OUT}/adapter-guards.json`));
  assertEquals(record.scriptedCoordinator, false);
  assertEquals(record.scriptedHarness, false);
  assertEquals(
    record.guards.map((guard: { name: string }) => guard.name),
    ["server-env", "worker-file", "worker-journey", "worker-regression"],
  );
  for (const guard of record.guards) assertEquals(guard.passed, true);
  for (
    const guard of record.guards.slice(0, 1).concat(record.guards.slice(2))
  ) {
    assert(
      manifest.commands.some((command) =>
        command.outputPath.includes(guard.step)
      ),
      `${guard.step} must be a recorded command`,
    );
  }
  assertEquals(manifest.adapters, {
    scriptedCoordinator: false,
    scriptedHarness: false,
  });
});

// ---- review round 2: complete scrub, oversize files, timeouts, pins ------------

Deno.test("a failed journey plus a binary secret reports both and still scrubs every file", async () => {
  const host = new FakeHost();
  host.journeyCode = 1;
  host.trace = (call) =>
    `PK\u0003\u0004\u0000${call.env.BAKERY_REAL_PASSWORD}\u0000`;
  const failure = await expectFailure(host, "M1_STEP_FAILED");
  assertEquals(failure.failedStep, "playwright-journey");
  assertEquals(
    failure.errors.map((entry) => entry.code),
    ["M1_STEP_FAILED", "M1_SECRET_IN_BINARY_EVIDENCE"],
  );
  assertEquals(failure.errors[1].step, "scrub-evidence");
  assertStringIncludes(failure.errors[1].error, "journey/trace.zip");
  // The scan finished: counts are set and the hit is listed.
  assertEquals(failure.evidenceScan.secretHits, ["journey/trace.zip"]);
  assert(failure.evidenceScan.textFilesScanned > 5);
  assert(failure.evidenceScan.binaryFilesSearched >= 2);
  // A file sorted after the hit was still scrubbed.
  const report = host.fs.text(`${OUT}/playwright/journey/report.txt`);
  assert(!report.includes(ENROLLMENT_TOKEN));
  assert(!report.includes("M1-Proof-"));
  assertStringIncludes(report, "[REDACTED]");
  assert(
    !host.fs.text(`${OUT}/journey/console.ndjson`).includes(ENROLLMENT_TOKEN),
  );
});

Deno.test("every binary hit is listed, not just the first", async () => {
  const host = new FakeHost();
  host.trace = (call) =>
    `PK\u0003\u0004\u0000${call.env.BAKERY_REAL_PASSWORD}\u0000`;
  host.extraEvidence["playwright/journey/video.webm"] =
    `\u001aE\u0000${ENROLLMENT_TOKEN}`;
  const failure = await expectFailure(host, "M1_SECRET_IN_BINARY_EVIDENCE");
  assertEquals(failure.evidenceScan.secretHits, [
    "journey/trace.zip",
    "playwright/journey/video.webm",
  ]);
  assertEquals(failure.errors.length, 1);
  assertStringIncludes(
    failure.errors[0].error,
    "playwright/journey/video.webm",
  );
});

Deno.test("files over the scan limit are listed as oversize and the note says they are skipped", async () => {
  const host = new FakeHost();
  host.maxScanBytes = 5_000;
  host.extraEvidence["journey/big.log"] = "x".repeat(6_000);
  host.extraEvidence["journey/video.webm"] = "\u001aE\u0000" +
    "v".repeat(6_000);
  const manifest = await runProof(host);
  const sorted = [...manifest.evidenceScan.notTextScanned].sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  assertEquals(
    sorted.filter((entry) => entry.reason === "oversize"),
    [
      { path: "journey/big.log", kind: "text", reason: "oversize" },
      { path: "journey/video.webm", kind: "media", reason: "oversize" },
    ],
  );
  assert(
    sorted.some((entry) =>
      entry.path === "journey/shot.png" && entry.reason === "binary"
    ),
  );
  assertStringIncludes(
    manifest.evidenceScan.note,
    "neither scrubbed nor searched",
  );
  assertStringIncludes(manifest.evidenceScan.note, "oversize");
  // Oversize files are still hashed.
  assert(manifest.files.some((file) => file.path === "journey/big.log"));
});

Deno.test("each leg runs under its own named timeout", async () => {
  assertEquals(M1_JOURNEY_TIMEOUT_MS, 300 * 60 * 1_000);
  assertEquals(M1_REGRESSION_TIMEOUT_MS, 20 * 60 * 1_000);
  const host = new FakeHost();
  await runProof(host);
  const journey = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-m1")
  );
  const regression = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-harness")
  );
  assertEquals(journey?.timeoutMs, M1_JOURNEY_TIMEOUT_MS);
  assertEquals(regression?.timeoutMs, M1_REGRESSION_TIMEOUT_MS);
});

Deno.test("the journey timeout constant is documented against the spec's phase budgets", async () => {
  const source = await Deno.readTextFile(
    new URL("../../scripts/evidence/prove-m1.ts", import.meta.url),
  );
  const at = source.indexOf("export const M1_JOURNEY_TIMEOUT_MS");
  assert(at > 0);
  const comment = source.slice(Math.max(0, at - 900), at);
  assertStringIncludes(comment, "at least the sum");
  assertStringIncludes(comment, "per-phase");
});

Deno.test("the fault-log line and the header contract stay tied to their sources", async () => {
  // The helper's lane pins the line it writes; this pins the template here.
  const helper = await Deno.readTextFile(
    new URL(
      "../../apps/web/tests/helpers/m1-stack-control.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(
    helper,
    "`${new Date().toISOString()} ${context.operation} ${detail}\\n`",
  );
  assertStringIncludes(
    helper,
    "`approvalId=${approvalId} rowCount=${result.rowCount} sql=${result.sql}`",
  );
  assertEquals(
    OPERATOR_LINE.slice(OPERATOR_LINE.indexOf(" ") + 1),
    `forceApprovalExpiry approvalId=${APPROVAL_ID} rowCount=1 sql=${EXPIRY_SQL}`,
  );

  const source = await Deno.readTextFile(
    new URL("../../scripts/evidence/prove-m1.ts", import.meta.url),
  );
  const header = source.slice(0, source.indexOf("*/"));
  for (const name of Object.values(M1_STATE_FILES)) {
    assertStringIncludes(header, name, `the header omits ${name}`);
  }
  const host = new FakeHost();
  await runProof(host);
  const journey = host.calls.find((call) =>
    call.args.includes("--project=desktop-real-m1")
  )!;
  for (const key of Object.keys(journey.env)) {
    if (key.startsWith("BAKERY_M1_") || key.startsWith("BAKERY_REAL_")) {
      assertStringIncludes(header, key, `the header omits ${key}`);
    }
  }
  for (
    const shape of ["forceApprovalExpiry approvalId=", '{"m1":"operator-step"']
  ) {
    assertStringIncludes(header, shape);
  }
});
