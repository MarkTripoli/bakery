import {
  ISOLATED_HOME_LANES,
  isolatedLaneEnvironment,
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
    console.error(
      "lane HOME: could not prepare the isolated home; refusing to run",
    );
    Deno.exit(3);
  }
  const pinned: Record<string, string> = {};
  const denoDir = Deno.env.get("DENO_DIR") ?? JSON.parse(
    new TextDecoder().decode(
      (await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output()).stdout,
    ),
  ).denoDir;
  if (typeof denoDir === "string" && denoDir.length > 0) {
    pinned.DENO_DIR = denoDir;
  }
  const home = Deno.env.get("HOME");
  const browsers = Deno.env.get("PLAYWRIGHT_BROWSERS_PATH") ??
    (home === undefined ? undefined : `${home}/.cache/ms-playwright`);
  if (browsers !== undefined) pinned.PLAYWRIGHT_BROWSERS_PATH = browsers;
  isolatedEnv = isolatedLaneEnvironment({
    lane,
    environment: Deno.env.toObject(),
    root: isolatedRoot,
    pinned,
  }) ?? undefined;
}

const process = new Deno.Command(Deno.execPath(), {
  args: [
    "test",
    "--preload",
    "tests/helpers/temp-cleanup-preload.ts",
    ...permissions,
    ...parallel,
    ...paths,
  ],
  ...(isolatedEnv !== undefined
    ? { clearEnv: true, env: isolatedEnv }
    : laneRoot === undefined
    ? {}
    : { env: { TMPDIR: laneRoot } }),
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
// A terminated run still sweeps its root: pass the signal on and carry on.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    try {
      process.kill(signal);
    } catch {
      // Already gone.
    }
  });
}
let code = (await process.status).code;
if (isolatedRoot !== undefined) {
  const swept = await rootTool("sweep", temporaryDirectory, isolatedRoot);
  try {
    const { homeEntries } = JSON.parse(swept.text) as { homeEntries?: number };
    // What a lane writes into its isolated HOME is what depended on a real one.
    if (homeEntries !== undefined && homeEntries > 0) {
      console.error(
        `lane HOME: ${homeEntries} entries were written to the isolated home`,
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
