import type { Meta, StoryObj } from "@storybook/react-vite";
import { CanvasFrame } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/CanvasFrame",
  parameters: { catalogId: "ui.canvasFrame", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * The box a workflow diagram is drawn in. `page` is a framed block of a given
 * height; `fill` fits what is left of the window. Both are shown with plain
 * text standing in for the diagram.
 */
export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: "16px", maxWidth: "480px" }}>
      <CanvasFrame height={120} variant="page">
        <p>A page frame, 120px tall.</p>
      </CanvasFrame>
      <CanvasFrame variant="fill">
        <p>A fill frame, as tall as the window leaves it.</p>
      </CanvasFrame>
    </div>
  ),
};
