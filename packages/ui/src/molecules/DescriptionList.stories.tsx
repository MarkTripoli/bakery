import type { Meta, StoryObj } from "@storybook/react-vite";
import { DescriptionItem, DescriptionList, IconGlyph } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/DescriptionList",
  parameters: { catalogId: "ui.descriptionList", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * The rows keep Paper's fixed `.item` geometry (auth.css:8), so below the
 * design's narrowest 390px artboard the list scrolls inside its own port
 * instead of escaping the specimen.
 */
const fixedRowGeometry = { maxInlineSize: "100%", overflowX: "auto" } as const;

export const Contract: StoryObj = {
  render: () => (
    <div style={fixedRowGeometry}>
      <DescriptionList>
        <DescriptionItem
          description="Owner"
          initial="A"
          title="Acme Corporation"
        />
        <DescriptionItem
          description="Member"
          initial="B"
          title="Bakery Demo"
        />
        <DescriptionItem
          action={<IconGlyph name="arrow" size="large" />}
          description="Admin"
          initial="N"
          onSelect={() => {}}
          title="Northwind Labs"
        />
      </DescriptionList>
    </div>
  ),
};
