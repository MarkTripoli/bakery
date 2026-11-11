import type { Meta, StoryObj } from "@storybook/react-vite";
import { RevisionRow, StatusDot } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/RevisionRow",
  parameters: { catalogId: "ui.revisionRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <RevisionRow
        controlLabel="Review this active profile: Revision 3"
        detail="sha256:4be1…9c07"
        onSelect={() => undefined}
        title="Revision 3"
        trailing={
          <StatusDot size="small" tone="success">Active profile</StatusDot>
        }
      />
      <RevisionRow
        detail="sha256:91d0…2a4e"
        title="Revision 2"
        trailing="Oct 9, 2026"
      />
    </>
  ),
};
