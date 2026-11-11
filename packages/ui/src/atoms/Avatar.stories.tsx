import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Avatar",
  parameters: { catalogId: "ui.avatar", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Avatar
        alt="Loaded avatar"
        src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
        state="default"
        variant="image"
      />
      <Avatar alt="Alex Chen" variant="initials" fallback="AC" />
      <Avatar alt="Bakery agent" variant="icon" fallback="◇" />
      <Avatar
        alt="Unavailable avatar"
        state="fallback"
        variant="image"
        fallback="BA"
      />
    </Stack>
  ),
};
