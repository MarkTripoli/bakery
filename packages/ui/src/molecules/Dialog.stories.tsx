import type { Meta, StoryObj } from "@storybook/react-vite";
import { DialogExample } from "../examples/story-helpers.tsx";

const meta = {
  title: "Bakery/Molecules/Dialog",
  parameters: { catalogId: "ui.dialog", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <DialogExample kind="dialog" variant="information" />
      <DialogExample kind="dialog" state="open" variant="form" />
      <DialogExample kind="dialog" state="submitting" variant="information" />
      <DialogExample kind="dialog" state="error" variant="form" />
    </>
  ),
};
