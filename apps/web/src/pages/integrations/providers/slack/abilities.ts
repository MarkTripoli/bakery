import type { MessageKey } from "@bakery/i18n";

export type SlackAbility = Readonly<{
  sentence: MessageKey;
  resource: string;
  writes?: true;
  scopes: readonly string[];
}>;

export const SLACK_ABILITIES: readonly SlackAbility[] = [
  {
    sentence: "integrations.slack.can.channels",
    resource: "channels",
    scopes: ["channels:read"],
  },
  {
    sentence: "integrations.slack.can.post",
    resource: "chat",
    writes: true,
    scopes: ["chat:write"],
  },
  {
    sentence: "integrations.slack.can.mentions",
    resource: "app_mentions",
    scopes: ["app_mentions:read"],
  },
  {
    sentence: "integrations.slack.can.replies",
    resource: "channels",
    scopes: ["channels:history"],
  },
  {
    sentence: "integrations.slack.can.commands",
    resource: "commands",
    scopes: ["commands"],
  },
  {
    sentence: "integrations.slack.can.messages",
    resource: "im",
    writes: true,
    scopes: ["im:history", "im:read", "im:write"],
  },
];

export function slackAbilities(granted: unknown) {
  const held = new Map(
    granted !== null && typeof granted === "object"
      ? Object.entries(granted)
      : [],
  );
  const given = (ability: SlackAbility) =>
    ability.writes
      ? held.get(ability.resource) === "write"
      : held.has(ability.resource);
  return {
    available: SLACK_ABILITIES.filter(given),
    missing: SLACK_ABILITIES.filter((ability) => !given(ability)),
  };
}
