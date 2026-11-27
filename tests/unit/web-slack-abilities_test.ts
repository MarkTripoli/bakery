import { assertEquals } from "@std/assert";
import { grantedScopes } from "../../apps/server/src/modules/integrations/oauth2-connect.ts";
import { SLACK_BOT_SCOPES } from "../../packages/integration-slack/src/server/mod.ts";
import {
  SLACK_ABILITIES,
  slackAbilities,
} from "../../apps/web/src/pages/integrations/providers/slack/abilities.ts";

const stored = (scopes: readonly string[]) =>
  grantedScopes({ scopes: SLACK_BOT_SCOPES } as never, {
    scope: scopes.join(","),
  } as never);

Deno.test("every scope Bakery asks Slack for leaves nothing unavailable", () => {
  assertEquals(slackAbilities(stored(SLACK_BOT_SCOPES)).missing, []);
});

Deno.test("the abilities name exactly the scopes Bakery asks for", () => {
  assertEquals(
    SLACK_ABILITIES.flatMap((ability) => ability.scopes).sort(),
    [...SLACK_BOT_SCOPES].sort(),
  );
});

Deno.test("a grant without posting or direct messages says so", () => {
  const missing = slackAbilities(
    stored(["channels:read", "commands", "app_mentions:read", "im:read"]),
  ).missing.map((ability) => ability.resource);
  assertEquals(missing, ["chat", "im"]);
});
