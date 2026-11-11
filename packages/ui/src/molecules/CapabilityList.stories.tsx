import type { Meta, StoryObj } from "@storybook/react-vite";
import { CapabilityList, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/CapabilityList",
  parameters: { catalogId: "ui.capabilityList", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <CapabilityList
        aria-label="Requested access"
        items={[
          {
            id: "read",
            icon: "document",
            title: "Read work and artifacts",
            description:
              "Read tasks, plans and execution evidence you can access.",
          },
          {
            id: "steer",
            icon: "terminal",
            title: "Start and steer tasks",
            description:
              "Create work and send instructions under your permissions.",
          },
        ]}
      />
      <CapabilityList
        aria-label="Effective access"
        items={[
          {
            id: "settings",
            title: "Settings",
            description: "Manage your account, appearance and sessions.",
            value: "Manage",
          },
          {
            id: "work",
            title: "Work & collaboration",
            description:
              "Create tasks, run agents and review work in permitted repositories.",
            value: "Scoped",
          },
        ]}
        variant="access"
      />
    </Stack>
  ),
};
