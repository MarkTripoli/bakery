import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconGlyph, StepCard, StepConnector } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StepConnector",
  parameters: { catalogId: "ui.stepConnector", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * The connector between two cards: one pixel of line with a small round "+" on
 * it. The drawn circle is 22px and its hit area 44px, which is why the two are
 * separate declarations — an approved value, not a nearest token.
 */
export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: "16px", maxWidth: "360px" }}>
      <StepCard
        icon={<IconGlyph name="terminal" size="small" />}
        title="Implement"
        summary="A coding agent makes the change in the repository."
      />
      <StepConnector label="Add a step after Implement" />
      <StepCard
        icon={<IconGlyph name="check" size="small" />}
        title="Run checks"
        summary="Runs the repository's lint, tests and build."
      />
    </div>
  ),
};
