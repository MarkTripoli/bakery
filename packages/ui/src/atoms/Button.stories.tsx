import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Inline, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Button",
  parameters: { catalogId: "ui.button", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => {
    const [count, setCount] = useState(0);
    const [pressed, setPressed] = useState(false);
    const action = () => setCount((current) => current + 1);
    return (
      <Stack>
        <Inline>
          <Button onClick={action}>Run preview</Button>
          <Button variant="secondary" onClick={action}>Secondary</Button>
          <Button variant="outline" onClick={action}>Outline</Button>
          <Button variant="quiet" onClick={action}>Quiet</Button>
          <Button variant="text" onClick={action}>Text</Button>
          <Button variant="destructive" onClick={action}>Destructive</Button>
          <Button data-semantic-interaction="hover" onClick={action}>
            Hover
          </Button>
          <Button
            aria-pressed={pressed}
            data-semantic-interaction="pressed"
            state={pressed ? "pressed" : "default"}
            onClick={() => setPressed(true)}
          >
            Press
          </Button>
          <Button autoFocus data-semantic-interaction="focus" onClick={action}>
            Focus
          </Button>
          <Button loading disabled={false}>Working</Button>
          <Button busy>Busy</Button>
          <Button disabled>Disabled</Button>
        </Inline>
        <Text>Prototype only · noninteractive control representations</Text>
        <Inline>
          <Button variant="preview-primary">Primary preview</Button>
          <Button variant="preview-secondary">Secondary preview</Button>
        </Inline>
        <Inline>
          <Button variant="preview-primary" density="standard">
            Standard primary preview
          </Button>
          <Button variant="preview-secondary" density="standard">
            Standard secondary preview
          </Button>
        </Inline>
        <Button variant="preview-primary" density="static-compact">
          Compact primary static preview
        </Button>
        <Button variant="preview-secondary" density="static-compact">
          Compact static preview
        </Button>
        <Text role="status">{count} preview actions</Text>
      </Stack>
    );
  },
};

const DestructiveQuietStory: StoryObj = {
  render: () => (
    <Inline>
      <Button variant="destructive-outline">Reject</Button>
      <Button variant="destructive-quiet">Cancel plan</Button>
    </Inline>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {DestructiveQuietStory.render?.(args, context)}
    </>
  ),
};
