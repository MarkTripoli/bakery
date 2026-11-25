import type { Meta, StoryObj } from "@storybook/react-vite";
import { DetailRow, HelpTip } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/DetailRow",
  parameters: { catalogId: "ui.detailRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <DetailRow label="Role" tone="code">payments-api</DetailRow>
      <DetailRow label="Alias" tone="code">contract, ledger</DetailRow>
      <DetailRow label="Mapping status" tone="positive">Active</DetailRow>
      <DetailRow label="Branch">main</DetailRow>
      <DetailRow label="Typical time" stackOnPhone>
        22 h
      </DetailRow>
      {/* A long label with its help button: the wide column keeps them on one line. */}
      <DetailRow
        label={
          <>
            Tools it may use
            <HelpTip closeLabel="Close" label="Tools it may use">
              What this agent is allowed to do in a repository.
            </HelpTip>
          </>
        }
        labelWidth="wide"
      >
        repo.read, repo.write
      </DetailRow>
    </>
  ),
};
