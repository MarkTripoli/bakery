import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunIdentity, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/RunIdentity",
  parameters: { catalogId: "ui.runIdentity", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <RunIdentity
        title="Execution identity"
        worker="atlas-01"
        attempt="Try 2"
        lease="Lease active"
        detail="Codex · trusted worker record · run_42 / step_3"
        unknownLabel="Unknown"
      />
      <RunIdentity
        title="Execution identity unavailable"
        worker={null}
        attempt={null}
        lease={null}
        detail="No trusted worker record is available."
        unknownLabel="Unknown"
      />
    </Stack>
  ),
};
