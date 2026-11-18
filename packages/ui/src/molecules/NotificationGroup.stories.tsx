import type { Meta, StoryObj } from "@storybook/react-vite";
import { NotificationGroup, NotificationRow, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationGroup",
  parameters: {
    catalogId: "ui.notificationGroup",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

function Row({ id, unread }: { id: string; unread: boolean }) {
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

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <NotificationGroup heading="Today">
        <Row id="a" unread />
        <Row id="b" unread={false} />
      </NotificationGroup>
      <NotificationGroup heading="Yesterday">
        <Row id="c" unread={false} />
      </NotificationGroup>
    </Stack>
  ),
};
