import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  candidatePaths,
  resolveProgram,
  startupProgram,
} from "../helpers/lane-program.ts";

// #229: a lane's grant names `git` as it resolved at startup, and a bare `git`
// spawn resolves again against the PATH of the moment. These pin the decision
// the harness makes instead: resolve once, from the startup PATH, and spawn the
// absolute path, so a PATH that changes later cannot refuse a granted program.

const exists = (...present: string[]) => (candidate: string) =>
  present.includes(candidate);

Deno.test("candidatePaths walks the PATH in order and joins each directory", () => {
  assertEquals(
    candidatePaths("/usr/local/bin:/usr/bin:/bin", "git"),
    ["/usr/local/bin/git", "/usr/bin/git", "/bin/git"],
  );
});

Deno.test("candidatePaths ignores empty segments and a missing PATH", () => {
  assertEquals(candidatePaths("/usr/bin::/bin", "git"), [
    "/usr/bin/git",
    "/bin/git",
  ]);
  assertEquals(candidatePaths(undefined, "git"), []);
});

Deno.test("candidatePaths does not build a path for a program that already has one", () => {
  assertEquals(candidatePaths("/usr/bin", "/usr/bin/git"), []);
});

Deno.test("a trailing slash on a directory does not double the separator", () => {
  assertEquals(candidatePaths("/usr/bin/:", "git"), ["/usr/bin/git"]);
});

Deno.test("resolveProgram takes the first candidate that exists, the one a spawn would use", () => {
  assertEquals(
    resolveProgram(
      "/usr/local/bin:/usr/bin",
      "git",
      exists("/usr/bin/git"),
    ),
    "/usr/bin/git",
  );
});

Deno.test("resolveProgram takes the earlier of two candidates, as the PATH orders them", () => {
  assertEquals(
    resolveProgram(
      "/usr/local/bin:/usr/bin",
      "git",
      exists("/usr/local/bin/git", "/usr/bin/git"),
    ),
    "/usr/local/bin/git",
  );
});

Deno.test("resolveProgram returns nothing when the program is nowhere on the PATH", () => {
  assertEquals(resolveProgram("/usr/local/bin", "git", exists()), undefined);
});

Deno.test("resolveProgram keeps an absolute program as the caller wrote it", () => {
  assertEquals(
    resolveProgram("/usr/local/bin", "/usr/bin/git", exists()),
    "/usr/bin/git",
  );
});

Deno.test("startupProgram resolves from the PATH the lane started with, not the one now", () => {
  // The startup PATH is where `git` was resolved for the grant; the PATH now is
  // a shadow that would refuse a bare spawn.
  const read = (name: string) =>
    name === "BAKERY_TEST_STARTUP_PATH"
      ? "/usr/bin"
      : "/tmp/shadow-bin:/usr/bin";
  assertEquals(
    startupProgram("git", (name) => (read(name) as string) ?? undefined),
    "/usr/bin/git",
  );
});

Deno.test("startupProgram falls back to the PATH now when no startup PATH was recorded", () => {
  assertEquals(
    startupProgram("git", (name) => name === "PATH" ? "/usr/bin" : undefined),
    "/usr/bin/git",
  );
});

Deno.test("startupProgram returns the bare name when the program is on no PATH, so the spawn fails as it always did", () => {
  const program = startupProgram(
    "definitely-not-a-real-program-229",
    () => "/usr/bin",
  );
  assertEquals(program, "definitely-not-a-real-program-229");
});

Deno.test("the program the harness spawns is one the lane grants, whatever the PATH does next", () => {
  // In the unit lane this resolves to the same absolute path the grant names,
  // which is the whole point: the spawn no longer depends on a later PATH.
  const git = startupProgram("git");
  assert(
    git.startsWith("/"),
    `git did not resolve to an absolute path: ${git}`,
  );
  assertStringIncludes(
    Deno.permissions.querySync({
      name: "run",
      command: git,
    }).state,
    "granted",
  );
});
