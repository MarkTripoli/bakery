import type { Meta, StoryObj } from "@storybook/react-vite";
import { CellStack, IconGlyph } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/CellStack",
  parameters: { catalogId: "ui.cellStack", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <CellStack
        detail="Checkout, catalog and payments services"
        icon={<IconGlyph name="applications" size="medium" />}
        title="Northwind storefront"
      />
      <CellStack title="northwind/payments" />
    </>
  ),
};
