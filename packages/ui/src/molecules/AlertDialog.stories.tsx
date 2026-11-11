import type { Meta, StoryObj } from "@storybook/react-vite";
import { DialogExample } from "../examples/story-helpers.tsx";

const meta = {
  title: "Bakery/Molecules/AlertDialog",
  parameters: { catalogId: "ui.alertDialog", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <DialogExample kind="alert" variant="destructive" />
      <DialogExample kind="alert" state="open" variant="security" />
      <DialogExample kind="alert" state="confirming" variant="destructive" />
      <DialogExample kind="alert" state="error" variant="security" />
    </>
  ),
};
