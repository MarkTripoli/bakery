import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, VisuallyHidden } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/VisuallyHidden",
  parameters: { catalogId: "ui.visuallyHidden", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Button aria-describedby="admin-only">
      Start inspection
      <VisuallyHidden id="admin-only">
        Only an administrator can start.
      </VisuallyHidden>
    </Button>
  ),
};
