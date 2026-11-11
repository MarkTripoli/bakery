import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState, IconGlyph, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/EmptyState",
  parameters: { catalogId: "ui.emptyState", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => (
    <Stack>
      <EmptyState
        title="Start your first task"
        description="New tasks will appear here."
        variant="firstUse"
      />
      <EmptyState
        title="No tasks match"
        description="Try a broader search."
        variant="filtered"
      />
      <EmptyState
        title="Everything is complete"
        description="There is nothing left to review."
        variant="complete"
      />
    </Stack>
  ),
};

const CenteredStory: StoryObj = {
  render: () => (
    <EmptyState
      layout="centered"
      icon={<IconGlyph name="chat" size="large" />}
      title="No messages yet. Say what you want done, or ask the agent to plan it."
    />
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {CenteredStory.render?.(args, context)}
    </>
  ),
};
