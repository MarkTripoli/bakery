import type { Meta, StoryObj } from "@storybook/react-vite";
import { NestedAlertExample } from "../examples/story-helpers.tsx";

const meta = {
  title: "Bakery/Interactions/AlertDialog in Sheet",
} satisfies Meta;
export default meta;

export const Nested: StoryObj = {
  render: () => <NestedAlertExample />,
};
