import type { Meta, StoryObj } from "@storybook/react-vite";
import { DetailRow } from "@bakery/ui";

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
    </>
  ),
};
