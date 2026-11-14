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
        lease="Machine is working on it"
        detail="Ran on atlas-01"
        unknownLabel="Unknown"
      />
      <RunIdentity
        title="Execution identity"
        worker="atlas-01"
        attempt="Try 2"
        lease="Machine stopped responding. Bakery took the task back."
        leaseTone="warning"
        detail="Ran on atlas-01"
        unknownLabel="Unknown"
      />
      <RunIdentity
        title="Execution identity unavailable"
        worker={null}
        attempt={null}
        lease={null}
        detail="Bakery cannot tell which machine ran this."
        unknownLabel="Unknown"
      />
    </Stack>
  ),
};
