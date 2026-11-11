import { assert } from "@std/assert";
import { WORKER_RUNTIME_ENVIRONMENT_NAMES } from "../../apps/worker/src/config.ts";

const script = await Deno.readTextFile(
  new URL("../../apps/worker/scripts/run-worker.sh", import.meta.url),
);

Deno.test("every worker runtime variable passes the launch env allowlist", () => {
  for (const name of WORKER_RUNTIME_ENVIRONMENT_NAMES) {
    assert(script.includes(name), `run-worker.sh omits ${name}`);
  }
});
