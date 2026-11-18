import type { Meta, StoryObj } from "@storybook/react-vite";
import { NotificationRow, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationRow",
  parameters: { catalogId: "ui.notificationRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

function Row(
  props: {
    id: string;
    unread?: boolean;
    highlighted?: boolean;
    href?: string | null;
    kind?: "person" | "check" | "warning" | "shield" | "question" | "document";
    headline: string;
    destination: string;
    minutesAgo?: number;
  },
) {
  return (
    <NotificationRow
      id={props.id}
      unread={props.unread ?? true}
      highlighted={props.highlighted}
      unreadLabel="Unread"
      headline={props.headline}
      destination={props.destination}
      actor={props.kind === undefined || props.kind === "person"
        ? { kind: "person", name: "Sam Lee", src: null }
        : { kind: "event", tile: props.kind }}
      href={props.href === undefined ? "#" : props.href}
      relativeTime={`${props.minutesAgo ?? 5} min ago`}
      exactTime="11 November 2026 at 21:04"
    />
  );
}

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <Text>A person row, unread:</Text>
      <Row
        id="a"
        headline="Sam Lee mentioned you"
        destination="Repository onboarding"
      />
      <Text>The same row, read:</Text>
      <Row
        id="b"
        unread={false}
        headline="Sam Lee mentioned you"
        destination="Repository onboarding"
      />
      <Text>An event row, highlighted after arriving from a link:</Text>
      <Row
        id="c"
        kind="check"
        highlighted
        headline="Your task finished"
        destination="Rotate the staging certificates"
      />
      <Text>Worst-case long text:</Text>
      <Row
        id="d"
        kind="warning"
        headline="Your task failed after three attempts on the nightly dependency refresh"
        destination="Nightly dependency refresh · Repository onboarding · main"
      />
      <Text>A destination that is no longer available:</Text>
      <Row
        id="e"
        kind="warning"
        href={null}
        headline="Your task failed"
        destination="No longer available"
      />
    </Stack>
  ),
};
