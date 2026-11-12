import { assertEquals } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { accessLost } from "../../apps/server/src/modules/knowledge/collaboration-socket.ts";

Deno.test("only lost-access problems evict a collaboration participant", () => {
  for (
    const code of [
      "AUTH_REQUIRED",
      "AUTH_INVALID",
      "AUTH_EXPIRED",
      "AUTH_FACTOR_REQUIRED",
      "AUTH_FORBIDDEN",
      "RESOURCE_NOT_FOUND",
    ] as const
  ) {
    assertEquals(accessLost(new StandardError({ code })), true, code);
  }
  for (
    const code of [
      "DEPENDENCY_UNAVAILABLE",
      "DEPENDENCY_TIMEOUT",
      "INTERNAL",
      "RATE_LIMITED",
    ] as const
  ) {
    assertEquals(accessLost(new StandardError({ code })), false, code);
  }
  assertEquals(accessLost(new Error("connection reset")), false);
  assertEquals(accessLost(undefined), false);
});
