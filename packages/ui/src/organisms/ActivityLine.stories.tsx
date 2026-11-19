import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ActivityLine, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/ActivityLine",
  parameters: { catalogId: "ui.activityLine", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

function List({ children }: { children: React.ReactNode }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ul>
  );
}

function Detail({ open }: { open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  return (
    <ActivityLine
      icon="terminal"
      time="11m ago"
      timeTitle="2026-11-18T10:00:00.000Z"
      detail={{
        expanded,
        onToggle: () => setExpanded((value) => !value),
        content: (
          <pre
            style={{
              margin: 0,
              overflowWrap: "anywhere",
              whiteSpace: "pre-wrap",
            }}
          >
            pnpm test upload: 12 passed
          </pre>
        ),
      }}
    >
      Output, 14 lines
    </ActivityLine>
  );
}

/**
 * A sentence-only line, a neutral line with its icon and time, a failure that
 * uses its own icon and full-colour text, and a line that opens detail, closed
 * and open.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Text>Sentence only</Text>
      <List>
        <ActivityLine>1,240 tokens in, 860 out, $0.0042</ActivityLine>
      </List>
      <Text>Neutral</Text>
      <List>
        <ActivityLine
          icon="file"
          time="13m ago"
          timeTitle="2026-11-18T09:58:00.000Z"
        >
          Edited apps/server/src/modules/upload/retry.ts
        </ActivityLine>
      </List>
      <Text>Success and failure</Text>
      <List>
        <ActivityLine icon="check" tone="success" time="12m ago">
          Ran read_file
        </ActivityLine>
        <ActivityLine icon="close" tone="danger" time="12m ago">
          run_tests failed
        </ActivityLine>
      </List>
      <Text>Opens detail</Text>
      <List>
        <Detail open={false} />
        <Detail open />
      </List>
    </Stack>
  ),
};
