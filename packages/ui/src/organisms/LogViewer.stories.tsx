import type { Meta, StoryObj } from "@storybook/react-vite";
import { LogViewer, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/LogViewer",
  parameters: { catalogId: "ui.logViewer", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <LogViewer
        label="Static ready log"
        state="ready"
        variant="static"
        entries={[{
          id: "1",
          timestamp: "2026-09-09T12:00:00Z",
          source: "worker",
          message: "Task started",
        }]}
      />
      <LogViewer
        label="Streaming loading log"
        state="loading"
        variant="streaming"
        entries={[]}
      />
      <LogViewer
        label="Streaming reconnecting log"
        state="reconnecting"
        variant="streaming"
        entries={[]}
      />
      <LogViewer
        label="Streaming paused log"
        state="paused"
        variant="streaming"
        entries={[{
          id: "2",
          timestamp: "2026-09-09T12:00:01Z",
          source: "worker",
          message: "Build paused",
        }]}
      />
      <LogViewer
        label="Streaming error log"
        state="error"
        variant="streaming"
        entries={[]}
      />
    </Stack>
  ),
};
