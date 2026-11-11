import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inline, StatusBadge } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/StatusBadge",
  parameters: { catalogId: "ui.statusBadge", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Inline>
      <StatusBadge status="online-preview">Online</StatusBadge>
      <StatusBadge status="offline-preview">Offline</StatusBadge>
      <StatusBadge status="healthy">Healthy</StatusBadge>
      <StatusBadge status="queued">Queued</StatusBadge>
      <StatusBadge status="active">Active</StatusBadge>
      <StatusBadge status="needsInput">Needs input</StatusBadge>
      <StatusBadge status="degraded">Degraded</StatusBadge>
      <StatusBadge status="failed">Failed</StatusBadge>
      <StatusBadge status="disconnected">Disconnected</StatusBadge>
      <StatusBadge status="disabled">Disabled</StatusBadge>
    </Inline>
  ),
};
