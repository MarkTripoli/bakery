import { assertEquals } from "@std/assert";
import { readCoordinatorEnv } from "../../apps/server/src/modules/conversation/coordinator.ts";

// #322: under a lane's scoped `--allow-env`, reading the whole environment
// throws NotCapable — the way #306 crashed the recovery child. Server code reads
// named variables (or its `RuntimeConfig`) instead, so no whole-environment
// default may come back.

const ROOT = new URL("../../apps/server/src/", import.meta.url).pathname;

/** Every `Deno.env.toObject()`, `= process.env` or `process.env =` in a file. */
const WHOLE_ENV =
  /Deno\.env\.toObject\(\)|=\s*process\.env\b|\bprocess\.env\s*=/;

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
      // A comment or a doc block never runs; the rail looks at code.
      if (WHOLE_ENV.test(line) && !line.trimStart().startsWith("*")) {
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

Deno.test("the coordinator executor reads only the three variables it selects on", () => {
  // The reader is handed a `read` function so the test sees exactly which
  // names are asked for: a whole-environment read could not be inspected.
  const asked: string[] = [];
  const env = readCoordinatorEnv((name) => {
    asked.push(name);
    return undefined;
  });
  assertEquals([...asked].sort(), [
    "BAKERY_COORDINATOR_EXECUTOR",
    "BAKERY_ENV",
    "BAKERY_SCRIPTED_COORDINATOR_DIR",
  ]);
  assertEquals(Object.keys(env).length, 3);
});
