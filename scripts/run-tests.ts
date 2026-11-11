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
const permissions = lane === "native" ? ["--allow-all"] : [
  "--allow-read",
  "--allow-env",
  ...(lane === "unit"
    ? [
      "--allow-write",
      "--allow-run=zip,unzip,node,/usr/bin/git,/usr/bin/stat,/usr/bin/prlimit,/usr/bin/setsid,/usr/bin/kill",
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
    : lane === "integration" || lane === "security"
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
const process = new Deno.Command(Deno.execPath(), {
  args: ["test", ...permissions, ...parallel, ...paths],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
Deno.exit((await process.status).code);
