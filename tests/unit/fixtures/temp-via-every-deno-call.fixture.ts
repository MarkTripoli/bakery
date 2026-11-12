// Run only by the temp hygiene rail (it is not a *_test.ts file, so no lane
// collects it): makes temp paths with all four Deno calls, one of them locked,
// and removes none. The rail then expects the lane to leave nothing behind.
import { join } from "node:path";

Deno.test("makes temp paths through every Deno call and keeps none of them tidy", async () => {
  const a = await Deno.makeTempDir({ prefix: "bakery-fixture-async-dir-" });
  const b = Deno.makeTempDirSync({ prefix: "bakery-fixture-sync-dir-" });
  await Deno.makeTempFile({ prefix: "bakery-fixture-async-file-" });
  Deno.makeTempFileSync({ prefix: "bakery-fixture-sync-file-" });
  await Deno.mkdir(join(a, "locked"));
  await Deno.writeTextFile(join(a, "locked", "inside"), "x");
  await Deno.chmod(join(a, "locked"), 0o000);
  await Deno.writeTextFile(join(b, "plain"), "x");
});
