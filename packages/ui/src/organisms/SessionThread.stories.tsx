import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  EmptyState,
  SessionThread,
  type SessionThreadTurn,
  Stack,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/SessionThread",
  parameters: { catalogId: "ui.sessionThread", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const labels = {
  jumpToLatest: "Jump to latest",
  loadEarlier: "Load earlier",
  shortcuts: "Keyboard shortcuts",
  shortcutHelp: [
    "J moves to the next message",
    "K moves to the previous message",
    "Enter opens or folds a message's work",
    "End jumps to the latest",
  ],
};

const turns: readonly SessionThreadTurn[] = [
  {
    key: "person",
    message: {
      itemId: "m1",
      author: "You",
      kind: "person",
      time: "15m ago",
      timeTitle: "2026-11-18T10:00:00.000Z",
      body: "Add a retry to the upload step and run the tests.",
      receipt: "Delivered to the agent",
    },
    defaultOpen: false,
    steps: [],
  },
  {
    key: "agent",
    message: {
      itemId: "m2",
      author: "Agent",
      kind: "agent",
      time: "14m ago",
      timeTitle: "2026-11-18T10:01:00.000Z",
      body:
        "I will read the upload step first, then add a retry with a backoff and cover it with a test.",
    },
    summary: "4 steps, 2 files changed, 1 failed",
    defaultOpen: true,
    steps: [
      {
        key: "s1",
        itemId: "s1",
        icon: "terminal",
        sentence: {
          before: "Ran ",
          after: "",
          value: { kind: "name", text: "read_file" },
        },
        time: "14m ago",
      },
      {
        key: "s2",
        itemId: "s2",
        icon: "file",
        sentence: {
          before: "Edited ",
          after: "",
          value: {
            kind: "path",
            text: "apps/server/src/modules/upload/retry.ts",
          },
        },
        time: "13m ago",
      },
      {
        key: "s3",
        itemId: "s3",
        icon: "close",
        tone: "danger",
        sentence: {
          before: "",
          after: " failed",
          value: { kind: "name", text: "run_tests" },
        },
        time: "12m ago",
      },
      {
        key: "s4",
        itemId: "s4",
        icon: "close",
        tone: "danger",
        sentence: "Output with errors, 6 lines",
        time: "11m ago",
        output: {
          text:
            "$ pnpm test upload\n ✗ resumes from the last confirmed part\nTests: 1 failed, 11 passed",
          defaultOpen: true,
        },
      },
    ],
    usage: "1,240 tokens in, 860 out, $0.0042",
  },
  {
    key: "folded",
    message: {
      itemId: "m3",
      author: "Agent",
      kind: "agent",
      time: "6m ago",
      timeTitle: "2026-11-18T10:09:00.000Z",
      body:
        "The resume path skipped the last confirmed part. I fixed the offset.",
    },
    summary: "2 steps, 1 file changed",
    defaultOpen: false,
    steps: [
      {
        key: "f1",
        itemId: "f1",
        icon: "file",
        sentence: {
          before: "Edited ",
          after: "",
          value: {
            kind: "path",
            text: "apps/server/src/modules/upload/retry.ts",
          },
        },
        time: "6m ago",
      },
    ],
  },
];

const rest = {
  labels,
  showMore: (hidden: number) => `Show ${hidden} more`,
};

/**
 * Four sessions: one still running, one that failed, one that finished and one
 * with nothing yet. The failed one shows a person's boxed message, the agent's
 * plain text with its work open, a failed step with its output, a folded turn
 * and the end of the session.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <SessionThread turns={turns.slice(0, 2)} {...rest} />
      <SessionThread
        turns={turns}
        end={{
          outcome: "failed",
          label: "Session failed",
          reason: "The signing key expired.",
        }}
        {...rest}
      />
      <SessionThread
        turns={turns.slice(2)}
        end={{ outcome: "completed", label: "Session finished" }}
        {...rest}
      />
      <SessionThread
        turns={[]}
        empty={
          <EmptyState
            title="Nothing here yet"
            description="Messages and the agent's work appear here as the session runs."
          />
        }
        {...rest}
      />
    </Stack>
  ),
};
