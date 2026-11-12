import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, DraftBar, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/DraftBar",
  parameters: { catalogId: "ui.draftBar", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <DraftBar
        detail="based on revision 3 · nothing applies until you publish"
        primaryAction={<Button type="button">Review and publish</Button>}
        secondaryAction={
          <Button type="button" variant="outline">Discard</Button>
        }
        summary="2 unpublished changes"
      />
      <DraftBar
        detail="based on revision 12 · nothing applies until you publish, and runs already in progress keep the rules they started with"
        primaryAction={
          <Button disabled type="button">Review and publish</Button>
        }
        secondaryAction={
          <Button type="button" variant="outline">Discard all of them</Button>
        }
        summary="1 unpublished change in the organization's repository rules, which every repository inherits"
      />
    </Stack>
  ),
};
