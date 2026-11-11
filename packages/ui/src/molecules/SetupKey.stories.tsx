import type { Meta, StoryObj } from "@storybook/react-vite";
import { SetupKey } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/SetupKey",
  parameters: { catalogId: "ui.setupKey", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => <SetupKey>JBSW Y3DP EHPK 3PXP</SetupKey>,
};
