import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThemeToggle } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/ThemeToggle",
  parameters: { catalogId: "ui.themeToggle", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <ThemeToggle data-semantic-interaction="pressed" label="Switch theme" />
  ),
};
