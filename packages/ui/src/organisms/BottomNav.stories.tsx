import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { BottomNav, IconGlyph } from "@bakery/ui";
import { paperPhoneDestinations } from "../examples/shell-example.tsx";

const meta = {
  title: "Bakery/Organisms/BottomNav",
  parameters: { catalogId: "ui.bottomNav", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div className="gallery-stack-example">
      <BottomNav
        currentPath="/"
        items={paperPhoneDestinations}
        label="Primary"
        more={{
          expanded: false,
          icon: <IconGlyph name="menu" />,
          label: "More",
          onSelect: () => undefined,
        }}
        onNavigate={(event) => event.preventDefault()}
        state="selected"
      />
      <BottomNav
        currentPath="/elsewhere"
        items={paperPhoneDestinations}
        label="Primary, nothing selected"
        note="Synthetic example data"
        onNavigate={(event) => event.preventDefault()}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [work] = canvas.getAllByRole("link", { name: "Work" });
    await expect(work).toHaveAttribute("aria-current", "page");
    await expect(canvas.queryAllByRole("link", { name: /Apps/ }))
      .toHaveLength(0);
  },
};
