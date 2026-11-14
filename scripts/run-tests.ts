import {
  type DockerRun,
  parseLaneStacks,
  sweepLaneStacks,
} from "./ci/lane-stacks.ts";
import {
  ISOLATED_HOME_LANES,
  isolatedLaneEnvironment,
  laneEnvPaths,
  pinnedCaches,
} from "./ci/lane-environment.ts";

const lane = Deno.args[0];
const knownLanes = new Set([
  "rails",
  "unit",
  "provider",
  "contract",
  "integration",
  "recovery",
  "security",
  "e2e",
  "connected",
  "native",
  "r2",
]);
if (!lane || !knownLanes.has(lane)) {
  console.error(
    "Expected one of: rails, unit, provider, contract, integration, recovery, security",
  );
  Deno.exit(2);
}

const requested = Deno.args.slice(1).filter((argument) => argument !== "--");
const root = lane === "e2e" || lane === "connected" || lane === "native"
  ? `tests/${lane}`
  : lane === "rails"
  ? "tests/rails"
  : `tests/${lane}`;
const paths = requested.length > 0 ? requested : [root];
const temporaryDirectory = Deno.env.get("TMPDIR") ??
  Deno.env.get("TMP") ??
  Deno.env.get("TEMP") ??
  "/tmp";
const validPath = (path: string): boolean =>
  (path === root || path.startsWith(`${root}/`)) &&
  !path.split("/").includes("..") &&
  /^[A-Za-z0-9._/-]+$/.test(path);
if (paths.some((path) => !validPath(path))) {
  console.error("Test paths must stay within the selected lane");
  Deno.exit(2);
}
if (lane === "connected" || lane === "native" || lane === "r2") {
  const preflight = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "scripts/ci/preflight.ts",
      lane,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const result = await preflight.status;
  if (!result.success) Deno.exit(result.code);
}
function serverLauncher(name: string): string {
  return new URL(`../infra/server-exec/${name}`, import.meta.url).pathname;
}
const permissions = lane === "native" ? ["--allow-all"] : [
  "--allow-read",
  "--allow-env",
  ...(lane === "unit"
    ? [
      "--allow-write",
      // The server's fixed launchers (infra/server-exec) are how its git and
      // systemd calls run; the unit tests exercise them through the real
      // spawn path, so the lane names them exactly.
      `--allow-run=zip,unzip,node,git,/usr/bin/git,/usr/bin/stat,/usr/bin/prlimit,/usr/bin/setsid,/usr/bin/kill,${
        serverLauncher("git.sh")
      },${serverLauncher("draft-systemd.sh")}`,
    ]
    : []),
  // Provider conformance runs fixtures only: no bare --allow-run and no
  // --allow-net, so a stray host binary or network call fails the lane.
  ...(lane === "provider"
    ? [
      `--allow-write=${temporaryDirectory}`,
      "--allow-run=git,/usr/bin/git,/usr/bin/setsid,/usr/bin/kill",
      "--allow-sys=uid",
    ]
    : []),
  // Owner opt-in only (BAKERY_PROVIDER_REAL_CLI): a real harness CLI needs to
  // be spawned and to reach its model provider. CI never sets the variable.
  ...(lane === "provider" &&
      (Deno.env.get("BAKERY_PROVIDER_REAL_CLI") ?? "").trim().length > 0
    ? ["--allow-run", "--allow-net"]
    : []),
  ...(lane === "contract"
    ? [
      `--allow-write=${temporaryDirectory}`,
      `--allow-run=${Deno.execPath()},bash`,
    ]
    : []),
  ...(lane === "recovery" ? ["--allow-write"] : lane === "e2e"
    // The e2e lane writes per-conversation scripts for the scripted coordinator.
    ? [
      `--allow-write=${temporaryDirectory},tests/fixtures/scripted-coordinator`,
    ]
    : lane === "integration" || lane === "security" || lane === "rails"
    ? [`--allow-write=${temporaryDirectory}`]
    : []),
  ...(lane === "contract" ? ["--allow-sys=statfs"] : []),
  ...(lane === "e2e" || lane === "connected" ? ["--allow-sys=statfs"] : []),
  ...(lane === "unit" || lane === "integration" || lane === "security"
    ? ["--allow-sys=uid,statfs,osRelease"]
    : lane === "rails" || lane === "recovery"
    ? ["--allow-sys=uid,statfs"]
    : lane === "r2"
    ? ["--allow-sys=uid,osRelease"]
    : []),
  ...(lane === "rails" || lane === "integration" || lane === "recovery" ||
      lane === "security" || lane === "e2e" || lane === "connected"
    ? ["--allow-run"]
    : []),
  ...(lane === "contract" || lane === "integration" || lane === "recovery" ||
      lane === "security" || lane === "e2e" || lane === "connected" ||
      lane === "r2"
    ? ["--allow-net"]
    : []),
];
// Focused unit tests are pure and file-independent, so the lane runs them
// across workers: the same 1049 assertions, ~2.4x faster, which the pull
// request gate needs. Lanes that share a database (contract), own a resource
// (rails, e2e) or drive a real stack stay sequential.
const parallel = lane === "unit" ? ["--parallel"] : [];

