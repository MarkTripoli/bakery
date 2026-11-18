import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  NotificationList,
  NotificationRow,
  Stack,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationList",
  parameters: { catalogId: "ui.notificationList", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

function Row({ id }: { id: string }) {
  return (
    <NotificationRow
      id={id}
      unread
      unreadLabel="Unread"
      headline="Sam Lee mentioned you"
      destination="Repository onboarding"
      actor={{ kind: "person", name: "Sam Lee", src: null }}
      href="#"
      relativeTime="5 min ago"
      exactTime="11 November 2026 at 21:04"
    />
  );
}

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <Text>Ready, with rows:</Text>
      <NotificationList>
        <Row id="a" />
        <Row id="b" />
      </NotificationList>
      <Text>Empty:</Text>
      <NotificationList state="empty">
        <li>
          <Text>No notifications yet</Text>
        </li>
      </NotificationList>
      <Text>Loading:</Text>
      <NotificationList state="loading">
        <li>
          <Text>Loading notifications</Text>
        </li>
      </NotificationList>
      <Text>Failed, with a retry:</Text>
      <NotificationList state="error">
        <li>
          <Text>Notifications could not load.</Text>
          <Button variant="quiet">Try again</Button>
        </li>
      </NotificationList>
    </Stack>
  ),
};
