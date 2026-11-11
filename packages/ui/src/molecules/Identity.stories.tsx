import type { Meta, StoryObj } from "@storybook/react-vite";
import { Identity, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Identity",
  parameters: { catalogId: "ui.identity", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Identity
        type="person"
        name="Alex Chen"
        detail="Workspace member"
        avatar={{ alt: "Alex Chen", fallback: "AC" }}
      />
      <Identity type="agent" name="Bakery agent" state="offline" />
      <Identity type="harness" name="Playwright harness" state="unavailable" />
      <Identity type="provider" name="OpenAI" />
      <Identity type="machine" name="Build runner" />
    </Stack>
  ),
};
