import type { Meta, StoryObj } from "@storybook/react-vite";
import { DialogExample } from "../examples/story-helpers.tsx";

const meta = {
  title: "Bakery/Molecules/Sheet",
  parameters: { catalogId: "ui.sheet", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <DialogExample kind="sheet" variant="bottom" />
      <DialogExample kind="sheet" state="open" variant="side" />
      <DialogExample kind="sheet" state="submitting" variant="bottom" />
      <DialogExample kind="sheet" state="error" variant="side" />
    </>
  ),
};
