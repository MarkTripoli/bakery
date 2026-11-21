import { type ReactNode, useMemo } from "react";
import * as UI from "@bakery/ui";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { SessionNow, type SessionNowState } from "./session-now.tsx";
import { SessionThread } from "./session-thread.tsx";
import {
  buildSessionThread,
  LIVE_SESSION_STATUSES as LIVE,
  relativeTime,
  summarizeNow,
} from "./session-thread-model.ts";
import type { SessionThreadSource } from "./useSessionThread.ts";

/**
 * One run step's agent session: the thread when the step has one, with the
 * step's raw output kept reachable under it, never on top.
 *
 * A step with no session shows only its raw output, open, with one muted line
 * saying so. A failed read still offers the raw output.
 */
export function SessionStepThread(
  { highlightedItemId, rawOutput, source, taskId }: {
    highlightedItemId?: string;
    /** Today's output panel for the same step. */
    rawOutput: ReactNode;
    source: SessionThreadSource;
    taskId: string;
  },
) {
  const { translate } = useI18n();
  const raw = (open: boolean) => (
    <UI.Disclosure
      summary={translate("session.thread.rawOutput")}
      defaultOpen={open}
    >
      {rawOutput}
    </UI.Disclosure>
  );
  if (source.phase === "idle" || source.phase === "loading") {
    return (
      <UI.Stack
        aria-busy="true"
        aria-label={translate("session.thread.loading")}
        gap="standard"
        // A label needs a role to be allowed; "status" also announces loading.
        role="status"
      >
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  }
  if (source.phase === "none") {
    return (
      <UI.Stack gap="standard">
        <UI.Text variant="muted">
          {translate("session.thread.noSession")}
        </UI.Text>
        {raw(true)}
      </UI.Stack>
    );
  }
  if (source.phase === "error") {
    return (
      <UI.Stack gap="standard">
        <UI.InlineNotice
          tone="warning"
          action={
            <UI.Button variant="outline" onClick={source.retry}>
              {translate("tasks.live.retry")}
            </UI.Button>
          }
        >
          {translate("session.thread.loadFailed")}
        </UI.InlineNotice>
        {raw(true)}
      </UI.Stack>
    );
  }
  return (
    <UI.Stack gap="standard">
      {source.truncated
        ? (
          <UI.InlineNotice tone="information">
            {translate("session.thread.truncated")}
          </UI.InlineNotice>
        )
        : null}
      <SessionThread
        items={source.items}
        running={source.session ? LIVE.has(source.session.status) : false}
        sessionStatus={source.session?.status}
        truncated={source.truncated}
        highlightedItemId={highlightedItemId}
        renderArtifact={({ artifactId, name }) => (
          <RouterLink
            params={{ taskId, artifactId }}
            to="/tasks/$taskId/artifacts/$artifactId"
          >
            <UI.DataText variant="code" dir="ltr" translate="no">
              {name}
            </UI.DataText>
          </RouterLink>
        )}
      />
      {raw(false)}
    </UI.Stack>
  );
}

/**
 * The one line above the composer for the step that is running, whichever step
 * the reader is looking at. For another step it names that step and selecting it
 * switches to it. No run in progress, no line.
 */
export function SessionRunNow(
  { onSelect, source, stepName }: {
    onSelect?: () => void;
    source: SessionThreadSource;
    /** Named when the reader is looking at a different step. */
    stepName?: string;
  },
) {
  const { locale } = useI18n();
  const state = useMemo<SessionNowState>(() => {
    if (source.phase !== "ready" || !source.session) return { kind: "idle" };
    if (source.connection === "lost") {
      const last = source.items.at(-1)?.occurredAt ?? source.lostSince;
      return {
        kind: "lost",
        lastUpdate: last
          ? relativeTime(last, locale, new Date()).label
          : undefined,
        since: source.lostSince ?? undefined,
        onTryNow: source.reconnect,
      };
    }
    const summary = summarizeNow(
      source.session.status,
      buildSessionThread(source.items),
    );
    switch (summary.kind) {
      case "working":
        return {
          ...summary,
          stepName,
          onSelect: stepName ? onSelect : undefined,
        };
      case "waiting":
        return {
          kind: "waiting",
          stepName,
          onSelect: stepName ? onSelect : undefined,
        };
      default:
        return summary;
    }
  }, [source, locale, stepName, onSelect]);
  return <SessionNow state={state} />;
}
