import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, DescriptionItem, IconGlyph } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/DescriptionItem",
  parameters: { catalogId: "ui.descriptionItem", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * Paper's `.item` (auth.css:8) is a fixed row: a 36px leading box, the
 * stacked title and description, and a trailing affordance that never
 * shrinks — the artboards it comes from are never narrower than 390px. Below
 * that the row scrolls inside its own port rather than escaping the
 * specimen, which is what the reflow rail asks of two-dimensional content.
 */
const fixedRowGeometry = { maxInlineSize: "100%", overflowX: "auto" } as const;

export const Contract: StoryObj = {
  render: () => (
    <div style={fixedRowGeometry}>
      <DescriptionItem
        action={<Badge tone="success">Current</Badge>}
        description="Chrome on macOS · Seattle"
        icon={<IconGlyph name="computer" size="large" />}
        title="This device"
      />
      <DescriptionItem
        description="alex@example.com"
        icon={<IconGlyph name="mail" size="large" />}
        title="Email and password"
      />
      <DescriptionItem
        action={<Badge tone="neutral">Not checked</Badge>}
        actionPlacement="below"
        description="Its action sits under the text on a phone."
        title="Action below on a phone"
      />
      <DescriptionItem
        action={<IconGlyph name="arrow" size="large" />}
        description="Owner"
        initial="A"
        onSelect={() => {}}
        title="Acme Corporation"
      />
    </div>
  ),
};
