import { assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertKeysForMove,
  movesDestination,
} from "../../apps/server/src/modules/backups/settings-actions.ts";

// #80 S1b review: the saved key pair belongs to the saved host. Pointing a
// save at another endpoint, region or bucket without both halves again would
// hand that pair to the new host, so it is refused; a folder is not a move.

const stored = {
  endpoint: "https://s3.example.test",
  region: "us-east-1",
  bucket: "bakery-backups",
};
const pair = { accessKeyId: "AKIA", secretAccessKey: "secret" };

Deno.test("a new endpoint, region or bucket is a move; a folder, or nothing, is not", () => {
  assertEquals(movesDestination(stored, stored), false);
  assertEquals(
    movesDestination(stored, { ...stored, endpoint: "https://other.test" }),
    true,
  );
  assertEquals(
    movesDestination(stored, { ...stored, region: "eu-west-1" }),
    true,
  );
  assertEquals(movesDestination(stored, { ...stored, bucket: "other" }), true);
  // Nothing saved yet: there is no pair to carry, so nothing is "moved".
  assertEquals(movesDestination(null, stored), false);
});

Deno.test("a move without the pair is refused naming the access key id, with it is not", () => {
  for (
    const moved of [
      { ...stored, endpoint: "https://other.test" },
      { ...stored, region: "eu-west-1" },
      { ...stored, bucket: "other" },
    ]
  ) {
    const error = assertThrows(
      () => assertKeysForMove(stored, moved, null),
      StandardError,
    );
    assertEquals(error.code, "UNPROCESSABLE");
    const issue = (error.params as {
      issues: { path: string[]; code: string }[];
    }).issues[0];
    assertEquals(issue.path, ["accessKeyId"]);
    assertEquals(issue.code, "credentials_required");
    // The same move with both halves goes through.
    assertKeysForMove(stored, moved, pair);
  }
  // No move: no pair needed.
  assertKeysForMove(stored, stored, null);
  assertKeysForMove(stored, stored, pair);
  // The first save has nothing to move from; its own rule asks for the pair.
  assertKeysForMove(null, stored, null);
});
