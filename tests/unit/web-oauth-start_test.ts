import { assertEquals } from "@std/assert";
import { startFor } from "../../apps/web/src/pages/integrations/providers/start-for.ts";

Deno.test("another provider's slug does not start the Slack flow", () => {
  const started: string[] = [];
  for (const slug of ["linear", "github", "", "slack-enterprise"]) {
    startFor("slack", slug, () => started.push(slug));
  }
  assertEquals(started, []);
});

Deno.test("the Slack slug starts the Slack flow once", () => {
  const started: string[] = [];
  startFor("slack", "slack", () => started.push("slack"));
  assertEquals(started, ["slack"]);
});
