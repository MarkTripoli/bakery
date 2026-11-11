import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkspaceSwitcher } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/WorkspaceSwitcher",
  parameters: {
    catalogId: "ui.workspaceSwitcher",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const items = [
  { id: "mark", label: "Mark’s workspace", selected: true },
  { id: "example", label: "Example team" },
];

export const Contract: StoryObj = {
  render: () => (
    <div className="gallery-stack-example">
      <WorkspaceSwitcher
        items={items}
        label="Switch workspace"
        workspace="Mark’s workspace"
      />
      <WorkspaceSwitcher
        items={items}
        label="Switch workspace, compact"
        variant="compact"
        workspace="Mark’s workspace"
      />
      <WorkspaceSwitcher
        items={items}
        label="Switch workspace, open"
        state="open"
        workspace="Example team"
      />
    </div>
  ),
};
