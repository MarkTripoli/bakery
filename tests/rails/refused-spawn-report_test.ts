import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { removeTreeSync } from "../../scripts/ci/temp-tree.ts";

// #229: `NotCapable: Requires run access to "git"` seen twice on the rig host,
// every rerun passing. Reproduced with a throwaway script on Deno 2.9.1: the
// lane's --allow-run=git,/usr/bin/git is resolved against the PATH the process
// started with, and a bare `git` against the PATH of the moment it is spawned,
// so a PATH that changes after the start refuses a spawn the grant names. A
// refused spawn now prints what it saw. These run the real thing, in
// subprocesses, so they fail if the Deno behaviour this relies on changes.

const repository = new URL("../../", import.meta.url).pathname;
const decoder = new TextDecoder();

// Deno 2.9 creates $DENO_DIR/node_compat_bin and puts it in front of its own
// PATH when it cannot find `node` on the PATH it starts with. A hosted runner
// keeps node in its tool cache, not in /usr/bin (#330), so a fixture that builds
// its PATH by hand would see "the PATH changed since start" for a reason that
// has nothing to do with the spawn under test. These fixtures give their PATH a
// directory where `node` resolves, so what they assert does not depend on where
// the host keeps node.
function withNode(path: string): string {
  const hasNode = (directory: string) => {
    try {
      return Deno.statSync(join(directory, "node")).isFile;
    } catch {
      return false;
    }
  };
  if (path.split(":").some(hasNode)) return path;
  const found = (Deno.env.get("PATH") ?? "").split(":").find(hasNode);
  return found === undefined ? path : `${path}:${found}`;
}
const FIXTURE_PATH = withNode("/usr/bin");

const FIXTURE = `
const [mode, shadow, method] = Deno.args;
if (mode === "shadow") {
  Deno.env.set("PATH", shadow + ":" + Deno.env.get("PATH"));
}
if (mode === "shape") {
  const prototype = Deno.Command.prototype as unknown as Record<string, unknown>;
  console.log(JSON.stringify(["output", "outputSync", "spawn"].map((name) => ({
    name,
    functionName: (prototype[name] as { name: string }).name,
    hasPrototype: Object.hasOwn(prototype[name] as object, "prototype"),
  }))));
  Deno.exit(0);
}
const program = mode === "missing-absolute"
  ? "/nonexistent/kill"
  : mode === "ungranted"
  ? "ls"
  : "git";
const command = new Deno.Command(program, {
  args: [mode === "ungranted" ? "/" : "--version"],
  stdout: "null",
  stderr: "null",
});
try {
  if (method === "outputSync") command.outputSync();
  else if (method === "spawn") await command.spawn().status;
  else await command.output();
  console.log("spawned");
} catch (error) {
  console.log("caught " + (error as Error).name);
}
`;

async function withFixture(
  body: (
    run: (
      mode: string,
      method?: string,
    ) => Promise<{ out: string; err: string }>,
  ) => Promise<void>,
): Promise<void> {
  const base = await Deno.makeTempDir({ prefix: "spr-" });
  try {
    const bin = join(base, "shadow-bin");
    await Deno.mkdir(bin);
    const link = await new Deno.Command("bash", {
      args: ["-c", 'ln -s /usr/bin/git "$1"', "bash", join(bin, "git")],
    }).output();
    assertEquals(link.code, 0, "a git beside the real one could not be made");
    const fixture = join(base, "fixture.ts");
    await Deno.writeTextFile(fixture, FIXTURE);
    await body(async (mode, method = "output") => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-run=git,/usr/bin/git",
          "--allow-env",
          "--allow-read",
          "--preload",
          join(repository, "tests/helpers/temp-cleanup-preload.ts"),
          fixture,
          mode,
          bin,
          method,
        ],
        env: {
          PATH: FIXTURE_PATH,
          BAKERY_TEST_STARTUP_PATH: FIXTURE_PATH,
          BAKERY_TEST_ALLOW_RUN: "git,/usr/bin/git",
        },
        cwd: repository,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, decoder.decode(result.stderr).slice(-1500));
      return {
        out: decoder.decode(result.stdout).trim(),
        err: decoder.decode(result.stderr),
      };
    });
  } finally {
    removeTreeSync(base);
  }
}

Deno.test("a PATH that changes after the start refuses a bare git, with the same error and a report that says so", async () => {
  await withFixture(async (run) => {
    const { out, err } = await run("shadow");
    assertEquals(out, "caught NotCapable", "the refusal is the original error");
    assertStringIncludes(err, "[bakery-test] spawn refused (#229)");
    assertStringIncludes(err, "PATH changed since start: YES");
    assertStringIncludes(err, "resolves to the same path: NO");
    assertStringIncludes(err, `PATH at lane start:      ${FIXTURE_PATH}`);
    assertStringIncludes(err, "lane --allow-run:        git,/usr/bin/git");
    assertStringIncludes(err, "shadow-bin/git -> /usr/bin/git");
  });
});

Deno.test("every way of spawning is covered: output, outputSync and spawn each throw the original error and report", async () => {
  await withFixture(async (run) => {
    for (const method of ["output", "outputSync", "spawn"]) {
      const { out, err } = await run("shadow", method);
      assertEquals(out, "caught NotCapable", method);
      assertStringIncludes(err, "PATH changed since start: YES");
    }
  });
});

Deno.test("a deliberate refusal of a path that is not on disk throws the original error and prints nothing", async () => {
  await withFixture(async (run) => {
    const { out, err } = await run("missing-absolute");
    assertEquals(out, "caught NotCapable");
    assert(!err.includes("[bakery-test]"), `unexpected report:\n${err}`);
  });
});

Deno.test("the wrapped methods keep their own names and gain no prototype property", async () => {
  await withFixture(async (run) => {
    const { out } = await run("shape");
    assertEquals(JSON.parse(out), [
      { name: "output", functionName: "output", hasPrototype: false },
      { name: "outputSync", functionName: "outputSync", hasPrototype: false },
      { name: "spawn", functionName: "spawn", hasPrototype: false },
    ]);
  });
});

Deno.test("a git the PATH never changed under spawns as before and prints nothing", async () => {
  await withFixture(async (run) => {
    const { out, err } = await run("plain");
    assertEquals(out, "spawned");
    assert(!err.includes("[bakery-test]"), `unexpected report:\n${err}`);
  });
});

Deno.test("a program the grant never named is reported too, and the PATH is said not to have changed", async () => {
  await withFixture(async (run) => {
    const { out, err } = await run("ungranted");
    assertEquals(out, "caught NotCapable");
    assertStringIncludes(err, "[bakery-test] spawn refused (#229)");
    assertStringIncludes(err, "program:                 ls");
    assertStringIncludes(err, "PATH changed since start: no");
  });
});

Deno.test("the lane runner hands the test process its startup PATH and its --allow-run grant", async () => {
  const marker = withNode("/usr/bin:/bin:/bakery-lane-probe-marker");
  const run = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      "scripts/run-tests.ts",
      "unit",
      "tests/unit/lane-spawn-diagnostic-env_test.ts",
    ],
    env: {
      PATH: marker,
      BAKERY_TEST_LANE_PROBE: "1",
      BAKERY_TEST_EXPECT_PATH: marker,
    },
    cwd: repository,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = decoder.decode(run.stdout) + decoder.decode(run.stderr);
  assertEquals(run.code, 0, `the lane failed:\n${text.slice(-1500)}`);
  assertStringIncludes(text, "1 passed");
  assert(
    !text.includes("ignored"),
    "the probe was ignored, so it proved nothing",
  );
});
