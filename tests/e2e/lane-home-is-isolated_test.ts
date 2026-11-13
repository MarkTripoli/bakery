import { assertIsolatedLaneHome } from "../helpers/isolated-lane-home.ts";

// #246: the e2e lane starts with an empty HOME and no path to the operator's
// Codex login.
Deno.test("the e2e lane runs with an isolated HOME", () => {
  assertIsolatedLaneHome();
});
