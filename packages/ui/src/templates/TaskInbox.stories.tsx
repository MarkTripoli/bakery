import { createTranslator } from "@bakery/i18n";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  CursorControls,
  Stack,
  StatusDot,
  TaskInbox,
  TaskQueue,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/TaskInbox",
  parameters: {
    catalogId: "template.taskInbox",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const queue = (rows: { id: string; title: string; stage: string }[]) => (
  <TaskQueue
    labels={{
      caption: "Work queue",
      task: "Task",
      application: "Application",
      stage: "Stage",
      harness: "Harness",
      age: "Age",
    }}
    groups={[{
      id: "fixture",
      label: "Fixture",
      rows: rows.map((row) => ({
        ...row,
        reference: row.id.toUpperCase(),
        href: `#${row.id}`,
        application: "Bakery",
        harness: "Codex",
        age: "2m",
        stage: <StatusDot tone="neutral">{row.stage}</StatusDot>,
      })),
    }]}
    variant="list"
  />
);

export const Contract: StoryObj = {
  render: () => {
    const translate = createTranslator({ locale: "en", surface: "ui-story" });
    return (
      <Stack>
        <Text>{translate("tasks.inbox.fixture")}</Text>
        <TaskInbox
          title={translate("tasks.inbox.title")}
          description={translate("tasks.inbox.fixture")}
          filtersLabel={translate("tasks.inbox.title")}
          filters={
            <Button type="button">{translate("tasks.inbox.filtered")}</Button>
          }
          action={
            <Button type="button">{translate("tasks.inbox.create")}</Button>
          }
          resultSummary={translate("tasks.inbox.results")}
          stateContent={translate("tasks.inbox.fixture")}
          cursorControls={
            <CursorControls
              hasNext
              variant="previousNext"
              labels={{
                controls: translate("tasks.inbox.title"),
                end: translate("tasks.inbox.empty"),
                loadMore: translate("tasks.inbox.loading"),
                loading: translate("tasks.inbox.loading"),
                next: translate("tasks.inbox.title"),
                previous: translate("tasks.inbox.title"),
                retry: translate("tasks.inbox.reconnecting"),
              }}
            />
          }
        >
          {queue([
            {
              id: "t-1",
              title: translate("tasks.detail.content"),
              stage: translate("tasks.inbox.ready"),
            },
            {
              id: "t-2",
              title: translate("tasks.artifact.descriptor"),
              stage: translate("tasks.inbox.queued"),
            },
          ])}
        </TaskInbox>
        <TaskInbox
          title={translate("tasks.inbox.loading")}
          filtersLabel={translate("tasks.inbox.title")}
          state="loading"
          stateContent={translate("tasks.inbox.loading")}
        />
        <TaskInbox
          title={translate("tasks.inbox.empty")}
          filtersLabel={translate("tasks.inbox.title")}
          state="empty"
          stateContent={translate("tasks.inbox.empty")}
        />
        <TaskInbox
          title={translate("tasks.inbox.offline")}
          filtersLabel={translate("tasks.inbox.title")}
          state="offline"
          stateContent={translate("tasks.inbox.offline")}
        />
        <TaskInbox
          title={translate("tasks.inbox.reconnecting")}
          filtersLabel={translate("tasks.inbox.title")}
          state="reconnecting"
          stateContent={translate("tasks.inbox.reconnecting")}
        />
        <TaskInbox
          title={translate("tasks.live.error")}
          filtersLabel={translate("tasks.inbox.title")}
          state="error"
          stateContent={translate("tasks.inbox.fixture")}
        />
        <TaskInbox
          title={translate("tasks.live.forbidden")}
          filtersLabel={translate("tasks.inbox.title")}
          state="forbidden"
          stateContent={translate("tasks.controls.forbidden")}
        />
      </Stack>
    );
  },
};
