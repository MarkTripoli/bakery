import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconGlyph, ListRow, StatusDot } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ListRow",
  parameters: { catalogId: "ui.listRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <ListRow
        detail="storefront"
        detailTone="code"
        onSelect={() => undefined}
        selected
        title="Northwind storefront"
        trailing={<StatusDot size="small" tone="success">Active</StatusDot>}
      />
      <ListRow
        detail="trunk · No active profile"
        detailTone="warning"
        onSelect={() => undefined}
        title="northwind/e2e"
        trailing={<IconGlyph name="chevron-right" size="small" />}
      />
      <ListRow
        detail="Revision 7 · enforced"
        size="tall"
        title="northwind/payments"
        trailing={<StatusDot size="small" tone="success">Active</StatusDot>}
      />
    </>
  ),
};
