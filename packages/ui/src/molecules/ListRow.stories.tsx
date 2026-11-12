import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, IconGlyph, ListRow, StatusDot } from "@bakery/ui";

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
        detail="A detail that runs long keeps its first two lines and ends in an ellipsis, with the whole text as its title, so one row never grows without limit however much it has to say."
        detailLines={2}
        title="Northwind long detail"
      />
      <ListRow
        badge={<Badge>Edited</Badge>}
        detail="Require · Locked"
        title="Semantic commits"
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
