import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  NotificationGroup,
  NotificationPopover,
  NotificationRow,
  Stack,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationPopover",
  parameters: {
    catalogId: "ui.notificationPopover",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

function Row({ id, unread = true }: { id: string; unread?: boolean }) {
  return (
    <NotificationRow
      id={id}
      unread={unread}
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

const base = {
  title: "Notifications",
  markAllReadLabel: "Mark all read",
  onMarkAllRead: () => {},
  viewAllHref: "#",
  viewAllLabel: "View all notifications",
};

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="spacious">
      <Text>Rows ready:</Text>
      <NotificationPopover
        {...base}
        markAllReadDisabled={false}
        markAllReadDisabledReason="Nothing is unread."
      >
        <NotificationGroup heading="Today">
          <Row id="a" />
          <Row id="b" unread={false} />
        </NotificationGroup>
      </NotificationPopover>

      <Text>Nothing unread, so Mark all read is disabled with its reason:</Text>
      <NotificationPopover
        {...base}
        markAllReadDisabled
        markAllReadDisabledReason="Nothing is unread."
      >
        <NotificationGroup heading="Today">
          <Row id="c" unread={false} />
        </NotificationGroup>
      </NotificationPopover>

      <Text>Empty:</Text>
      <NotificationPopover
        {...base}
        markAllReadDisabled
        markAllReadDisabledReason="Nothing is unread."
        state="empty"
        footerNote="No notifications yet"
      />

      <Text>Loading:</Text>
      <NotificationPopover
        {...base}
        markAllReadDisabled
        markAllReadDisabledReason="Nothing is unread."
        state="loading"
      />

      <Text>Failed, with a retry:</Text>
      <NotificationPopover
        {...base}
        markAllReadDisabled={false}
        markAllReadDisabledReason="Nothing is unread."
        state="failed"
        onRetry={() => {}}
      />

      <Text>Long enough to scroll under the block cap:</Text>
      <NotificationPopover
        {...base}
        markAllReadDisabled={false}
        markAllReadDisabledReason="Nothing is unread."
      >
        <NotificationGroup heading="Today">
          {Array.from(
            { length: 12 },
            (_, index) => <Row key={index} id={`s${index}`} />,
          )}
        </NotificationGroup>
      </NotificationPopover>
    </Stack>
  ),
};
