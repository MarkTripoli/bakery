import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { PaperShell } from "../examples/shell-example.tsx";

const meta = {
  title: "Bakery/Templates/AppShell",
  parameters: { catalogId: "template.appShell", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * The live shell is the rail profile; the pane and sheet profiles are inert
 * previews so the page keeps one set of landmarks.
 */
export const Contract: StoryObj = {
  render: () => (
    <div className="gallery-shell-example">
      <PaperShell inspector variant="rail" />
      <div inert>
        <PaperShell inspector state="loading" variant="pane" />
      </div>
      <div inert>
        <PaperShell state="error" variant="sheet" />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("main")).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "Skip to content" }))
      .toHaveAttribute("href", "#bakery-main");
    await expect(canvas.getByRole("complementary", { name: "Selected task" }))
      .toBeInTheDocument();
  },
};
