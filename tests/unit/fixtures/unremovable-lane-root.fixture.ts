// Run only by the temp hygiene rail (it is not a *_test.ts file, so no lane
// collects it): makes the directory that holds the lane's temp root read-only,
// so the runner's sweep cannot unlink the root. Nothing is left inside it, so
// the failed removal is the only thing the sweep has to report. It is not restored here: the
// sweep runs after this process exits, and the rail's own cleanup makes every
// directory accessible again before removing the tree.
import { dirname } from "node:path";

Deno.test("makes the directory holding the lane root unwritable", () => {
  const root = Deno.env.get("TMPDIR")!;
  Deno.chmodSync(dirname(root), 0o500);
});
