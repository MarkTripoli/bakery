import { assertEquals } from "@std/assert";
import { registeredWorkerActionInputSchema } from "../../packages/contracts/src/contracts.ts";

// A worker action input field typed `uuid?` may be left out. plugin.job names
// the plugin version it runs in `versionId`, and a job without one runs the
// install's current version (#34), so the worker's parser must accept both.

const installId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

Deno.test("an optional input field may be left out", () => {
  const schema = registeredWorkerActionInputSchema("plugin.job");
  assertEquals(schema.safeParse({ installId, entry: "main.js" }).success, true);
});

Deno.test("an optional input field that is present must still be valid", () => {
  const schema = registeredWorkerActionInputSchema("plugin.job");
  assertEquals(
    schema.safeParse({ installId, entry: "main.js", versionId }).success,
    true,
  );
  assertEquals(
    schema.safeParse({ installId, entry: "main.js", versionId: "nope" })
      .success,
    false,
  );
});

Deno.test("a required field is still required", () => {
  const schema = registeredWorkerActionInputSchema("plugin.job");
  assertEquals(schema.safeParse({ entry: "main.js" }).success, false);
});
