import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { PaperSidebar } from "../examples/shell-example.tsx";

const meta = {
  title: "Bakery/Organisms/SidebarNav",
  parameters: { catalogId: "ui.sidebarNav", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div className="gallery-sidebar-example">
      <PaperSidebar variant="labelled" />
      <PaperSidebar labelSuffix=", compact" variant="compact" />
      <PaperSidebar labelSuffix=", drawer" variant="drawer" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [work] = canvas.getAllByRole("link", { name: "Work" });
    await expect(work).toHaveAttribute("aria-current", "page");
    // Unshipped destinations are inert text, never a dead link.
    await expect(canvas.queryAllByRole("link", { name: /Applications/ }))
      .toHaveLength(0);
  },
};
