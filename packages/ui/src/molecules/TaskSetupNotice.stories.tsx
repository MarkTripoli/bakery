import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, TaskSetupNotice } from "@bakery/ui";
import { composerLabels, storyTranslator } from "../fixtures/task-session.ts";

const meta = {
  title: "Bakery/Molecules/TaskSetupNotice",
  parameters: { catalogId: "ui.taskSetupNotice", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: (_args, context) => {
    const labels = composerLabels(storyTranslator(context.globals));
    const reasons = ["no_active_profile", "coding_agent_unbound"] as const;
    return (
      <Stack>
        <TaskSetupNotice
          heading={labels.setupHeading}
          nextStep={labels.setupNoWorkflow}
          reasons={[{
            id: reasons[0],
            content: labels.setupRequired[reasons[0]],
          }]}
        />
        <TaskSetupNotice
          heading={labels.setupHeading}
          reasons={reasons.map((reason) => ({
            id: reason,
            content: labels.setupRequired[reason],
          }))}
        />
      </Stack>
    );
  },
};
