import { assertIsolatedLaneHome } from "../helpers/isolated-lane-home.ts";

// #246: the security lane starts with an empty HOME and no path to the operator's
// Codex login.
Deno.test("the security lane runs with an isolated HOME", () => {
  assertIsolatedLaneHome();
});
