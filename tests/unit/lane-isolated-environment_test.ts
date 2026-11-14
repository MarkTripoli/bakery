import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  CARRIED_LANE_VARIABLES,
  carriedLaneVariables,
  ISOLATED_HOME_LANES,
  isolatedLaneEnvironment,
  LANE_STACK_REGISTRY_VARIABLE,
  laneEnvPaths,
  MINIMAL_GIT_CONFIG,
  pinnedCaches,
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

// The system git, not whatever `git` the PATH holds first: a version manager's
// shim reads its own config from the HOME the child is given, which the
// isolated lane deliberately empties.
const GIT = ["/usr/bin/git", "/bin/git"].find((path) => {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}) ?? "git";

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
      run(GIT, ["config", "--global", "user.name"], env);
    assertEquals(await name(base), "The Operator");
    assertEquals(await name(isolated), "Bakery Test");
  } finally {
    await rm(sentinel, { recursive: true, force: true });
    await rm(laneRoot, { recursive: true, force: true });
  }
});

/** What mise itself would use under `home`, with no XDG variable set. */
const miseUnder = (home: string) => ({
  MISE_DATA_DIR: `${home}/.local/share/mise`,
  MISE_CONFIG_DIR: `${home}/.config/mise`,
  MISE_CACHE_DIR: `${home}/.cache/mise`,
  MISE_STATE_DIR: `${home}/.local/state/mise`,
});

Deno.test("the module and browser caches are pinned from the variable, else from where they are", () => {
  // Both variables set: the operator's own, untouched.
  assertEquals(
    pinnedCaches({
      environment: {
        DENO_DIR: "/ops/deno",
        PLAYWRIGHT_BROWSERS_PATH: "/ops/browsers",
        HOME: "/home/operator",
      },
      denoInfoDir: "/from/deno/info",
    }),
    {
      DENO_DIR: "/ops/deno",
      PLAYWRIGHT_BROWSERS_PATH: "/ops/browsers",
      ...miseUnder("/home/operator"),
    },
  );
  // Neither set: what `deno info` says, and the default under the operator's HOME.
  assertEquals(
    pinnedCaches({
      environment: { HOME: "/home/operator" },
      denoInfoDir: "/from/deno/info",
    }),
    {
      DENO_DIR: "/from/deno/info",
      PLAYWRIGHT_BROWSERS_PATH: "/home/operator/.cache/ms-playwright",
      ...miseUnder("/home/operator"),
    },
  );
  // An empty variable is not set: it does not hide where the cache is.
  assertEquals(
    pinnedCaches({
      environment: {
        DENO_DIR: "",
        PLAYWRIGHT_BROWSERS_PATH: "",
        HOME: "/home/operator",
      },
      denoInfoDir: "/from/deno/info",
    }),
    {
      DENO_DIR: "/from/deno/info",
      PLAYWRIGHT_BROWSERS_PATH: "/home/operator/.cache/ms-playwright",
      ...miseUnder("/home/operator"),
    },
  );
  // A cache that cannot be found is left out; the lane then finds its own.
  assertEquals(
    pinnedCaches({ environment: {}, denoInfoDir: undefined }),
    {},
  );
  assertEquals(
    pinnedCaches({ environment: { HOME: "" }, denoInfoDir: "" }),
    {},
  );
  // Only the variable and `deno info` decide DENO_DIR; HOME alone does not.
  assertEquals(
    pinnedCaches({
      environment: { HOME: "/home/operator" },
      denoInfoDir: undefined,
    }),
    {
      PLAYWRIGHT_BROWSERS_PATH: "/home/operator/.cache/ms-playwright",
      ...miseUnder("/home/operator"),
    },
  );
});

