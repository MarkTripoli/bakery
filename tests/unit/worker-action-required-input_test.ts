import { assertEquals } from "@std/assert";
import { registeredWorkerActionInputSchema } from "../../packages/contracts/src/contracts.ts";

const installId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

Deno.test("a required input field may not be left out", () => {
  const schema = registeredWorkerActionInputSchema("plugin.job");
  assertEquals(
    schema.safeParse({ installId, entry: "main.js" }).success,
    false,
  );
});

Deno.test("a required input field that is present must still be valid", () => {
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
