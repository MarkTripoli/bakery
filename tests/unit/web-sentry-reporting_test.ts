import { assertEquals } from "@std/assert";

// The assertions drive the real browser SDK, option set and query client from
// apps/web, whose dependencies live in its node_modules, so they run under
// Node rather than Deno. A fake transport records what would leave the browser
// when the API is unreachable: one event per failed query or mutation, named
// by its operation, carrying no input, and sent once when the same failure
// repeats.
Deno.test("browser data-layer failures reach Sentry named, private and deduplicated", async () => {
  const result = await new Deno.Command("node", {
    args: ["--test", "tests/unit/web-sentry-reporting.node.mjs"],
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
