import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { boundedPostgresMutation } from "../../apps/server/src/platform/bounded-mutation.ts";
import { isPostgresForeignKeyRefusal } from "../../apps/server/src/platform/postgres-errors.ts";

const postgresError = (code: string) =>
  Object.assign(new Error("database refused"), { code });

const refusedAs = async (
  code: string,
  options?: Parameters<typeof boundedPostgresMutation>[1],
) =>
  (await assertRejects(
    () =>
      boundedPostgresMutation(
        () => Promise.reject(postgresError(code)),
        options,
      ),
    StandardError,
  )).code;

Deno.test("a delete refused by a RESTRICT foreign key on PostgreSQL 18 (23001) answers 422 like 16's 23503 (#1009)", async () => {
  for (const code of ["23001", "23503", "22001", "22P02", "23502"]) {
    assertEquals(await refusedAs(code), "UNPROCESSABLE", code);
  }
  assertEquals(await refusedAs("23505"), "STATE_CONFLICT");
  await assertRejects(
    () => boundedPostgresMutation(() => Promise.reject(postgresError("23514"))),
    Error,
    "database refused",
  );
  assertEquals(
    await refusedAs("23514", { checkViolationIsUnprocessable: true }),
    "UNPROCESSABLE",
  );
});

Deno.test("only 23503 and 23001 read as a refused reference (#1009)", () => {
  assertEquals(isPostgresForeignKeyRefusal(postgresError("23503")), true);
  assertEquals(isPostgresForeignKeyRefusal(postgresError("23001")), true);
  assertEquals(isPostgresForeignKeyRefusal(postgresError("23505")), false);
  assertEquals(isPostgresForeignKeyRefusal(new Error("no code")), false);
});

Deno.test("no server module names a foreign-key refusal code itself, so none can miss 23001 (#1009)", async () => {
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (
        entry.name.endsWith(".ts") &&
        !path.endsWith("platform/postgres-errors.ts") &&
        /"23503"|'23503'|"23001"|'23001'/.test(await Deno.readTextFile(path))
      ) offenders.push(path);
    }
  };
  await walk("apps/server/src");
  assert(offenders.length === 0, offenders.join(", "));
});
