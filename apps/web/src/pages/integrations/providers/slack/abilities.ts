import type { MessageKey } from "@bakery/i18n";

export type SlackAbility = Readonly<{
  sentence: MessageKey;
  scopes: readonly string[];
}>;

export const SLACK_ABILITIES: readonly SlackAbility[] = [
  { sentence: "integrations.slack.can.channels", scopes: ["channels:read"] },
  { sentence: "integrations.slack.can.post", scopes: ["chat:write"] },
  {
    sentence: "integrations.slack.can.mentions",
    scopes: ["app_mentions:read"],
  },
  { sentence: "integrations.slack.can.replies", scopes: ["channels:history"] },
  { sentence: "integrations.slack.can.commands", scopes: ["commands"] },
  {
    sentence: "integrations.slack.can.messages",
    scopes: ["im:history", "im:read", "im:write"],
  },
];

export function slackAbilities(granted: unknown) {
  const held = new Set(
    granted !== null && typeof granted === "object" ? Object.keys(granted) : [],
  );
  const given = (ability: SlackAbility) =>
    ability.scopes.every((scope) => held.has(scope));
  return {
    available: SLACK_ABILITIES.filter(given),
    missing: SLACK_ABILITIES.filter((ability) => !given(ability)),
  };
}
