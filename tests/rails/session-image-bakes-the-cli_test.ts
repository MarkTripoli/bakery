/**
 * The session image's `bakery` is the one this repository builds (#404).
 *
 * The command arrives in a session one way: baked into the image at a fixed path,
 * bound read-only into the sandbox, and found on `PATH`. Three files have to
 * agree for that to be true - the build script that installs it, the worker that
 * mounts it, and the package that is compiled - and each of them is written by
 * hand. This test is the seam between them: it reads the build script and the
 * package rather than importing a copy of the answer.
 */

import { assert, assertEquals } from "@std/assert";
import {
  nativeActionEnvironment,
  SESSION_CLI_PATH,
} from "../../apps/worker/src/executor.ts";

const repository = new URL("../../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, repository));
}

Deno.test("the baked command lands where the sandbox mounts it", async () => {
  const script = await read("scripts/build-session-image.sh");
  const installed = /^BINARY=(.+)$/m.exec(script)?.[1]?.trim();
  assertEquals(
    installed,
    SESSION_CLI_PATH,
    "the image installs the command somewhere the sandbox does not mount it",
  );
});

Deno.test("the image compiles this package's entry point", async () => {
  const script = await read("scripts/build-session-image.sh");
  const entry = /^ENTRY=(.+)$/m.exec(script)?.[1]?.trim();
  assertEquals(entry, "packages/cli/src/main.ts");
  // And that entry is the package's, so "the CLI in the image" cannot become a
  // different program than the one a person runs.
  const packageJson = JSON.parse(await read("packages/cli/package.json"));
  assertEquals(packageJson.name, "@bakery/cli");
});

Deno.test("the image build installs a read-only, root-owned binary", async () => {
  const script = await read("scripts/build-session-image.sh");
  // `--chmod=0555` on the COPY is what makes it read-only for the session that
  // mounts it: a writable binary is a writable command, and a session could
  // replace the tool that authorises it.
  assert(
    script.includes("--chmod=0555"),
    "the baked binary is writable",
  );
  // Mounted, not copied in at run time: no host path appears in the build.
  assert(
    !/^(COPY|ADD)\s+\.\s/m.test(script),
    "the image copies the repository in",
  );
});

Deno.test("the sandbox binds the command read-only and never a host path", async () => {
  const { nativeSandboxArguments } = await import(
    "../../apps/worker/src/executor.ts"
  );
  const args = nativeSandboxArguments({
    executable: "/usr/bin/true",
    args: [],
    runtimePaths: [
      {
        path: "/usr/bin/deno",
        target: "/usr/bin/deno",
        identity: "",
        directory: false,
      },
    ],
    readOnlyPaths: [SESSION_CLI_PATH],
    environment: { PATH: "/usr/bin:/bin" },
    forwardStdin: false,
  });
  const index = args.indexOf(SESSION_CLI_PATH);
  assert(index > 0, "the command was not mounted at all");
  assertEquals(
    args[index - 1],
    "--ro-bind",
    "the command is mounted writable",
  );
  // The mount's target is its own path, so nothing of the worker's state comes
  // with it: a session gets the binary and no directory tree around it.
  assertEquals(args[index + 1], SESSION_CLI_PATH);
  // Nothing beyond the runtime closure, the action's own executable and the
  // command is mounted: an extra mount here would be a host path reaching a
  // session, and the sandbox's `--dir` parents are what make the command's
  // directory exist without exposing its contents.
  const bound = args
    .map((
      argument,
      position,
    ) => (argument === "--ro-bind" ? args[position + 1] : null))
    .filter((path) => path !== null);
  assertEquals(
    bound.sort(),
    ["/usr/bin/deno", "/usr/bin/true", SESSION_CLI_PATH].sort(),
  );
});

Deno.test("a native action's sandbox has no session, so bakery refuses there", () => {
  // The command is mounted and on PATH inside an action's sandbox, and that is
  // deliberate: an action that wants it can have it. What an action does not get
  // is a session. Its environment is a closed map with no credential path and no
  // gateway address, so the command answers "not in a session" and stops. The
  // product decision is that an action is Bakery's own tool, not an agent's turn,
  // and this test is where that stops being an accident of wiring.
  for (const skillRoots of [undefined, JSON.stringify(["/tmp/one"])]) {
    const environment = nativeActionEnvironment(skillRoots);
    for (const name of Object.keys(environment)) {
      assert(
        !name.startsWith("BAKERY_SESSION_") && name !== "BAKERY_URL",
        `an action's sandbox carries ${name}, so bakery would think it has a session`,
      );
    }
    // The map is closed: PATH and the Deno cache, plus skill roots when a step
    // pinned some. A new key here is a visible decision, not an addition.
    assertEquals(
      Object.keys(environment).sort(),
      skillRoots === undefined
        ? ["DENO_DIR", "PATH"]
        : ["BAKERY_WORKER_SKILL_ROOTS", "DENO_DIR", "PATH"],
    );
  }
});
