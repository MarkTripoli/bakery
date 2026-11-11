import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inline, StatusLabel } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/StatusLabel",
  parameters: { catalogId: "ui.statusLabel", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Inline>
      <StatusLabel status="healthy">Healthy</StatusLabel>
      <StatusLabel status="active" updating>Updating</StatusLabel>
      <StatusLabel status="queued">Queued</StatusLabel>
      <StatusLabel status="needsInput">Needs input</StatusLabel>
      <StatusLabel status="degraded">Degraded</StatusLabel>
      <StatusLabel status="failed">Failed</StatusLabel>
      <StatusLabel status="disconnected">Disconnected</StatusLabel>
      <StatusLabel status="disabled">Disabled</StatusLabel>
    </Inline>
  ),
};
