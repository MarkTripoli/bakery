import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  IconGlyph,
  PaneSection,
  RunTimeline,
  SessionPane,
  Stack,
  StatusDot,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/SessionPane",
  parameters: { catalogId: "ui.sessionPane", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const header = (
  <>
    <IconGlyph name="terminal" />
    <Text>Current run</Text>
    <StatusDot tone="information">Running</StatusDot>
  </>
);

const BaseContract: StoryObj = {
  render: () => (
    <Stack>
      <SessionPane
        label="Current run"
        header={header}
        footer={
          <>
            <Button variant="outline">Request pause</Button>
            <Button>Request cancellation</Button>
          </>
        }
      >
        <RunTimeline
          label="Run steps"
          variant="steps"
          events={[
            {
              id: "1",
              title: "Select the repository",
              description: "Completed",
              status: "complete",
            },
            {
              id: "2",
              title: "Verify the environment",
              description: "Running",
              status: "active",
            },
            {
              id: "3",
              title: "Queue the first task",
              description: "Pending",
              status: "queued",
            },
          ]}
        />
      </SessionPane>
      <SessionPane label="Run loading" header={header} state="loading">
        <Text>Loading…</Text>
      </SessionPane>
      <SessionPane label="No run" header={header} state="empty">
        <Text>Run execution is not available from this screen.</Text>
      </SessionPane>
    </Stack>
  ),
};

const SectionsStory: StoryObj = {
  render: () => (
    <SessionPane
      label="Plan"
      layout="sections"
      header={
        <>
          <IconGlyph name="plan" />
          <Text>Plan</Text>
          <Text variant="hint">Plan, version 2</Text>
        </>
      }
      footer={<Button>Approve plan, version 2</Button>}
    >
      <PaneSection ruled title="Participants (2)">
        <Text>Priya Raman (you)</Text>
        <Text>Dana Okafor</Text>
      </PaneSection>
      <PaneSection>
        <Text>Shared checkout onboarding</Text>
      </PaneSection>
    </SessionPane>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {SectionsStory.render?.(args, context)}
    </>
  ),
};
