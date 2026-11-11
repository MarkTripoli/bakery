import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, ErrorState, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ErrorState",
  parameters: { catalogId: "ui.errorState", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <ErrorState
        title="Could not load this region"
        description="Check your connection and try again."
        variant="region"
        action={<Button>Retry region</Button>}
      />
      <ErrorState
        title="Could not load the page"
        description="The page is unavailable right now."
        variant="page"
        state="retrying"
        action={<Button loading>Retrying page</Button>}
      />
    </Stack>
  ),
};
