import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Heading, NotificationPageHeader, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationPageHeader",
  parameters: {
    catalogId: "ui.notificationPageHeader",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <NotificationPageHeader>
        <Heading level="page">Notifications</Heading>
        <Button variant="secondary">Mark all read</Button>
      </NotificationPageHeader>
      <NotificationPageHeader state="mark-all-read-running">
        <Heading level="page">Notifications</Heading>
        <Button variant="secondary" disabled>
          Marking…
        </Button>
      </NotificationPageHeader>
    </Stack>
  ),
};
