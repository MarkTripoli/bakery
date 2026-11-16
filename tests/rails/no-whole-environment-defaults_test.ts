import { assertEquals } from "@std/assert";
import { readCoordinatorEnv } from "../../apps/server/src/modules/conversation/coordinator.ts";

// #322: under a lane's scoped `--allow-env`, reading the whole environment
// throws NotCapable — the way #306 crashed the recovery child. Server code reads
// named variables (or its `RuntimeConfig`) instead, so no whole-environment
// default may come back.

const ROOT = new URL("../../apps/server/src/", import.meta.url).pathname;

/**
 * Every whole-environment read in a file: the Deno call by name, and a bare
 * `process.env` in any position — assignment, spread, argument or default —
 * while a member read (`process.env.BAKERY_ENV`) is not a whole-environment
 * read and stays allowed.
 */
const WHOLE_ENV = /Deno\.env\.toObject\(\)|\bprocess\.env(?!\w|\.)/;

/** A comment never runs; only prose that happens to name the pattern is skipped. */
function isComment(line: string): boolean {
  const text = line.trimStart();
  return text.startsWith("*") || text.startsWith("//") ||
    text.startsWith("/*");
}

async function* sources(
  directory: string,
): AsyncGenerator<{ path: string; text: string }> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory) {
      yield* sources(`${path}/`);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    yield { path, text: await Deno.readTextFile(path) };
  }
}

Deno.test("apps/server never defaults to the whole environment (#322)", async () => {
  const offenders: string[] = [];
  for await (const { path, text } of sources(ROOT)) {
    for (const [index, line] of text.split("\n").entries()) {
      if (WHOLE_ENV.test(line) && !isComment(line)) {
        offenders.push(`${path.slice(ROOT.length)}:${index + 1}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "read named variables (or RuntimeConfig) instead of the whole environment",
  );
});

Deno.test("the coordinator executor reads only the five variables it uses", () => {
  // The reader is handed a `read` function so the test sees exactly which
  // names are asked for: a whole-environment read could not be inspected.
  const asked: string[] = [];
  const env = readCoordinatorEnv((name) => {
    asked.push(name);
    return undefined;
  });
  assertEquals([...asked].sort(), [
    "BAKERY_COORDINATOR_CLAIM_TIMEOUT_MS",
    "BAKERY_COORDINATOR_EXECUTOR",
    "BAKERY_COORDINATOR_TURN_TIMEOUT_MS",
    "BAKERY_ENV",
    "BAKERY_SCRIPTED_COORDINATOR_DIR",
  ]);
  assertEquals(Object.keys(env).length, 5);
});

Deno.test("the whole-environment scan skips prose and catches a spread (#322)", () => {
  // A comment documenting the rule must not turn the rail red (F2), while a
  // spread of the whole environment must be caught (F1).
  const probes: Array<[string, boolean]> = [
    ["// we never read process.env = anything", false],
    ["* a doc block naming process.env = is prose", false],
    ["/* Deno.env.toObject() in a block comment */", false],
    ["const whole = process.env;", true],
    ["const copy = { ...process.env };", true],
    ["const copy = Object.assign({}, process.env);", true],
    ["const copy = read(process.env);", true],
    ["const copy = pick(process.env, 'HOME');", true],
    ["const copy = { ...Deno.env.toObject() };", true],
    ["const name = process.env.BAKERY_ENV;", false],
    ["const name = Deno.env.get('BAKERY_ENV');", false],
  ];
  for (const [line, expected] of probes) {
    assertEquals(
      WHOLE_ENV.test(line) && !isComment(line),
      expected,
      line,
    );
  }
});
