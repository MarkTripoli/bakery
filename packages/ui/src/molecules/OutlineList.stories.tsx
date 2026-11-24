import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconGlyph, OutlineList, OutlineRow } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/OutlineList",
  parameters: { catalogId: "ui.outlineList", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div style={{ maxWidth: "360px" }}>
      <OutlineList aria-label="Steps">
        <OutlineRow
          icon={<IconGlyph name="terminal" size="small" />}
          onSelect={() => undefined}
          summary="A coding agent makes the change."
          title="Implement"
        />
        <OutlineRow
          icon={<IconGlyph name="refresh" size="small" />}
          onSelect={() => undefined}
          title="For each item"
        >
          <OutlineList>
            <OutlineRow
              icon={<IconGlyph name="check" size="small" />}
              onSelect={() => undefined}
              summary="Runs the repository's checks."
              title="Run checks"
            />
          </OutlineList>
        </OutlineRow>
      </OutlineList>
    </div>
  ),
};
