import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, QuestionCard, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/QuestionCard",
  parameters: { catalogId: "ui.questionCard", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <Stack>
        <QuestionCard
          title="Which environment should this use?"
          status={open ? "open" : "answered"}
          variant="singleChoice"
          answer={open ? undefined : "Development"}
        >
          <Button onClick={() => setOpen(false)}>Use development</Button>
        </QuestionCard>
        <QuestionCard
          title="Which checks should run?"
          status="answered"
          variant="multipleChoice"
          answer="Unit and browser"
        >
          <Text>Select all that apply.</Text>
        </QuestionCard>
        <QuestionCard
          title="What should reviewers know?"
          status="expired"
          variant="text"
        >
          <Text>The response window has closed.</Text>
        </QuestionCard>
        <QuestionCard
          title="This answer changed"
          status="conflict"
          variant="text"
        >
          <Text>Resolve the conflicting response before continuing.</Text>
        </QuestionCard>
      </Stack>
    );
  },
};

const PaneStory: StoryObj = {
  render: () => (
    <QuestionCard
      layout="pane"
      eyebrow="Question from the agent"
      statusLabel="Needs input"
      title="Which repository should publish the webhook contract?"
      description="Your answer will resume this task."
      actions={<Button>Send answer</Button>}
    >
      <Text>northwind/payments</Text>
      <Text>northwind/web</Text>
    </QuestionCard>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {PaneStory.render?.(args, context)}
    </>
  ),
};
