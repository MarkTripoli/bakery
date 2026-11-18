import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  NotificationGroup,
  NotificationGroups,
  NotificationRow,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationGroups",
  parameters: {
    catalogId: "ui.notificationGroups",
    requiredCases: ["contract"],
  },
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
    <NotificationGroups>
      <NotificationGroup heading="Today">
        <Row id="a" />
      </NotificationGroup>
      <NotificationGroup heading="Yesterday">
        <Row id="b" />
      </NotificationGroup>
    </NotificationGroups>
  ),
};
