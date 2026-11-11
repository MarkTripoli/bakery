import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, InlineNotice, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/InlineNotice",
  parameters: { catalogId: "ui.inlineNotice", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => {
    const [visible, setVisible] = useState(true);
    return (
      <Stack>
        <InlineNotice
          onDismiss={() => setVisible(false)}
          state={visible ? "default" : "dismissed"}
          tone="neutral"
        >
          No changes are pending.
        </InlineNotice>
        <InlineNotice tone="information">
          Your changes are saved locally.
        </InlineNotice>
        <InlineNotice tone="warning">
          Review the pending workspace change.
        </InlineNotice>
        <InlineNotice tone="error">
          The latest change could not be saved.
        </InlineNotice>
      </Stack>
    );
  },
};

const BarStory: StoryObj = {
  render: () => (
    <Stack>
      <InlineNotice
        layout="bar"
        icon="clock"
        action={<Button variant="quiet">Cancel turn</Button>}
      >
        Agent turn queued. It starts when the earlier turn finishes.
      </InlineNotice>
      <InlineNotice layout="bar" icon="refresh" tone="warning">
        This changed while you were looking. The current state is shown.
      </InlineNotice>
    </Stack>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {BarStory.render?.(args, context)}
    </>
  ),
};
