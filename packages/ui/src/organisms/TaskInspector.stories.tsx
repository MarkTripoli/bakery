import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Avatar,
  Button,
  RunTimeline,
  Stack,
  StatusDot,
  TaskInspector,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/TaskInspector",
  parameters: { catalogId: "ui.taskInspector", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <TaskInspector
        title="Add repository onboarding"
        reference="BKRY-104"
        status={<StatusDot tone="warning">Needs input</StatusDot>}
        participantsLabel="Participants"
        participants={
          <>
            <Avatar alt="Mark Tripoli" />
            <Avatar alt="Sam Lin" />
          </>
        }
        activity={
          <RunTimeline
            label="Activity"
            variant="activity"
            events={[{
              id: "research",
              title: "Research completed",
              time: "10:32",
              description: "Agent",
            }]}
          />
        }
        actions={<Button variant="secondary">Open task</Button>}
      />
      <TaskInspector state="loading" title="Loading task">
        <Text>Loading…</Text>
      </TaskInspector>
      <TaskInspector state="empty" title="No task selected">
        <Text>Select a task to see its details.</Text>
      </TaskInspector>
    </Stack>
  ),
};
