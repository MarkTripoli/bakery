import type { Meta, StoryObj } from "@storybook/react-vite";
import { TabExample } from "../examples/story-helpers.tsx";

const meta = {
  title: "Bakery/Molecules/Tabs",
  parameters: { catalogId: "ui.tabs", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <TabExample label="Task views" state="default" />
      <TabExample label="Project views" state="selected" />
      <TabExample label="Route views" state="selected" variant="route" />
      <TabExample label="Focused views" state="focus" />
      <TabExample label="Disabled views" state="disabled" disabled />
    </>
  ),
};
