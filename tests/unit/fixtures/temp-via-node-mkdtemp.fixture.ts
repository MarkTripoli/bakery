// Run only by the temp hygiene rail. Node's mkdtemp is not one of the Deno calls
// the test preload wraps, so only the lane runner's sweep of its own temp root
// can catch what this leaves.
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

Deno.test("leaves a directory made by node's mkdtemp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakery-fixture-node-"));
  await Deno.writeTextFile(join(dir, "x"), "x");
});
