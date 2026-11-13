import { assert, assertEquals } from "@std/assert";
import { DRAFT_WORKER_LAUNCHER } from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import { DRAFT_LIMITS } from "../../apps/server/src/modules/knowledge/drafts.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("the launcher pins the worker module, cache and limits the server expects", async () => {
  const script = await read("infra/draft-worker/launch.sh");
  // The server's constant is where the repository is mounted in the image.
  assertEquals(
    DRAFT_WORKER_LAUNCHER,
    "/workspace/infra/draft-worker/launch.sh",
  );
  const worker = /^WORKER_MODULE=(.+)$/m.exec(script)?.[1];
  assertEquals(
    worker,
    "/workspace/apps/server/src/modules/knowledge/draft-import-worker.ts",
  );
  await Deno.stat(new URL(worker!.slice("/workspace/".length), root));
  assertEquals(/^WORKER_DENO_DIR=(.+)$/m.exec(script)?.[1], "/deno-dir");
  assert(
    (await read("apps/server/Dockerfile")).includes("ENV DENO_DIR=/deno-dir"),
  );
  assert(
    script.includes(
      `--v8-flags=--max-old-space-size=${DRAFT_LIMITS.processHeapMegabytes},--wasm-max-mem-pages=${DRAFT_LIMITS.processWasmPages}`,
    ),
  );
  assert(
    script.includes(
      `  /usr/bin/prlimit --data=${DRAFT_LIMITS.processDataBytes} --cpu=${DRAFT_LIMITS.processCpuSeconds} --core=0 -- \\`,
    ),
    "prlimit bounds",
  );
  // The CPU backstop never undercuts the parent's typed deadline (#305): it
  // covers both wall budgets plus a second, as RuntimeMaxSec does for systemd.
  assertEquals(
    DRAFT_LIMITS.processCpuSeconds,
    Math.ceil(
      (DRAFT_LIMITS.workerStartupMs + DRAFT_LIMITS.workerRuntimeMs) / 1_000,
    ) + 1,
  );
  for (
    const flag of ["--cached-only", "--no-prompt", "--deny-import", "--frozen"]
  ) {
    assert(script.includes(`  ${flag} \\`), flag);
  }
  // Nothing it is given reaches Deno: argv is only validated, the environment
  // is replaced, and every command is an absolute path.
  assert(script.includes("exec /usr/bin/env -i \\"));
  assert(script.includes("  /usr/bin/deno run \\"));
  const afterExec = script.slice(script.indexOf("exec /usr/bin/env -i"));
  assert(!/\$[@*1-9#]|\$\{?[A-Z_]*ARG/.test(afterExec), "argv reaches Deno");
  const commands = script.split("\n").filter((line) => !line.startsWith("#"))
    .join("\n");
  assert(!/--allow-|-A\b|eval/.test(commands), "a permission or eval flag");
  assert(
    ((await Deno.stat(new URL("infra/draft-worker/launch.sh", root))).mode! &
      0o111) !== 0,
    "launch.sh is not executable",
  );
});

Deno.test("the container grants the server exactly the launcher and nothing else to run", async () => {
  const compose = await read("infra/compose.yaml");
  const grants = [...compose.matchAll(/--allow-run=([^\s"]+)/g)].map((m) =>
    m[1]
  );
  assertEquals(grants, [DRAFT_WORKER_LAUNCHER]);
  assert(!/--allow-run(?!=)/.test(compose), "an unscoped --allow-run");
  assert(!/--allow-all|\s-A\s/.test(compose), "--allow-all");
});
