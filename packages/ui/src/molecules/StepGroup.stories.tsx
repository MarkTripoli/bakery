import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconGlyph, StepGroup } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StepGroup",
  parameters: { catalogId: "ui.stepGroup", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * The frame around steps that belong together: a box with a limit, a selected
 * box, an empty one, a box written in code, and one arm of an If.
 */
export const Contract: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: "16px", maxWidth: "360px" }}>
      <StepGroup
        icon={<IconGlyph name="refresh" size="small" />}
        label="For each item"
        limit="At most 20 items"
        onSelect={() =>
          undefined}
        selectLabel="For each item, 2 steps"
      />
      <StepGroup
        icon={<IconGlyph name="refresh" size="small" />}
        label="Fix until it passes"
        limit="At most 2 tries"
        onSelect={() => undefined}
        selectLabel="Fix until it passes, 1 step"
        selected
      />
      <StepGroup
        empty="No steps"
        icon={<IconGlyph name="refresh" size="small" />}
        label="Repeat"
      />
      <StepGroup
        codeMark={<IconGlyph name="code" size="small" />}
        icon={<IconGlyph name="refresh" size="small" />}
        label="At the same time"
        onSelect={() => undefined}
        selectLabel="At the same time, edited in code"
      />
      <StepGroup empty="No steps" label="Otherwise" variant="arm" />
    </div>
  ),
};
