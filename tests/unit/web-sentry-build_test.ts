import { assertEquals } from "@std/assert";

// The assertions resolve the real apps/web/vite.config.ts, which imports Vite
// and the Sentry plugin from node_modules, so they run under Node rather than
// Deno. What they prove is that browser reporting and source-map upload are
// separate decisions, and that an instrumented build must declare the second
// one (#353, #523).
Deno.test("web build separates browser reporting from declared source-map upload", async () => {
  const result = await new Deno.Command("node", {
    args: ["--test", "tests/unit/web-sentry-build.node.mjs"],
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
