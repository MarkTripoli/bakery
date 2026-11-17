import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { NotificationBell, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationBell",
  parameters: { catalogId: "ui.notificationBell", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const unreadLabel = (count: number) => `Notifications, ${count} unread`;

export const Contract: StoryObj = {
  render: () => {
    const [count, setCount] = useState(0);
    return (
      <Stack>
        <NotificationBell
          label="Notifications"
          status={count === 0 ? { state: "none" } : {
            state: "unread",
            count: count + 3,
          }}
          unreadLabel={unreadLabel}
          unknownLabel="Notifications, count unavailable"
          open
          onClick={() => setCount(count + 1)}
        />
        <NotificationBell
          label="Notifications"
          status={{ state: "unread", count: 3 }}
          unreadLabel={unreadLabel}
          unknownLabel="Notifications, count unavailable"
        />
        <NotificationBell
          label="Notifications"
          status={{ state: "none" }}
          unreadLabel={unreadLabel}
          unknownLabel="Notifications, count unavailable"
        />
        <NotificationBell
          label="Notifications"
          status={{ state: "unknown" }}
          unreadLabel={unreadLabel}
          unknownLabel="Notifications, count unavailable"
        />
        <NotificationBell
          label="Notifications"
          status={{ state: "unread", count: 128 }}
          unreadLabel={unreadLabel}
          unknownLabel="Notifications, count unavailable"
        />
        <Text role="status">{count} notification previews opened</Text>
      </Stack>
    );
  },
};
