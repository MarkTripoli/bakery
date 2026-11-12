import { assert, assertEquals } from "@std/assert";

// #229: scripts/run-tests.ts hands the test process the PATH the lane started
// with and its --allow-run grant, so a refused spawn can say how they differ
// from what it sees (tests/helpers/spawn-capability-report.ts). Only the lane
// runner can set them, so this runs when the rails test
// tests/rails/refused-spawn-report_test.ts starts the real runner over this one
// file with BAKERY_TEST_LANE_PROBE=1, and is ignored in an ordinary lane run.

Deno.test({
  name:
    "the lane hands the test process its startup PATH and its --allow-run grant",
  ignore: Deno.env.get("BAKERY_TEST_LANE_PROBE") !== "1",
  fn() {
    assertEquals(
      Deno.env.get("BAKERY_TEST_STARTUP_PATH"),
      Deno.env.get("BAKERY_TEST_EXPECT_PATH"),
      "the startup PATH is the PATH the runner itself had",
    );
    const grant = (Deno.env.get("BAKERY_TEST_ALLOW_RUN") ?? "").split(",");
    for (const entry of ["git", "/usr/bin/git"]) {
      assert(grant.includes(entry), `the unit lane's grant names ${entry}`);
    }
  },
});