// Test temp dirs (#242). On the rig host /tmp is RAM-backed, and suites that
// leaked `bakery-*` dirs filled it. Every lane preloads a wrapper that removes
// what the test process made through Deno's temp calls when it exits, pass or
// fail. The unit lane also gets a temp root of its own (short, so path-length
// sensitive tests behave as they do under /tmp): whatever is still in it
// afterwards was left by a killed worker or a call the wrapper cannot see, and
// is reported and removed. BAKERY_TEST_TMP_STRICT=1 turns a non-empty root into
// a failed run, which is how the temp hygiene rail checks the lane.
const rootTool = async (...args: string[]) => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      `--allow-write=${temporaryDirectory}`,
      "scripts/ci/test-temp-root.ts",
      ...args,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return {
    code: output.code,
    text: new TextDecoder().decode(output.stdout).trim(),
  };
};
const dockerRun: DockerRun = async (args) => {
  try {
    const output = await new Deno.Command("docker", {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(180_000),
    }).output();
    return {
      code: output.code,
      text: new TextDecoder().decode(output.stdout),
    };
  } catch {
    return { code: 127, text: "" };
  }
};
async function removeLaneStacks(registry: string): Promise<void> {
  let names: string[];
  try {
    names = parseLaneStacks(await Deno.readTextFile(registry));
  } catch {
    return; // No fixture registered a stack.
  }
  if (names.length === 0) return;
  const swept = await sweepLaneStacks(names, dockerRun);
  if (swept.removed.length > 0) {
    console.error(
      `lane stacks: ${swept.removed.length} compose project(s) were still up after the run and were removed: ${
        swept.removed.join(", ")
      }`,
    );
  }
  if (swept.failed.length > 0) {
    console.error(
      `lane stacks: could not remove: ${swept.failed.join(", ")}`,
    );
  }
}
// A terminated run still sweeps its root (#246). The listeners go in before any
// root exists, remember which signal came and pass it on to the test process
// once there is one; a signal that comes before the test process starts means
// it never starts. Either way the run reaches the sweep below.
let received: "SIGINT" | "SIGTERM" | undefined;
let testProcess: Deno.ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    received ??= signal;
    try {
      testProcess?.kill(signal);
    } catch {
      // Already gone.
    }
  });
}
let laneRoot: string | undefined;
if (lane === "unit") {
  const created = await rootTool("create", temporaryDirectory);
  if (created.code === 0 && created.text.length > 0) laneRoot = created.text;
  else {console.error(
      "test temp root: could not create one; using the system temp dir",
    );}
}

// The lanes that run a real stack start with an empty HOME and no path to the
// operator's Codex login (#246). The module and browser caches are pinned where
// they are so the lane does not download them again; see
// scripts/ci/lane-environment.ts.
let isolatedRoot: string | undefined;
let isolatedEnv: Record<string, string> | undefined;
if (ISOLATED_HOME_LANES.includes(lane)) {
  const created = await rootTool("create", temporaryDirectory);
  if (created.code !== 0 || created.text.length === 0) {
    console.error(
      "lane HOME: could not create an isolated root; refusing to run",
    );
    Deno.exit(3);
  }
  isolatedRoot = created.text;
  const made = await rootTool("skeleton", temporaryDirectory, isolatedRoot);
  if (made.code !== 0) {
    // The root exists but is not a home: it goes, and nothing runs in it.
    await rootTool("sweep", temporaryDirectory, isolatedRoot);
    console.error(
      "lane HOME: could not prepare the isolated home; refusing to run",
    );
    Deno.exit(3);
  }
  const operator = Deno.env.toObject();
  const askDeno = (operator.DENO_DIR ?? "").length === 0;
  const pinned = pinnedCaches({
    environment: operator,
    denoInfoDir: askDeno
      ? JSON.parse(
        new TextDecoder().decode(
          (await new Deno.Command(Deno.execPath(), {
            args: ["info", "--json"],
            stdin: "null",
            stdout: "piped",
            stderr: "null",
          }).output()).stdout,
        ),
      ).denoDir
      : undefined,
  });
  isolatedEnv = isolatedLaneEnvironment({
    lane,
    environment: operator,
    root: isolatedRoot,
    pinned,
  }) ?? undefined;
}

