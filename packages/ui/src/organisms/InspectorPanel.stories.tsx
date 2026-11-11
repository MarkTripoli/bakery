import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, InspectorPanel, PaneSection, Text } from "@bakery/ui";
import { PaperInspector } from "../examples/shell-example.tsx";

const meta = {
  title: "Bakery/Organisms/InspectorPanel",
  parameters: { catalogId: "ui.inspectorPanel", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div className="gallery-stack-example">
      <PaperInspector />
      <InspectorPanel
        header={
          <>
            <Text variant="strong">northwind/payments</Text>
            <Button variant="text">Edit repository</Button>
          </>
        }
        label="Repository"
        variant="sections"
      >
        <PaneSection heading="strong" ruled title="Profiles">
          <Text variant="hint">Review immutable repository profiles.</Text>
        </PaneSection>
      </InspectorPanel>
      <InspectorPanel label="Nothing selected" state="empty" variant="stacked">
        <Text variant="muted">Select a task to see its details.</Text>
      </InspectorPanel>
    </div>
  ),
};
