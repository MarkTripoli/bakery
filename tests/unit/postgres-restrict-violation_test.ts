import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { boundedMutation } from "../../apps/server/src/modules/catalog/persistence.ts";
import { isPostgresForeignKeyRefusal } from "../../apps/server/src/platform/postgres-errors.ts";

const postgresError = (code: string) =>
  Object.assign(new Error("database refused"), { code });

Deno.test("a delete refused by a RESTRICT foreign key on PostgreSQL 18 (23001) answers 422 like 16's 23503 (#1009)", async () => {
  for (const code of ["23001", "23503"]) {
    const refused = await assertRejects(
      () => boundedMutation(() => Promise.reject(postgresError(code))),
      StandardError,
    );
    assertEquals(refused.code, "UNPROCESSABLE", code);
  }
  const conflict = await assertRejects(
    () => boundedMutation(() => Promise.reject(postgresError("23505"))),
    StandardError,
  );
  assertEquals(conflict.code, "STATE_CONFLICT");
});

Deno.test("only 23503 and 23001 read as a refused reference (#1009)", () => {
  assertEquals(isPostgresForeignKeyRefusal(postgresError("23503")), true);
  assertEquals(isPostgresForeignKeyRefusal(postgresError("23001")), true);
  assertEquals(isPostgresForeignKeyRefusal(postgresError("23505")), false);
  assertEquals(isPostgresForeignKeyRefusal(new Error("no code")), false);
});