// #246 follow-up: under an empty HOME a `docker` or `git` that is a mise shim
// cannot find mise's installed tools, configuration or trust record, looks
// them up on GitHub and is rate limited; `docker compose version` took 99 ms
// with the real HOME and 25 s or more with an empty HOME and XDG.
Deno.test("each mise directory is pinned from its variable, else from XDG, else from HOME, and never from the lane's home", () => {
  // The variables win, one by one, and the others fall back.
  assertEquals(
    pinnedCaches({
      environment: {
        HOME: "/home/operator",
        MISE_DATA_DIR: "/ops/mise-data",
        MISE_STATE_DIR: "/ops/mise-state",
      },
      denoInfoDir: undefined,
    }),
    {
      PLAYWRIGHT_BROWSERS_PATH: "/home/operator/.cache/ms-playwright",
      ...miseUnder("/home/operator"),
      MISE_DATA_DIR: "/ops/mise-data",
      MISE_STATE_DIR: "/ops/mise-state",
    },
  );
  // XDG decides where mise puts each directory when the variable is not set.
  assertEquals(
    pinnedCaches({
      environment: {
        HOME: "/home/operator",
        XDG_DATA_HOME: "/xdg/data",
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_CACHE_HOME: "/xdg/cache",
        XDG_STATE_HOME: "/xdg/state",
      },
      denoInfoDir: undefined,
    }),
    {
      PLAYWRIGHT_BROWSERS_PATH: "/home/operator/.cache/ms-playwright",
      MISE_DATA_DIR: "/xdg/data/mise",
      MISE_CONFIG_DIR: "/xdg/config/mise",
      MISE_CACHE_DIR: "/xdg/cache/mise",
      MISE_STATE_DIR: "/xdg/state/mise",
    },
  );
  // An empty variable is not set, and without a HOME or XDG there is nothing to pin.
  assertEquals(
    pinnedCaches({
      environment: { MISE_DATA_DIR: "", MISE_CONFIG_DIR: "" },
      denoInfoDir: undefined,
    }),
    {},
  );
  // XDG alone, with no HOME, still places that one directory.
  assertEquals(
    pinnedCaches({
      environment: { XDG_STATE_HOME: "/xdg/state" },
      denoInfoDir: undefined,
    }),
    { MISE_STATE_DIR: "/xdg/state/mise" },
  );
});

Deno.test("the mise directories reach the lane as the operator's own, outside the lane's isolated home", () => {
  const env = isolatedLaneEnvironment({
    lane: "e2e",
    environment: operator,
    root,
    pinned: pinnedCaches({ environment: operator, denoInfoDir: undefined }),
  })!;
  const paths = laneEnvPaths(root);
  // The lane's own HOME and XDG are empty, and mise still finds the operator's.
  assertEquals(env.HOME, paths.home);
  assertEquals(env.MISE_DATA_DIR, "/home/operator/.local/share/mise");
  assertEquals(env.MISE_CONFIG_DIR, "/home/operator/.config/mise");
  assertEquals(env.MISE_CACHE_DIR, "/home/operator/.cache/mise");
  assertEquals(env.MISE_STATE_DIR, "/home/operator/.local/state/mise");
  for (
    const name of [
      "MISE_DATA_DIR",
      "MISE_CONFIG_DIR",
      "MISE_CACHE_DIR",
      "MISE_STATE_DIR",
    ]
  ) {
    assertEquals(env[name]!.startsWith(paths.base), false, name);
  }
});

