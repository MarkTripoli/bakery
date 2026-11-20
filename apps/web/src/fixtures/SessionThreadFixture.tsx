import { useRouterState } from "@tanstack/react-router";
import { createTranslator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useShellViewport } from "../app/responsive.ts";
import { SessionNow, type SessionNowState } from "../pages/session-now.tsx";
import {
  type SessionFeedItem,
  SessionThread,
} from "../pages/session-thread.tsx";
import { TaskSessionView } from "../pages/task-session-view.tsx";

/**
 * The agent thread in every state a reader really meets, so it can be reviewed
 * as a picture rather than a claim.
 *
 * The content follows the binding design's running mock: a person message with
 * its delivery receipt, then the agent's account with the work each message
 * caused nested under it. The server populates only `message` and
 * `delivered_input` today, so the work lines here are the design's target shape
 * rather than what a live session shows yet - the fixture exists to hold the
 * design honest, and it says so in the panel's own copy rather than pretending.
 */
const MINUTE = 60_000;
const at = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * MINUTE).toISOString();

function base(
  sequence: number,
  kind: SessionFeedItem["kind"],
  occurredAt: string,
): SessionFeedItem {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "11111111-1111-4111-8111-111111111111",
    sequence: String(sequence),
    kind,
    occurredAt,
    redacted: false,
    message: null,
    terminal: null,
    status: null,
    tool: null,
    fileChange: null,
    artifact: null,
    usage: null,
    deliveredInput: null,
  };
}

const said = (
  sequence: number,
  minutesAgo: number,
  authorKind: "person" | "agent" | "system",
  body: string,
): SessionFeedItem => ({
  ...base(sequence, "message", at(minutesAgo)),
  message: {
    messageId: `2222222${sequence}-2222-4222-8222-222222222222`,
    authorId: authorKind === "system"
      ? null
      : "33333333-3333-4333-8333-333333333333",
    authorKind,
    messageType: authorKind === "person" ? "user" : "assistant",
    body,
  },
});

const delivered = (sequence: number, minutesAgo: number): SessionFeedItem => ({
  ...base(sequence, "delivered_input", at(minutesAgo)),
  deliveredInput: {
    messageId: `4444444${sequence}-4444-4444-8444-444444444444`,
    body: "Add a retry to the upload step and run the tests.",
  },
});

/** The running session from the design's mock. */
export const sessionThreadRunning: readonly SessionFeedItem[] = [
  said(1, 15, "person", "Add a retry to the upload step and run the tests."),
  delivered(2, 15),
  said(
    3,
    14,
    "agent",
    "I will read the upload step first, then add a retry with a backoff and cover it with a test.",
  ),
  {
    ...base(4, "tool", at(14)),
    tool: { callId: "call-1", name: "read_file", phase: "completed", ok: true },
  },
  {
    ...base(5, "file_change", at(13)),
    fileChange: {
      path: "apps/server/src/modules/upload/retry.ts",
      change: "modified",
    },
  },
  {
    ...base(6, "file_change", at(13)),
    fileChange: {
      path: "tests/unit/upload-retry_test.ts",
      change: "created",
    },
  },
  {
    ...base(7, "tool", at(12)),
    tool: { callId: "call-2", name: "run_tests", phase: "failed", ok: false },
  },
  {
    ...base(8, "terminal", at(11)),
    terminal: {
      stream: "stderr",
      text:
        "$ pnpm test upload\n ✓ retries a failed part (212 ms)\n ✓ gives up after 3 attempts (640 ms)\n warning: retrying after a 502 from the upload endpoint\n ✗ resumes from the last confirmed part\n   expected 3 parts, received 2\nTests: 1 failed, 11 passed, 12 total",
    },
  },
  said(
    9,
    6,
    "agent",
    "The resume path skipped the last confirmed part. I fixed the offset and the tests are running again.",
  ),
  {
    ...base(10, "file_change", at(6)),
    fileChange: {
      path: "apps/server/src/modules/upload/retry.ts",
      change: "modified",
    },
  },
  {
    ...base(11, "tool", at(5)),
    tool: { callId: "call-3", name: "run_tests", phase: "started", ok: null },
  },
  {
    ...base(12, "terminal", at(5)),
    terminal: {
      stream: "stdout",
      text:
        "$ pnpm test upload\n ✓ retries a failed part\n ✓ gives up after 3 attempts\n ✓ resumes from the last confirmed part\nTests: 12 passed, 12 total",
    },
  },
  {
    ...base(13, "artifact", at(4)),
    artifact: {
      artifactId: "55555555-5555-4555-8555-555555555555",
      name: "test-report.html",
      version: 2,
    },
  },
  {
    ...base(14, "usage", at(4)),
    usage: {
      inputTokens: "1240",
      outputTokens: "860",
      costUsd: "0.0042",
    },
  },
];

const failedThread: readonly SessionFeedItem[] = [
  said(1, 9, "person", "Ship the release build."),
  delivered(2, 9),
  said(3, 8, "agent", "Building the release bundle now."),
  {
    ...base(4, "tool", at(7)),
    tool: {
      callId: "call-1",
      name: "build_release",
      phase: "failed",
      ok: false,
    },
  },
  {
    ...base(5, "terminal", at(6)),
    terminal: {
      stream: "stderr",
      text:
        "error: the signing key expired on 2026-11-02\nbuild stopped after 3 attempts",
    },
  },
];

