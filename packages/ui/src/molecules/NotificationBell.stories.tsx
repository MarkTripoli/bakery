import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { NotificationBell, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationBell",
  parameters: { catalogId: "ui.notificationBell", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [count, setCount] = useState(0);
    return (
      <Stack>
        <NotificationBell
          count={count + 3}
          state="focused"
          variant="unread"
          open
          panel={<Text>Three notifications</Text>}
          onClick={() => setCount(count + 1)}
        />
        <NotificationBell
          count={1}
          state="open"
          variant="unread"
          open
          panel={<Text>One notification</Text>}
        />
        <NotificationBell label="No notifications" variant="clear" />
        <Text role="status">{count} notification previews opened</Text>
      </Stack>
    );
  },
};
