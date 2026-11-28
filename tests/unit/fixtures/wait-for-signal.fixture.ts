// Run only by the temp hygiene rail (it is not a *_test.ts file, so no lane
// collects it): leaves something the test preload cannot clean (Node's mkdtemp)
// in the lane root, tells the rail it is up by writing its pid beside it, and
// then waits to be terminated. The wait is bounded, so a run whose signal was
// not forwarded cannot leave this process behind for long (#254).
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

Deno.test("waits for the runner to forward a termination signal", async () => {
  mkdtempSync(join(tmpdir(), "bakery-fixture-signal-"));
  writeFileSync(join(tmpdir(), "ready.partial"), String(Deno.pid));
  renameSync(join(tmpdir(), "ready.partial"), join(tmpdir(), "ready"));
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
