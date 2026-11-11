import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, StatusDot, TaskQueue, type TaskQueueGroup } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/TaskQueue",
  parameters: { catalogId: "ui.taskQueue", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const labels = {
  caption: "Work queue",
  task: "Task",
  application: "Application",
  stage: "Stage",
  harness: "Harness",
  age: "Age",
};

const groups: TaskQueueGroup[] = [
  {
    id: "needs-input",
    label: "Needs input 1",
    rows: [{
      id: "bkry-104",
      reference: "BKRY-104",
      title: "Add repository onboarding",
      href: "#bkry-104",
      application: "Bakery",
      stage: <StatusDot tone="warning">Needs input</StatusDot>,
      harness: "Codex",
      age: "2m",
    }],
  },
  {
    id: "queued",
    label: "Queued 1",
    defaultCollapsed: true,
    rows: [{
      id: "api-058",
      reference: "API-058",
      title: "Add rate limiting with a deliberately long title that must wrap",
      href: "#api-058",
      application: "Example API",
      stage: <StatusDot tone="neutral">Queued</StatusDot>,
      harness: "Pi",
      age: "41m",
    }],
  },
];

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <TaskQueue
        groups={groups}
        labels={labels}
        onOpen={(event) => event.preventDefault()}
        selectedId="bkry-104"
        variant="table"
      />
      <TaskQueue
        groups={groups}
        labels={labels}
        onOpen={(event) => event.preventDefault()}
        variant="list"
      />
    </Stack>
  ),
};