Deno.test("git reads the minimal config as a committer on main, with signing off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakery-gitconfig-"));
  try {
    const file = join(dir, "gitconfig");
    await writeFile(file, MINIMAL_GIT_CONFIG);
    const read = (key: string) =>
      run(GIT, ["config", "--file", file, "--get", key], {
        PATH: Deno.env.get("PATH") ?? "",
      });
    assertEquals(await read("user.name"), "Bakery Test");
    assertEquals(await read("user.email"), "test@example.test");
    assertEquals(await read("init.defaultBranch"), "main");
    assertEquals(await read("commit.gpgsign"), "false");
    assertEquals(await read("tag.gpgsign"), "false");
    // And nothing else: five keys, the whole of it.
    assertEquals(
      (await run(GIT, ["config", "--file", file, "--list"], {
        PATH: Deno.env.get("PATH") ?? "",
      })).split("\n").length,
      5,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("only the Codex login is removed: every other operator variable reaches the lane, as the header says", () => {
  const env = isolatedLaneEnvironment({
    lane: "security",
    environment: {
      ...operator,
      OPENAI_API_KEY: "sk-operator",
      GITHUB_TOKEN: "ghp_operator",
      GH_TOKEN: "ghp_operator",
      AWS_ACCESS_KEY_ID: "AKIAOPERATOR",
      SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
      DOCKER_CONFIG: "/home/operator/.docker",
    },
    root,
    pinned,
  });
  assert(env !== null);
  for (
    const key of [
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "SSH_AUTH_SOCK",
      "DOCKER_CONFIG",
    ]
  ) {
    assert(Object.hasOwn(env, key), `${key} is still the operator's`);
  }
  assertEquals(Object.hasOwn(env, "CODEX_HOME"), false);
  assertEquals(Object.hasOwn(env, "BAKERY_CODEX_AUTH_SOURCE_DIR"), false);
});

Deno.test("the worker's unit, which starts inside env -i, is given the lane's variables again, and only the ones the lane has", () => {
  const lane = isolatedLaneEnvironment({
    lane: "e2e",
    environment: operator,
    root,
    pinned: {
      DENO_DIR: "/home/operator/.cache/deno",
      MISE_CONFIG_DIR: "/home/operator/.config/mise",
      MISE_STATE_DIR: "/home/operator/.local/state/mise",
      MISE_DATA_DIR: "/home/operator/.local/share/mise",
      MISE_CACHE_DIR: "/home/operator/.cache/mise",
    },
  })!;
  const carried = carriedLaneVariables(lane);
  // The mise directories that keep mise out of the operator's untrusted config.
  for (
    const name of [
      "MISE_CONFIG_DIR",
      "MISE_STATE_DIR",
      "MISE_DATA_DIR",
      "MISE_CACHE_DIR",
      "DENO_DIR",
    ]
  ) assertEquals(carried[name], lane[name], name);
  // The lane's own home-relative settings, not the operator's.
  assertEquals(carried.XDG_CONFIG_HOME, lane.XDG_CONFIG_HOME);
  assertEquals(carried.GIT_CONFIG_GLOBAL, lane.GIT_CONFIG_GLOBAL);
  assertEquals(carried.GIT_CONFIG_NOSYSTEM, "1");
  assertEquals(
    carried[LANE_STACK_REGISTRY_VARIABLE],
    laneEnvPaths(root).stacks,
  );
  // Nothing else of the environment, and never a Codex variable or the HOME and PATH, which the unit is given on their own.
  for (const name of Object.keys(carried)) {
    assert(CARRIED_LANE_VARIABLES.includes(name), name);
  }
  for (
    const name of [
      "CODEX_HOME",
      "BAKERY_CODEX_AUTH_SOURCE_DIR",
      "HOME",
      "PATH",
      "DATABASE_URL",
      "TMPDIR",
    ]
  ) {
    assertEquals(carried[name], undefined, name);
  }
  assert(!CARRIED_LANE_VARIABLES.includes("HOME"));
  // Whatever the environment holds, the Codex login, HOME and PATH are never carried.
  assertEquals(
    carriedLaneVariables({
      CODEX_HOME: "/home/operator/.codex",
      BAKERY_CODEX_AUTH_SOURCE_DIR: "/home/operator/.codex",
      HOME: "/home/operator",
      PATH: "/usr/bin",
      BAKERY_TEST_CODEX_AUTH_DIR: "/tmp/dedicated",
      OPENAI_API_KEY: "sk-x",
    }),
    {},
  );
  // Unset and empty values are not carried.
  assertEquals(
    carriedLaneVariables({ MISE_CONFIG_DIR: "", XDG_DATA_HOME: "/x" }),
    {
      XDG_DATA_HOME: "/x",
    },
  );
  assertEquals(carriedLaneVariables({}), {});
});

Deno.test("the isolated lane names its stack registry inside its own env directory, not in its home and not beside it", () => {
  const paths = laneEnvPaths(root);
  assertEquals(paths.stacks, `${root}/env/stacks`);
  assert(!paths.stacks.startsWith(`${paths.home}/`));
  assert(!paths.directories.includes(paths.stacks));
  const lane = isolatedLaneEnvironment({
    lane: "integration",
    environment: operator,
    root,
    pinned,
  })!;
  assertEquals(lane[LANE_STACK_REGISTRY_VARIABLE], paths.stacks);
  // A lane that is not isolated has no registry.
  assertEquals(
    isolatedLaneEnvironment({
      lane: "unit",
      environment: operator,
      root,
      pinned,
    }),
    null,
  );
});
