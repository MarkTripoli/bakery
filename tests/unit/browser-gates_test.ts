import { assertEquals } from "@std/assert";

Deno.test("browser selection, core reporter and workflow coverage contract", async () => {
  const result = await new Deno.Command("node", {
    args: [
      "--test",
      "tests/unit/browser-gates.node.mjs",
      "tests/unit/browser-workflow.node.mjs",
      "tests/unit/browser-ordering.node.mjs",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    result.code,
    0,
    new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  );
});
