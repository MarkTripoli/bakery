import { assertEquals } from "@std/assert";
import { isPostgresUniqueViolation } from "../../apps/server/src/platform/postgres-errors.ts";

Deno.test("isPostgresUniqueViolation finds a unique-violation nested in a cause chain", () => {
  const driverError = { code: "23505" };
  const wrapped = { cause: { cause: driverError } };
  assertEquals(isPostgresUniqueViolation(wrapped), true);
});

Deno.test("isPostgresUniqueViolation rejects an unrelated SQLSTATE", () => {
  const wrapped = { cause: { cause: { code: "23503" } } };
  assertEquals(isPostgresUniqueViolation(wrapped), false);
});

Deno.test("isPostgresUniqueViolation rejects a non-object error", () => {
  assertEquals(isPostgresUniqueViolation("boom"), false);
  assertEquals(isPostgresUniqueViolation(null), false);
  assertEquals(isPostgresUniqueViolation(undefined), false);
});
