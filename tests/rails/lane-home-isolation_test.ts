import { assert, assertEquals } from "@std/assert";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #246: the security, integration and e2e lanes start with an empty HOME and no
// path to the operator's Codex login. This runs the real lane runner over each
// lane's one-case probe with a sentinel operator environment (a HOME holding a
// .codex login, CODEX_HOME and BAKERY_CODEX_AUTH_SOURCE_DIR pointing at it) and
// fails if the lane process can see any of it.

async function moduleCache(): Promise<string> {
  const fromEnv = Deno.env.get("DENO_DIR");
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const info = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(info.stdout)).denoDir;
}

async function runLane(lane: string, env: Record<string, string>) {
  const run = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      "scripts/run-tests.ts",
      lane,
      `tests/${lane}/lane-home-is-isolated_test.ts`,
    ],
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: run.code,
    text: new TextDecoder().decode(run.stdout) +
      new TextDecoder().decode(run.stderr),
  };
}

for (const lane of ["security", "integration", "e2e"]) {
  Deno.test(`the ${lane} lane starts with an isolated HOME, whatever the operator's environment holds`, async () => {
    const sentinel = await mkdtemp(join(tmpdir(), "bakery-sentinel-"));
    const tmp = await mkdtemp(join(tmpdir(), "bkl-"));
    try {
      await mkdir(join(sentinel, ".codex"));
      await writeFile(join(sentinel, ".codex", "auth.json"), '{"secret":1}');
      const run = await runLane(lane, {
        PATH: Deno.env.get("PATH") ?? "",
        // The real module cache: the operator's HOME is not the lane's.
        DENO_DIR: await moduleCache(),
        HOME: sentinel,
        CODEX_HOME: join(sentinel, ".codex"),
        BAKERY_CODEX_AUTH_SOURCE_DIR: join(sentinel, ".codex"),
        BAKERY_LANE_HOME_SENTINEL: sentinel,
        TMPDIR: tmp,
      });
      assertEquals(
        run.code,
        0,
        `the ${lane} probe failed:\n${run.text.slice(-1500)}`,
      );
      assert(
        !run.text.includes("entries were written to the isolated home"),
        "the probe writes nothing into the lane HOME",
      );
    } finally {
      await rm(sentinel, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

Deno.test("the lane runner isolates exactly the lanes the module names", async () => {
  const source = await Deno.readTextFile("scripts/run-tests.ts");
  assert(source.includes("ISOLATED_HOME_LANES.includes(lane)"));
  assert(source.includes("clearEnv: true"));
  assert(source.includes("isolatedLaneEnvironment("));
});

// The runner's own behavior around the roots it makes: what it reports of a
// lane that wrote into its HOME, what it leaves behind when it is terminated,
// and when it refuses to run.

const FIXTURES = "tests/security/lane-runner-fixtures";

async function laneEnvironment(
  tmp: string,
  extra: Record<string, string>,
  options: { withModuleCache: boolean } = { withModuleCache: true },
) {
  return {
    PATH: Deno.env.get("PATH") ?? "",
    // Without DENO_DIR the runner asks `deno info` where the cache is, which
    // widens the window between the root existing and the test starting.
    ...(options.withModuleCache
      ? { DENO_DIR: await moduleCache() }
      : { HOME: Deno.env.get("HOME") ?? "" }),
    TMPDIR: tmp,
    ...extra,
  };
}

const laneRoots = async (tmp: string) =>
  (await readdir(tmp)).filter((name) => name.startsWith("bakery-lane-"));

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  intervalMs = 100,
) {
  for (let attempt = 0; attempt < 60_000 / intervalMs; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

Deno.test("a lane that writes into its HOME is told how many entries it wrote", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "bkl-"));
  try {
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-run",
        "scripts/run-tests.ts",
        "security",
        `${FIXTURES}/writes-home.fixture.ts`,
      ],
      env: await laneEnvironment(tmp, {}),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(run.stdout) +
      new TextDecoder().decode(run.stderr);
    assertEquals(run.code, 0, text.slice(-1500));
    // Exactly the two top-level entries the fixture made, never "0" or none.
    assert(
      text.includes("lane HOME: 2 entries were written to the isolated home"),
      text.slice(-1500),
    );
    assertEquals(await laneRoots(tmp), [], "the root is swept after the run");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

for (const when of ["mid-run", "as soon as the root exists"] as const) {
  Deno.test(`a runner terminated ${when} sweeps its lane root`, async () => {
    const tmp = await mkdtemp(join(tmpdir(), "bkl-"));
    const marker = join(tmp, "marker");
    try {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "--allow-run",
          "scripts/run-tests.ts",
          "security",
          `${FIXTURES}/sleeps.fixture.ts`,
        ],
        env: await laneEnvironment(
          tmp,
          { BAKERY_LANE_RUNNER_MARKER: marker },
          { withModuleCache: when === "mid-run" },
        ),
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      if (when === "mid-run") {
        await waitFor(
          async () => await Deno.stat(marker).then(() => true, () => false),
          "the fixture to be running",
        );
      } else {
        await waitFor(
          async () => (await laneRoots(tmp)).length > 0,
          "the lane root to exist",
          5,
        );
      }
      child.kill("SIGTERM");
      const status = await child.status;
      assert(status.code !== 0, "a terminated run is not a pass");
      assertEquals(
        await laneRoots(tmp),
        [],
        `no lane root is left after a SIGTERM ${when}`,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

Deno.test("the runner refuses to run when it cannot make an isolated root", async () => {
  const run = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      "scripts/run-tests.ts",
      "security",
      `${FIXTURES}/writes-home.fixture.ts`,
    ],
    env: await laneEnvironment("/nonexistent/bakery-tmp", {}),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(run.code, 3);
  assert(
    new TextDecoder().decode(run.stderr).includes(
      "could not create an isolated root; refusing to run",
    ),
  );
});

Deno.test("the root tool refuses to prepare or sweep anything that is not a lane root, and sweeps one that is", async () => {
  const base = await mkdtemp(join(tmpdir(), "bkl-"));
  const tool = (...args: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        `--allow-write=${base}`,
        "scripts/ci/test-temp-root.ts",
        ...args,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  try {
    const stranger = join(base, "not-a-lane-root");
    await mkdir(stranger);
    for (const command of ["skeleton", "sweep"]) {
      const refused = await tool(command, base, stranger);
      assertEquals(refused.code, 2, command);
      assert(
        new TextDecoder().decode(refused.stderr).includes(
          "is not a lane root",
        ),
        command,
      );
    }
    assertEquals((await tool("skeleton", base)).code, 2);
    assertEquals(
      (await readdir(stranger)).length,
      0,
      "nothing was made in a path that is not a lane root",
    );
    // A real root: skeleton makes the home, sweep reports and removes it.
    const created = await tool("create", base);
    const root = new TextDecoder().decode(created.stdout).trim();
    assertEquals((await tool("skeleton", base, root)).code, 0);
    assert((await readdir(join(root, "env"))).includes("gitconfig"));
    await writeFile(join(root, "env", "home", "dropped"), "x");
    const swept = await tool("sweep", base, root);
    assertEquals(
      JSON.parse(new TextDecoder().decode(swept.stdout)),
      { leaked: 0, prefixes: {}, homeEntries: 1 },
    );
    assertEquals(await laneRoots(base), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

Deno.test("the runner sweeps the root of a skeleton it could not make before it refuses", async () => {
  const source = await Deno.readTextFile("scripts/run-tests.ts");
  const refusal = source.indexOf("could not prepare the isolated home");
  assert(refusal > 0);
  // The sweep of that root comes first in the same branch.
  const branch = source.slice(
    source.lastIndexOf("if (made.code !== 0)", refusal),
  );
  assert(
    branch.indexOf('rootTool("sweep"') > 0 &&
      branch.indexOf('rootTool("sweep"') < branch.indexOf("Deno.exit(3)"),
  );
});
