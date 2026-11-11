import { assert, assertEquals } from "@std/assert";
import { workerRunExecutables } from "../../apps/worker/src/config.ts";
import { GIT_EXECUTABLE } from "../../apps/worker/src/git-executable.ts";

// The worker's --allow-run grant names git by absolute path, and Deno matches
// the path a command resolves to. A bare `git` resolves through PATH, so on a
// host whose PATH lists /bin before /usr/bin it becomes /bin/git, misses the
// grant and fails with NotCapable (issues #97 and #102). Granting the bare name
// instead would let whichever git comes first on PATH run, which is the wider
// grant the narrow list exists to avoid. So the worker spawns the one path it
// is granted, and this file keeps the grant and every spawn on that one name.

const workerSource = new URL("../../apps/worker/src/", import.meta.url);
const constantModule = "git-executable.ts";

async function* sources(
  directory: URL,
): AsyncGenerator<{ name: string; text: string }> {
  for await (const entry of Deno.readDir(directory)) {
    const child = new URL(
      `${entry.name}${entry.isDirectory ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory) yield* sources(child);
    else if (entry.name.endsWith(".ts")) {
      yield {
        name: child.pathname.slice(workerSource.pathname.length),
        text: await Deno.readTextFile(child),
      };
    }
  }
}

/** A spawn of the bare name, in any quoting and with any spacing. */
const bareGitSpawn = /\bCommand\(\s*["'`]git["'`]/;

Deno.test("the git the worker is granted is the absolute path it is told to spawn", () => {
  assert(GIT_EXECUTABLE.startsWith("/"), "a path, never a name found on PATH");
  const granted = workerRunExecutables("/usr/bin/deno", "/usr/bin/claude");
  assert(granted.includes(GIT_EXECUTABLE));
  assertEquals(granted.includes("git"), false, "no grant by bare name");
  // Without a harness the worker is granted no git at all, as before.
  assertEquals(
    workerRunExecutables("/usr/bin/deno").includes(GIT_EXECUTABLE),
    false,
  );
});

Deno.test("no worker source spawns git by a bare name or repeats the path", async () => {
  const spawnsByName: string[] = [];
  const repeatsPath: string[] = [];
  let scanned = 0;
  for await (const { name, text } of sources(workerSource)) {
    scanned += 1;
    if (name === constantModule) continue;
    if (bareGitSpawn.test(text)) spawnsByName.push(name);
    if (text.includes(GIT_EXECUTABLE)) repeatsPath.push(name);
  }
  assert(scanned > 20, "the scan must actually see the worker sources");
  assertEquals(spawnsByName, [], "these spawn `git` through PATH");
  assertEquals(
    repeatsPath,
    [],
    "these write the path out again instead of using GIT_EXECUTABLE",
  );
});

Deno.test("the scan recognises the spawns it forbids and lets the right one through", () => {
  for (
    const forbidden of [
      'new Deno.Command("git", {',
      "new Deno.Command('git', {",
      "new Deno.Command(`git`, {",
      'new Deno.Command(\n    "git",',
      'new Deno.Command( "git" , {',
    ]
  ) assert(bareGitSpawn.test(forbidden), forbidden);
  for (
    const allowed of [
      "new Deno.Command(GIT_EXECUTABLE, {",
      'new Deno.Command("gitleaks", {',
      'new Deno.Command("/usr/bin/setsid", { args: ["git"] })',
    ]
  ) assert(!bareGitSpawn.test(allowed), allowed);
});
