import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccessCard, Avatar, Badge, Inline, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/AccessCard",
  parameters: { catalogId: "ui.accessCard", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <AccessCard
      description="Organization role · Managed by an admin"
      leading={<Avatar alt="Alex Morgan" size="large" />}
      title="Developer"
      trailing={<Badge tone="success">Active</Badge>}
    >
      <Inline gap="compact">
        <Badge>Read issues</Badge>
        <Badge>Create issue comments</Badge>
      </Inline>
      <Text variant="hint">No other actions or repositories are included.</Text>
    </AccessCard>
  ),
};
