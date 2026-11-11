import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inline, StatusDot } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/StatusDot",
  parameters: { catalogId: "ui.statusDot", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => (
    <Inline>
      <StatusDot tone="warning">Needs input</StatusDot>
      <StatusDot tone="information">Implementing</StatusDot>
      <StatusDot tone="neutral">Queued</StatusDot>
      <StatusDot tone="success">1 worker ready</StatusDot>
      <StatusDot tone="destructive">Failed</StatusDot>
    </Inline>
  ),
};

const SizesStory: StoryObj = {
  render: () => (
    <>
      <StatusDot size="small" tone="success">Completed</StatusDot>
      <StatusDot size="strong" tone="information">In progress</StatusDot>
    </>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {SizesStory.render?.(args, context)}
    </>
  ),
};
