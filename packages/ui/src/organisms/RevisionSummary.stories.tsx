import type { Meta, StoryObj } from "@storybook/react-vite";
import { RevisionSummary, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/RevisionSummary",
  parameters: { catalogId: "ui.revisionSummary", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <RevisionSummary
        title="Changes"
        baseRevision="8ac02e1"
        candidateRevision="5d138ac"
        summary="3 files · +84 −12"
        disclaimer="Observed repository state. No review or merge decision recorded."
        unknownLabel="Unknown"
        diffLink={{ href: "#diff", label: "View diff" }}
      />
      <RevisionSummary
        title="Changes unavailable"
        baseRevision={null}
        candidateRevision={null}
        summary={null}
        disclaimer="No repository observation is available."
        unknownLabel="Unknown"
      />
    </Stack>
  ),
};
