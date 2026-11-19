import { assertEquals } from "@std/assert";
import { RUN_GRANT_ACTIONS } from "../../apps/server/src/modules/auth/application/run-grants.ts";

/**
 * A run access grant (#456) is observe only. The gate consults grants for these
 * actions and no others, so a new action never becomes reachable by a grant by
 * accident: it has to be added here, in review, with its own refusal test.
 */
Deno.test("a run grant reaches exactly the run, its steps and its task read", () => {
  assertEquals(
    Object.entries(RUN_GRANT_ACTIONS).sort(([a], [b]) => a < b ? -1 : 1),
    [
      ["runSteps.list", "run"],
      ["runs.get", "run"],
      ["tasks.get", "task"],
    ],
  );
});
