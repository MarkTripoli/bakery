import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  ISOLATED_HOME_LANES,
  isolatedLaneEnvironment,
  laneEnvPaths,
  MINIMAL_GIT_CONFIG,
} from "../../scripts/ci/lane-environment.ts";

// #246, defense in depth for the owner-account rule (#207): the security,
// integration and e2e lanes run with an empty HOME, no CODEX_HOME and no
// BAKERY_CODEX_AUTH_SOURCE_DIR, so no test can reach the operator's real
// credentials by any path, including ones a source scan cannot see.

const operator = {
  HOME: "/home/operator",
  PATH: "/usr/bin:/bin",
  CODEX_HOME: "/home/operator/.codex",
  BAKERY_CODEX_AUTH_SOURCE_DIR: "/home/operator/.codex",
  BAKERY_TEST_CODEX_AUTH_DIR: "/tmp/dedicated-test-login",
  XDG_CONFIG_HOME: "/home/operator/.config",
  XDG_CACHE_HOME: "/home/operator/.cache",
  GIT_CONFIG_GLOBAL: "/home/operator/.gitconfig",
  DATABASE_URL: "postgres://x",
  TMPDIR: "/tmp/lane",
};
const pinned = { DENO_DIR: "/home/operator/.cache/deno" };
const root = "/tmp/bakery-lane-abc123";

Deno.test("exactly the security, integration and e2e lanes are isolated", () => {
  assertEquals([...ISOLATED_HOME_LANES].sort(), [
    "e2e",
    "integration",
    "security",
  ]);
  for (
    const lane of [
      "unit",
      "rails",
      "provider",
      "contract",
      "recovery",
      "connected",
      "native",
      "r2",
    ]
  ) {
    assertEquals(
      isolatedLaneEnvironment({ lane, environment: operator, root, pinned }),
      null,
      lane,
    );
  }
});

Deno.test("an isolated lane gets an empty HOME and no path back to the operator's login", () => {
  for (const lane of ISOLATED_HOME_LANES) {
    const env = isolatedLaneEnvironment({
      lane,
      environment: operator,
      root,
      pinned,
    });
    assert(env !== null, lane);
    const paths = laneEnvPaths(root);
    assertEquals(env.HOME, paths.home, lane);
    assert(env.HOME.startsWith(`${root}/`));
    assertEquals(Object.hasOwn(env, "CODEX_HOME"), false, lane);
    assertEquals(Object.hasOwn(env, "BAKERY_CODEX_AUTH_SOURCE_DIR"), false);
    for (
      const key of [
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "GIT_CONFIG_GLOBAL",
      ]
    ) {
      assert(env[key]?.startsWith(`${root}/`), `${lane} ${key}=${env[key]}`);
    }
    assertEquals(env.GIT_CONFIG_NOSYSTEM, "1");
    // Nothing of the operator's home survives in any value.
    for (const [key, value] of Object.entries(env)) {
      if (key === "DENO_DIR" || key === "PATH") continue;
      assert(!value.includes("/home/operator"), `${lane} ${key}=${value}`);
    }
  }
});

Deno.test("what the lanes still need is passed through or pinned, not isolated", () => {
  const env = isolatedLaneEnvironment({
    lane: "integration",
    environment: operator,
    root,
    pinned: { ...pinned, PLAYWRIGHT_BROWSERS_PATH: "/home/operator/.cache/ms" },
  });
  assert(env !== null);
  assertEquals(env.PATH, operator.PATH);
  assertEquals(env.DATABASE_URL, operator.DATABASE_URL);
  assertEquals(env.TMPDIR, operator.TMPDIR);
  // The explicit, dedicated opt-in of #207 is the operator's decision to make.
  assertEquals(
    env.BAKERY_TEST_CODEX_AUTH_DIR,
    operator.BAKERY_TEST_CODEX_AUTH_DIR,
  );
  // The module cache and the browser cache keep working from where they are.
  assertEquals(env.DENO_DIR, pinned.DENO_DIR);
  assertEquals(env.PLAYWRIGHT_BROWSERS_PATH, "/home/operator/.cache/ms");
});

Deno.test("the minimal git config names a committer and nothing else of the operator", () => {
  assert(MINIMAL_GIT_CONFIG.includes("[user]"));
  assert(MINIMAL_GIT_CONFIG.includes("name = "));
  assert(MINIMAL_GIT_CONFIG.includes("email = "));
  assert(!MINIMAL_GIT_CONFIG.includes("credential"));
  assert(!MINIMAL_GIT_CONFIG.includes("signingkey"));
});

const run = (
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${stderr}`));
      else resolve(String(stdout).trim());
    });
  });

Deno.test("a child process in the isolated environment cannot see a sentinel home, its .codex login or its git identity", async () => {
  const sentinel = await mkdtemp(join(tmpdir(), "bakery-sentinel-home-"));
  const laneRoot = await mkdtemp(join(tmpdir(), "bakery-lane-"));
  try {
    await mkdir(join(sentinel, ".codex"));
    await writeFile(join(sentinel, ".codex", "auth.json"), '{"secret":1}');
    await writeFile(
      join(sentinel, ".gitconfig"),
      "[user]\n\tname = The Operator\n\temail = operator@example.test\n",
    );
    const paths = laneEnvPaths(laneRoot);
    for (const dir of paths.directories) await mkdir(dir, { recursive: true });
    await writeFile(paths.gitconfig, MINIMAL_GIT_CONFIG);
    const base = {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: sentinel,
      CODEX_HOME: join(sentinel, ".codex"),
      BAKERY_CODEX_AUTH_SOURCE_DIR: join(sentinel, ".codex"),
    };
    const isolated = isolatedLaneEnvironment({
      lane: "security",
      environment: base,
      root: laneRoot,
      pinned: {},
    });
    assert(isolated !== null);
    const probe =
      "const os=require('os'),fs=require('fs'),path=require('path');" +
      "console.log(JSON.stringify({home:os.homedir(),codex:fs.existsSync(path.join(os.homedir(),'.codex')),envCodex:process.env.CODEX_HOME??null,envSource:process.env.BAKERY_CODEX_AUTH_SOURCE_DIR??null}))";

    // Control: the operator's own environment does reach the sentinel.
    const open = JSON.parse(await run("node", ["-e", probe], base));
    assertEquals(open.home, sentinel);
    assertEquals(open.codex, true);

    const closed = JSON.parse(await run("node", ["-e", probe], isolated));
    assertEquals(closed.home, paths.home);
    assertNotEquals(closed.home, sentinel);
    assertEquals(closed.codex, false);
    assertEquals(closed.envCodex, null);
    assertEquals(closed.envSource, null);

    const name = (env: Record<string, string>) =>
      run("git", ["config", "--global", "user.name"], env);
    assertEquals(await name(base), "The Operator");
    assertEquals(await name(isolated), "Bakery Test");
  } finally {
    await rm(sentinel, { recursive: true, force: true });
    await rm(laneRoot, { recursive: true, force: true });
  }
});
