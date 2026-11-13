import { assertIsolatedLaneHome } from "../helpers/isolated-lane-home.ts";

// #246: the integration lane starts with an empty HOME and no path to the operator's
// Codex login.
Deno.test("the integration lane runs with an isolated HOME", () => {
  assertIsolatedLaneHome();
});
