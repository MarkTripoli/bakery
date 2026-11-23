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
      <EmptyState
        title="No updates yet"
        description="This card spans the whole column instead of stopping at the content width."
        span="column"
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

const StartAlignedStory: StoryObj = {
  render: () => (
    <EmptyState
      layout="centered"
      align="start"
      titleStyle="heading"
      title="This page was not found"
      description="It may not exist, or you may not have access to it."
    />
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {CenteredStory.render?.(args, context)}
      {StartAlignedStory.render?.(args, context)}
    </>
  ),
};
