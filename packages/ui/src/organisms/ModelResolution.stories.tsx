import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelResolution, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/ModelResolution",
  parameters: { catalogId: "ui.modelResolution", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <ModelResolution model="Luna" status="resolved" variant="summary" />
      <ModelResolution
        model="Luna"
        provider="OpenAI"
        reason="Selected for component implementation."
        status="overridden"
        variant="detailed"
      />
      <ModelResolution model="Unknown" status="unsupported" variant="summary" />
      <ModelResolution
        model="Unavailable"
        status="unavailable"
        variant="detailed"
      />
    </Stack>
  ),
};
