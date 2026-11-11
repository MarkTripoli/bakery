import type { Meta, StoryObj } from "@storybook/react-vite";
import { Switch, WorkflowStageStrip } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/WorkflowStageStrip",
  parameters: {
    catalogId: "ui.workflowStageStrip",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const stages = [
  { id: "discuss", title: "1 · Discuss", detail: "Automatic" },
  {
    id: "plan",
    title: "2 · Plan · Current stage",
    detail: "Waits for your approval",
    current: true,
  },
  { id: "implement", title: "3 · Implement", detail: "Automatic" },
  { id: "review", title: "4 · Review", detail: "Waits for your approval" },
];

export const Contract: StoryObj = {
  render: () => (
    <>
      <WorkflowStageStrip
        variant="compact"
        label="Workflow stages (compact)"
        stages={stages.map((stage) => ({
          ...stage,
          title: stage.title.split(" · ")[1] ?? stage.title,
        }))}
        summary="Plan · Waits for your approval"
      />
      <WorkflowStageStrip
        label="Workflow stages"
        stages={stages}
        trailing={
          <Switch checked={false} onChange={() => undefined}>
            Planning only
          </Switch>
        }
      />
    </>
  ),
};
