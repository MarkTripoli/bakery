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
  for (
    const name of ["pause", "resume", "counts", "unsure", "policy"] as const
  ) {
    assertEquals(parseUpdateArgs([name]), { name });
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

const ID = "3f2c1b9e-7a64-4c1d-9d0e-5b2a1c3d4e5f";
const FROM = "b".repeat(40), TO = "a".repeat(40);
const AT = "2026-11-21T14:11:09.000Z";

Deno.test("record takes exactly an id, a kind, a user, an ISO time, two releases and a detail", () => {
  const parsed = parseUpdateArgs([
    "record",
    ID,
    "decided_go_back",
    "mark",
    AT,
    FROM,
    TO,
    "-",
  ]);
  assertEquals(parsed.name, "record");
  if (parsed.name !== "record") throw new Error("unreachable");
  assertEquals(parsed.event.kind, "decided_go_back");
  assertEquals(parsed.event.byName, "mark");
  assertEquals(parsed.event.occurredAt.toISOString(), AT);
  assertEquals(parsed.event.fromRelease, FROM);
  assertEquals(parsed.event.toRelease, TO);
  assertEquals(parsed.event.detail, null);
});

Deno.test("a dash means none: Bakery's own going back has no user, a refusal has a detail and one release", () => {
  const parsed = parseUpdateArgs([
    "record",
    ID,
    "refused",
    "-",
    AT,
    "-",
    TO,
    "This release could not be verified, so nothing was changed.",
  ]);
  if (parsed.name !== "record") throw new Error("unreachable");
  assertEquals(parsed.event.byName, null);
  assertEquals(parsed.event.fromRelease, null);
  assertEquals(parsed.event.toRelease, TO);
  assertEquals(
    parsed.event.detail,
    "This release could not be verified, so nothing was changed.",
  );
});

Deno.test("record refuses every malformed value before the database is opened", () => {
  const good = [ID, "updated", "mark", AT, FROM, TO, "-"];
  const bad: Array<[number, string]> = [
    [0, "not-a-uuid"],
    [1, "maybe"],
    [2, "mark; drop"],
    [2, ""],
    [3, "yesterday"],
    [3, "2026-11-21T14:11:09Z"],
    [4, "abc"],
    [5, "G".repeat(40)],
    [6, "two\nlines"],
    [6, "x".repeat(201)],
    [6, ""],
  ];
  for (const [index, value] of bad) {
    const args = [...good];
    args[index] = value;
    assertThrows(
      () => parseUpdateArgs(["record", ...args]),
      Error,
      "UPDATE_ARGUMENT_INVALID",
    );
  }
  assertThrows(
    () => parseUpdateArgs(["record", ...good.slice(0, 6)]),
    Error,
    "UPDATE_ARGUMENT_INVALID",
  );
  assertThrows(
    () => parseUpdateArgs(["record", ...good, "extra"]),
    Error,
    "UPDATE_ARGUMENT_INVALID",
  );
});
