import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkExample } from "./story-helpers.tsx";

const meta = {
  title: "Bakery/Pages/WorkQueue",
  parameters: {
    catalogId: "page.workQueue",
    requiredCases: ["reviewedDesktop"],
  },
} satisfies Meta;
export default meta;

export const ReviewedDesktop: StoryObj = {
  render: () => <WorkExample />,
};
