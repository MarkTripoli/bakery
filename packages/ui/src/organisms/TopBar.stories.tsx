import type { Meta, StoryObj } from "@storybook/react-vite";
import { TopBar } from "@bakery/ui";
import { PaperTopBar } from "../examples/shell-example.tsx";

const meta = {
  title: "Bakery/Organisms/TopBar",
  parameters: { catalogId: "ui.topBar", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => (
    <div className="gallery-stack-example">
      <PaperTopBar variant="bar" />
      <PaperTopBar onMenu={() => undefined} variant="title" />
    </div>
  ),
};

const CompactStory: StoryObj = {
  render: () => (
    <TopBar
      variant="compact"
      leading={<span>Back to task</span>}
      actions={<span>Cancel plan</span>}
    />
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {CompactStory.render?.(args, context)}
    </>
  ),
};
