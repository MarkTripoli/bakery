import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconGlyph, OutlineList, OutlineRow } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/OutlineRow",
  parameters: { catalogId: "ui.outlineRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * Every state of one row of the outline: ordinary, selected, one the editor
 * cannot read, one written in code, and the caption that heads an If's arm.
 */
export const Contract: StoryObj = {
  render: () => (
    <div style={{ maxWidth: "360px" }}>
      <OutlineList aria-label="Rows">
        <OutlineRow
          icon={<IconGlyph name="terminal" size="small" />}
          onSelect={() => undefined}
          summary="A coding agent makes the change."
          title="Implement"
        />
        <OutlineRow
          icon={<IconGlyph name="shield" size="small" />}
          onSelect={() => undefined}
          selected
          summary="A separate agent reviews the changes."
          title="Review"
        />
        <OutlineRow
          icon={<IconGlyph name="info" size="small" />}
          needsSetup
          needsSetupLabel="Needs setup"
          onSelect={() => undefined}
          title="Unknown step"
        />
        <OutlineRow
          codeMark={<IconGlyph name="code" size="small" />}
          icon={<IconGlyph name="terminal" size="small" />}
          onSelect={() => undefined}
          selectLabel="Brief, edited in code"
          title="Brief"
        />
        <OutlineRow caption title="Otherwise" />
      </OutlineList>
    </div>
  ),
};
