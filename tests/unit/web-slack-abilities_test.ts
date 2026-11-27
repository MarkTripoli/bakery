import { assertEquals } from "@std/assert";
import { SLACK_BOT_SCOPES } from "../../packages/integration-slack/src/server/mod.ts";
import {
  SLACK_ABILITIES,
  slackAbilities,
} from "../../apps/web/src/pages/integrations/providers/slack/abilities.ts";

const unavailable = (names: readonly string[]) =>
  slackAbilities(names).missing.map((ability) =>
    ability.sentence.split(".").at(-1)
  );

Deno.test("every scope Bakery asks Slack for leaves nothing unavailable", () => {
  assertEquals(unavailable(SLACK_BOT_SCOPES), []);
});

Deno.test("the abilities name exactly the scopes Bakery asks for", () => {
  assertEquals(
    SLACK_ABILITIES.flatMap((ability) => ability.scopes).sort(),
    [...SLACK_BOT_SCOPES].sort(),
  );
});

Deno.test("an ability is claimed only when every scope behind it was granted", () => {
  assertEquals(unavailable(["chat:write", "channels:read"]), [
    "mentions",
    "replies",
    "commands",
    "messages",
  ]);
  assertEquals(
    slackAbilities(["im:write"]).available,
    [],
  );
});
