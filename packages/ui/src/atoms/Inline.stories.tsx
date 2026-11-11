import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Inline, Stack, StatusBadge, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Inline",
  parameters: { catalogId: "ui.inline", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Inline gap="compact">
        <StatusBadge status="healthy">Healthy</StatusBadge>
        <Text>Compact</Text>
      </Inline>
      <div style={{ inlineSize: "8rem", maxInlineSize: "100%" }}>
        <Inline
          data-semantic-interaction="wrapped"
          gap="standard"
        >
          <StatusBadge status="active">Active</StatusBadge>
          <Text>Standard wrapping</Text>
        </Inline>
      </div>
      <Inline gap="spacious">
        <StatusBadge status="queued">Queued</StatusBadge>
        <Text>Spacious</Text>
      </Inline>
      <Inline variant="split">
        <Text>First column</Text>
        <Text>Second column</Text>
      </Inline>
      <Inline variant="thirds">
        <Text>One</Text>
        <Text>Two</Text>
        <Text>Three</Text>
      </Inline>
      <Inline variant="actions">
        <Button variant="secondary">Cancel</Button>
        <Button>Confirm</Button>
      </Inline>
    </Stack>
  ),
};
