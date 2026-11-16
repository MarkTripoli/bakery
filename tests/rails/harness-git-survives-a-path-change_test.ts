import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { removeTreeSync } from "../../scripts/ci/temp-tree.ts";

// #229: the bounded coding-harness fixture calls `git` through
// `tests/helpers/harness.ts`. A bare `git` resolves against the PATH of the
// moment, while the lane's grant named it as it resolved at startup, so a PATH
// that changes mid-run refuses the spawn (#304 reproduces that refusal). These
// run the real thing in a subprocess with the unit lane's exact grant, and fail
// if harness.gitText ever goes back to a bare name.

const repository = new URL("../../", import.meta.url).pathname;
const decoder = new TextDecoder();

const FIXTURE = `
import { gitText } from "${join(repository, "tests/helpers/harness.ts")}";
const [mode, shadow] = Deno.args;
if (mode === "shadow") Deno.env.set("PATH", shadow + ":" + Deno.env.get("PATH"));
try {
  const version = await gitText("${repository}", ["--version"]);
  console.log("ok " + version);
} catch (error) {
  console.log("caught " + (error as Error).name);
}
`;

// The same node note as tests/rails/refused-spawn-report_test.ts: Deno 2.9 may
// prepend its own node_compat_bin directory to a PATH it starts with, which
// would make "the PATH changed" true for a reason unrelated to this test.
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

async function withFixture(
  body: (
    run: (mode: string) => Promise<{ out: string; err: string }>,
  ) => Promise<void>,
): Promise<void> {
  const base = await Deno.makeTempDir({ prefix: "harness-git-" });
  try {
    const shadow = join(base, "shadow-bin");
    await Deno.mkdir(shadow);
    const link = await new Deno.Command("bash", {
      args: ["-c", 'ln -s /usr/bin/git "$1"', "bash", join(shadow, "git")],
    }).output();
    assertEquals(link.code, 0, "a git beside the real one could not be made");
    const fixture = join(base, "fixture.ts");
    await Deno.writeTextFile(fixture, FIXTURE);
    await body(async (mode) => {
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
          shadow,
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
      return {
        out: decoder.decode(result.stdout).trim(),
        err: decoder.decode(result.stderr),
      };
    });
  } finally {
    removeTreeSync(base);
  }
}

Deno.test("the harness spawns git under the PATH it started with", async () => {
  await withFixture(async (run) => {
    const { out, err } = await run("plain");
    assertEquals(out.startsWith("ok git version"), true, out);
    assertEquals(err.includes("[bakery-test]"), false, err);
  });
});

Deno.test("a PATH that changes mid-run does not stop the harness spawning git", async () => {
  await withFixture(async (run) => {
    const { out } = await run("shadow");
    // Before #229 was fixed this was "caught NotCapable": the bare name resolved
    // through the shadow directory, which the grant never named.
    assertEquals(out.startsWith("ok git version"), true, out);
  });
});
