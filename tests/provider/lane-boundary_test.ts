import { assert, assertEquals, assertFalse } from "@std/assert";

const queryRun = (command: string) =>
  Deno.permissions.querySync({ name: "run", command }).state;

const realCliOptIn =
  (Deno.env.get("BAKERY_PROVIDER_REAL_CLI") ?? "").trim().length > 0;

Deno.test({
  name: "provider lane holds restricted run grants and no network" +
    (realCliOptIn
      ? " [skipped: BAKERY_PROVIDER_REAL_CLI widens the grants]"
      : ""),
  ignore: realCliOptIn,
  fn: () => {
    assertFalse(
      Deno.permissions.querySync({ name: "run" }).state === "granted",
      "bare --allow-run would hide an unexpected host binary",
    );
    assertEquals(queryRun("/usr/bin/setsid"), "granted");
    assertEquals(queryRun("/usr/bin/kill"), "granted");
    assertFalse(
      Deno.permissions.querySync({ name: "net" }).state === "granted",
      "provider lane must not hold --allow-net",
    );
  },
});

Deno.test("ci.yml never opts the provider lane into real CLIs", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/ci.yml");
  assertFalse(workflow.includes("BAKERY_PROVIDER_REAL_CLI"));
  assert(workflow.includes("pnpm test:provider"));
});
