import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Heading,
  NotificationGroup,
  NotificationGroups,
  NotificationPageHeader,
  NotificationPopover,
  NotificationRow,
  Stack,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/NotificationSurfaces",
  // The popover surfaces ride the catalogued ui.notificationBell contract; a
  // separate catalog entry needs a Paper frame, and the design has none for a
  // popover, so these stories are visual coverage rather than catalog bindings.
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

function Row(
  props: {
    id: string;
    unread?: boolean;
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

const SAMPLE = (
  <>
    <Row
      id="a"
      headline="Sam Lee mentioned you"
      destination="Repository onboarding"
      minutesAgo={3}
    />
    <Row
      id="b"
      kind="check"
      unread={false}
      headline="Your task finished"
      destination="Rotate the staging certificates"
      minutesAgo={22}
    />
    <Row
      id="c"
      kind="warning"
      headline="Your task failed"
      destination="Nightly dependency refresh"
      minutesAgo={48}
    />
    <Row
      id="d"
      kind="shield"
      headline="Your approval is needed"
      destination="Publish 1.4.0 · Release 1.4"
      minutesAgo={90}
    />
    <Row
      id="e"
      kind="question"
      unread={false}
      headline="A question needs your answer"
      destination="Migrate the audit tables"
      minutesAgo={200}
    />
    <Row
      id="f"
      kind="document"
      unread={false}
      headline="A new version is ready: Release plan"
      destination="Version 3 · Release 1.4"
      minutesAgo={1400}
    />
  </>
);

export const PopoverWithRows: StoryObj = {
  render: () => (
    <NotificationPopover
      title="Notifications"
      markAllReadLabel="Mark all read"
      markAllReadDisabled={false}
      markAllReadDisabledReason="Nothing is unread."
      onMarkAllRead={() => {}}
      viewAllHref="#"
      viewAllLabel="View all notifications"
    >
      <NotificationGroup heading="Today">{SAMPLE}</NotificationGroup>
    </NotificationPopover>
  ),
};

export const PopoverEmpty: StoryObj = {
  render: () => (
    <NotificationPopover
      title="Notifications"
      markAllReadLabel="Mark all read"
      markAllReadDisabled
      markAllReadDisabledReason="Nothing is unread."
      onMarkAllRead={() => {}}
      viewAllHref="#"
      viewAllLabel="View all notifications"
      state="empty"
      footerNote="No notifications yet"
    />
  ),
};

export const PopoverFailed: StoryObj = {
  render: () => (
    <NotificationPopover
      title="Notifications"
      markAllReadLabel="Mark all read"
      markAllReadDisabled={false}
      markAllReadDisabledReason="Nothing is unread."
      onMarkAllRead={() => {}}
      viewAllHref="#"
      viewAllLabel="View all notifications"
      state="failed"
      onRetry={() => {}}
    />
  ),
};

export const PageWithGroups: StoryObj = {
  render: () => (
    <Stack gap="spacious">
      <NotificationPageHeader>
        <Heading level="page">Notifications</Heading>
        <Button variant="secondary">Mark all read</Button>
      </NotificationPageHeader>
      <NotificationGroups>
        <NotificationGroup heading="Today">{SAMPLE}</NotificationGroup>
        <NotificationGroup heading="Yesterday">
          <Row
            id="g"
            kind="document"
            unread={false}
            headline="A new version is ready: Release plan"
            destination="Version 2 · Release 1.4"
            minutesAgo={1400}
          />
        </NotificationGroup>
      </NotificationGroups>
    </Stack>
  ),
};

export const MarkAllReadRunning: StoryObj = {
  render: () => (
    <Stack gap="spacious">
      <NotificationPageHeader>
        <Heading level="page">Notifications</Heading>
        <Button variant="secondary" disabled>
          Marking…
        </Button>
      </NotificationPageHeader>
      <Text>Some rows stay unread while the button works.</Text>
    </Stack>
  ),
};

export const UnavailableDestination: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <Text>The row for a gone destination reads normally:</Text>
      <NotificationGroup heading="Today">
        <Row
          id="h"
          kind="warning"
          href={null}
          headline="Your task failed"
          destination="No longer available"
          minutesAgo={7}
        />
      </NotificationGroup>
    </Stack>
  ),
};