const longThread: readonly SessionFeedItem[] = Array.from(
  { length: 58 },
  (_, index) => {
    const sequence = index + 1;
    const minutes = 60 - index;
    return index % 3 === 0
      ? said(
        sequence,
        minutes,
        "agent",
        `Step ${sequence}: checked the upload path and kept the offset fix.`,
      )
      : {
        ...base(sequence, "tool", at(minutes)),
        tool: {
          callId: `call-${sequence}`,
          name: "run_tests",
          phase: sequence % 7 === 0 ? "failed" : "completed",
          ok: sequence % 7 !== 0,
        },
      };
  },
);

/** One long turn: past the 30-line cap, with every kind of line in it. */
const wideThread: readonly SessionFeedItem[] = [
  said(1, 20, "person", "Update every caller of the upload retry."),
  delivered(2, 20),
  said(3, 19, "agent", "Working through the callers one at a time."),
  ...Array.from({ length: 40 }, (_, index): SessionFeedItem => {
    const sequence = 4 + index;
    return index % 2 === 0
      ? {
        ...base(sequence, "tool", at(18 - Math.floor(index / 3))),
        tool: {
          callId: `wide-${sequence}`,
          name: "read_file",
          phase: "completed",
          ok: true,
        },
      }
      : {
        ...base(sequence, "file_change", at(18 - Math.floor(index / 3))),
        fileChange: {
          path: `apps/server/src/modules/upload/callers/caller-${index}.ts`,
          change: "modified",
        },
      };
  }),
  {
    ...base(44, "artifact", at(2)),
    artifact: {
      artifactId: "55555555-5555-4555-8555-555555555555",
      name: "retry-report.html",
      version: 3,
    },
  },
  {
    ...base(45, "file_change", at(2)),
    redacted: true,
  },
  {
    ...base(46, "usage", at(1)),
    usage: { inputTokens: "52100", outputTokens: "9020", costUsd: "0.1534" },
  },
];

const ended = (
  sequence: number,
  toStatus: "finished" | "failed" | "interrupted",
  reason: string | null = null,
): SessionFeedItem => ({
  ...base(sequence, "status", at(1)),
  status: { fromStatus: "active", toStatus, reason },
});

const STATE: Record<string, {
  items: readonly SessionFeedItem[];
  now: SessionNowState;
  empty?: boolean;
  running?: boolean;
  /** The run heading's status word; Running unless the session ended. */
  status?: string;
  /** The sessions own status, as the page would pass it. */
  sessionStatus?: string;
  loading?: boolean;
  error?: boolean;
}> = {
  running: {
    items: sessionThreadRunning,
    now: { kind: "working", toolName: "run_tests", since: at(1) },
    running: true,
  },
  wide: {
    items: wideThread,
    now: { kind: "working", toolName: "read_file", since: at(1) },
    running: true,
  },
  loading: { items: [], now: { kind: "idle" }, loading: true },
  error: { items: [], now: { kind: "idle" }, error: true },
  waiting: {
    items: [
      said(1, 2, "person", "Add a retry to the upload step and run the tests."),
      delivered(2, 2),
    ],
    now: { kind: "waiting" },
  },
  failed: {
    items: [
      ...failedThread,
      ended(6, "failed", "The signing key expired on 2026-11-02."),
    ],
    now: { kind: "failed", reason: "The signing key expired on 2026-11-02." },
    status: "Failed",
    sessionStatus: "failed",
  },
  lost: {
    items: sessionThreadRunning,
    now: { kind: "lost", lastUpdate: "2 min ago", onTryNow: () => {} },
    running: true,
  },
  finished: {
    items: [
      ...sessionThreadRunning.filter((entry) =>
        entry.sequence !== "7" && entry.sequence !== "8"
      ),
      ended(15, "finished"),
    ],
    now: { kind: "idle" },
    status: "Completed",
  },
  empty: {
    items: [],
    now: { kind: "waiting" },
    empty: true,
  },
  long: {
    items: longThread,
    now: { kind: "working", toolName: "run_tests" },
    running: true,
  },
};

/** The route's approved state names, and the fixture each one shows. */
const ALIASES: Record<string, string> = {
  default: "running",
  complete: "finished",
  reconnecting: "lost",
};

export function SessionThreadFixture() {
  const state = useRouterState({
    select: (value) => value.location.pathname.split("/").at(-1) ?? "running",
  });
  const viewport = useShellViewport();
  const translate = createTranslator({
    locale: "en",
    surface: "session-thread",
  });
  const fixture = STATE[ALIASES[state] ?? state] ?? STATE.running;

  return (
    <TaskSessionView
      layout={viewport === "phone" ? "sheet" : "rail"}
      title={translate("tasks.live.detail")}
      runHeading={{
        description: "Add a retry to the upload step",
        status: fixture.status ?? "Running",
      }}
      state="ready"
      messages={[]}
      composer={
        <UI.MessageComposer
          aria-label="Reply to this session"
          field={<textarea aria-label="Reply" placeholder="Reply…" rows={1} />}
          send={<UI.Button type="submit" variant="primary">Send</UI.Button>}
        />
      }
      thread={fixture.loading
        ? (
          <UI.Stack
            aria-busy="true"
            aria-label={translate("session.thread.loading")}
            gap="standard"
            role="status"
          >
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : fixture.error
        ? (
          <UI.InlineNotice
            tone="error"
            action={
              <UI.Button variant="outline">
                {translate("tasks.live.retry")}
              </UI.Button>
            }
          >
            {translate("session.thread.loadFailed")}
          </UI.InlineNotice>
        )
        : (
          <SessionThread
            items={fixture.items}
            running={fixture.running}
            sessionStatus={fixture.sessionStatus}
            onLoadEarlier={state === "long" ? () => {} : undefined}
            now={<SessionNow state={fixture.now} />}
          />
        )}
    >
    </TaskSessionView>
  );
}
