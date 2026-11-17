import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconGlyph, StepCard, StepConnector } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StepCard",
  parameters: { catalogId: "ui.stepCard", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * Every state of a card in the workflow diagram: ordinary, selected, one the
 * editor could not read, and the connector that carries the "+" between cards.
 * The drawn circle is 22px and its hit area 44px, which is why the two are
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
      <StepCard
        icon={<IconGlyph name="shield" size="small" />}
        title="Review"
        summary="A separate agent reviews the changes and lists what it found."
        selected
      />
      <StepCard
        icon={<IconGlyph name="info" size="small" />}
        title="Unknown step"
        needsSetup
        needsSetupLabel="Needs setup"
        writtenInCode="Written in code as parallel"
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
