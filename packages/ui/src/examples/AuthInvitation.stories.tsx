import type { Meta, StoryObj } from "@storybook/react-vite";
import { AuthExample } from "./story-helpers.tsx";

const meta = {
  title: "Bakery/Pages/AuthInvitation",
  parameters: {
    catalogId: "page.authInvitation",
    requiredCases: ["defaultDesktop"],
  },
} satisfies Meta;
export default meta;

export const DefaultDesktop: StoryObj = {
  render: () => <AuthExample invitation />,
};
