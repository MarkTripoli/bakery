import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconGlyph, type IconGlyphName, Inline, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/IconGlyph",
  parameters: { catalogId: "ui.iconGlyph", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/** Every glyph in the shared table, in the order `IconGlyphName` declares. */
const glyphs: readonly IconGlyphName[] = [
  "alert",
  "arrow",
  "back",
  "building",
  "check",
  "computer",
  "document",
  "key",
  "lock",
  "mail",
  "person",
  "phone",
  "plug",
  "shield",
  "chevron-down",
  "work-list",
  "applications",
  "terminal",
  "chevron-up",
  "file",
  "monitor",
  "integration",
  "lightning",
  "settings-sun",
  "search",
  "list-search",
  "menu",
  "phone-status",
  "listening",
  "server",
  "laptop",
  "book",
  "plus",
  "chevron-right",
];

const BaseContract: StoryObj = {
  render: () => (
    <Inline gap="spacious">
      {glyphs.map((name) => (
        <Inline gap="compact" key={name}>
          <IconGlyph name={name} size="large" />
          <Text variant="caption">{name}</Text>
        </Inline>
      ))}
    </Inline>
  ),
};

const ConversationGlyphsStory: StoryObj = {
  render: () => (
    <Inline>
      {([
        "clock",
        "refresh",
        "caution",
        "plan",
        "chat",
        "chevron-left",
        "lanes",
      ] as const)
        .map((name) => <IconGlyph key={name} name={name} />)}
    </Inline>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {ConversationGlyphsStory.render?.(args, context)}
    </>
  ),
};