// #229: the lane's --allow-run is resolved against the PATH this process
// started with, and a bare `git` against the PATH of the moment it is spawned.
// A refused spawn reports both, so the test process is told what they were.
const allowRunFlag = permissions.find((flag) =>
  flag === "--allow-run" || flag.startsWith("--allow-run=")
);
const laneAllowRun = allowRunFlag === undefined
  ? "(none)"
  : allowRunFlag === "--allow-run"
  ? "(all)"
  : allowRunFlag.slice("--allow-run=".length);

const command = new Deno.Command(Deno.execPath(), {
  args: [
    "test",
    "--preload",
    "tests/helpers/temp-cleanup-preload.ts",
    ...permissions,
    ...parallel,
    ...paths,
  ],
  ...(isolatedEnv !== undefined
    // The isolated lanes (#246) run with exactly this environment, plus the
    // two diagnostics of #229 that tell the test process which PATH and
    // --allow-run it was started with.
    ? {
      clearEnv: true,
      env: {
        ...isolatedEnv,
        BAKERY_TEST_STARTUP_PATH: Deno.env.get("PATH") ?? "",
        BAKERY_TEST_ALLOW_RUN: laneAllowRun,
      },
    }
    : {
      env: {
        ...(laneRoot === undefined ? {} : { TMPDIR: laneRoot }),
        BAKERY_TEST_STARTUP_PATH: Deno.env.get("PATH") ?? "",
        BAKERY_TEST_ALLOW_RUN: laneAllowRun,
      },
    }),
  stdout: "inherit",
  stderr: "inherit",
});
let code: number;
if (received !== undefined) {
  // Terminated before the tests started: they do not, and the roots go.
  code = received === "SIGINT" ? 130 : 143;
} else {
  testProcess = command.spawn();
  // A signal between the check above and the process existing.
  if (received !== undefined) testProcess.kill(received);
  code = (await testProcess.status).code;
}
if (isolatedRoot !== undefined) {
  // The compose stacks the lane's fixtures registered and left up (#246): a test
  // process that was killed cannot tear its own down, so the runner does, by name.
  await removeLaneStacks(laneEnvPaths(isolatedRoot).stacks);
  const swept = await rootTool("sweep", temporaryDirectory, isolatedRoot);
  try {
    const { homeEntries, homeNames } = JSON.parse(swept.text) as {
      homeEntries?: number;
      homeNames?: string[];
    };
    // What a lane writes into its isolated HOME is what depended on a real one.
    if (homeEntries !== undefined && homeEntries > 0) {
      const names = (homeNames ?? []).join(", ");
      console.error(
        `lane HOME: ${homeEntries} entries were written to the isolated home${
          names.length > 0
            ? `: ${names}${
              homeEntries > (homeNames ?? []).length ? ", ..." : ""
            }`
            : ""
        }`,
      );
    }
  } catch {
    console.error("lane HOME: the sweep did not report; the root may remain");
  }
}
if (laneRoot !== undefined) {
  const swept = await rootTool("sweep", temporaryDirectory, laneRoot);
  try {
    const { leaked, prefixes } = JSON.parse(swept.text) as {
      leaked: number;
      prefixes: Record<string, number>;
    };
    if (leaked > 0) {
      console.error(
        `test temp root: ${leaked} entries were still there after the run and were removed; by prefix ${
          JSON.stringify(prefixes)
        }`,
      );
      if (Deno.env.get("BAKERY_TEST_TMP_STRICT") === "1" && code === 0) {
        code = 3;
      }
    }
  } catch {
    console.error(
      "test temp root: the sweep did not report; the root may remain",
    );
  }
}
Deno.exit(code);
