import { assertEquals, assertThrows } from "@std/assert";
import {
  parseUpdateArgs,
  UPDATE_REFUSAL_EXIT_CODES,
} from "../../apps/server/src/platform/update-task.ts";

/**
 * #59: the update task runs as the database owner around an update, so it
 * refuses a bad argument before it opens the database, and a refused pause
 * has an exit code the launcher can tell apart without reading text.
 */

Deno.test("one known subcommand is accepted", () => {
  for (const name of ["pause", "resume", "counts", "unsure"] as const) {
    assertEquals(parseUpdateArgs([name]), name);
  }
});

Deno.test("no subcommand, an unknown one, or anything after it is refused", () => {
  assertThrows(() => parseUpdateArgs([]), Error, "UPDATE_SUBCOMMAND_INVALID");
  assertThrows(
    () => parseUpdateArgs(["drop"]),
    Error,
    "UPDATE_SUBCOMMAND_INVALID",
  );
  assertThrows(
    () => parseUpdateArgs(["pause", "--force"]),
    Error,
    "UPDATE_ARGUMENT_INVALID",
  );
});

Deno.test("each refusal of a pause has its own exit code, matching the launcher", () => {
  // scripts/deploy/release.mjs maps these three codes back to the words.
  assertEquals(UPDATE_REFUSAL_EXIT_CODES, {
    DRAIN_TIMEOUT: 74,
    INSTALLATION_RESTORING: 75,
    MAINTENANCE_HELD: 76,
  });
});
