import { assert, assertEquals } from "@std/assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
