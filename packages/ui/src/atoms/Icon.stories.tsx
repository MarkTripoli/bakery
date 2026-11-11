import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Icon",
  parameters: { catalogId: "ui.icon", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Icon size="small" aria-label="Named small icon">
        <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" />
      </Icon>
      <Icon size="medium" label="Named medium icon">
        <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" />
      </Icon>
      <Icon size="large">
        <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" />
      </Icon>
      <Icon size="medium" label="Named icon">
        <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" />
      </Icon>
    </Stack>
  ),
};
