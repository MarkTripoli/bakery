import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunTimeline, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/RunTimeline",
  parameters: { catalogId: "ui.runTimeline", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <p>
        Fixture — durable state presentation only; events do not create terminal
        truth.
      </p>
      <RunTimeline
        label="Detailed run progress"
        variant="detailed"
        events={[
          { id: "1", title: "Task queued", status: "queued" },
          {
            id: "2",
            title: "Building components",
            status: "active",
          },
          { id: "3", title: "Waiting for review", status: "waiting" },
          {
            id: "4",
            title: "Review failed",
            status: "failed",
          },
          { id: "5", title: "Run complete", status: "complete" },
          {
            id: "6",
            title: "Canceled branch",
            description:
              "The server winner is unknown in this fixture; no success is inferred.",
            status: "canceled",
          },
        ]}
      />
      <RunTimeline
        connectivity="reconnecting"
        connectivityLabel="Reconnecting. Missed events are read again from the server."
        label="Run-level progress"
        variant="detailed"
        events={[
          {
            id: "run-queued",
            scope: "run",
            status: "queued",
            time: "10:21",
            title: "Run queued",
          },
          {
            id: "run-blocked",
            reason: "Waiting for task BKRY-103 to finish.",
            scope: "run",
            status: "blocked",
            title: "Run blocked",
          },
          {
            id: "run-terminal",
            scope: "run",
            status: "failed",
            time: "10:30",
            title: "Run failed",
          },
        ]}
      />
      {(["unknown", "offline"] as const).map((connectivity) => (
        <RunTimeline
          connectivity={connectivity}
          connectivityLabel={`Connection ${connectivity}. Showing the last confirmed record.`}
          events={[{ id: "kept", status: "complete", title: "Task brief" }]}
          key={connectivity}
          label={`Run progress while ${connectivity}`}
        />
      ))}
      <RunTimeline
        label="Compact run progress"
        variant="compact"
        events={[{ id: "compact-1", title: "Task active", status: "active" }]}
      />
    </Stack>
  ),
};
