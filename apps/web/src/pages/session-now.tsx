import { type ReactNode, useEffect, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type SessionNowState =
  | {
    readonly kind: "working";
    readonly toolName?: string;
    /** When the running tool started, for the elapsed time at the line's edge. */
    readonly since?: string;
    /** The step this line is about when the reader is looking at another. */
    readonly stepName?: string;
    readonly onSelect?: () => void;
  }
  | {
    readonly kind: "waiting";
    readonly stepName?: string;
    readonly onSelect?: () => void;
  }
  | { readonly kind: "failed"; readonly reason?: string }
  | {
    readonly kind: "lost";
    readonly lastUpdate?: string;
    /** When the connection was lost; "Try now" appears ten seconds later. */
    readonly since?: string;
    readonly onTryNow?: () => void;
  }
  | { readonly kind: "idle" };

const TRY_NOW_AFTER_MS = 10_000;

/** Whole seconds, minutes or hours, for the edge of a running line. */
function elapsed(since: string, now: number, locale: string | undefined) {
  const seconds = Math.max(
    0,
    Math.round((now - new Date(since).getTime()) / 1_000),
  );
  const unit = seconds < 60 ? "second" : seconds < 3_600 ? "minute" : "hour";
  const value = unit === "second"
    ? seconds
    : unit === "minute"
    ? Math.floor(seconds / 60)
    : Math.floor(seconds / 3_600);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
  }).format(value);
}

/**
 * What is happening in the session right now, as one quiet line above the
 * composer.
 *
 * This element is the thread's only live region: new step lines do not announce
 * themselves, so a screen reader hears one changing sentence instead of a
 * stream of rows. A status the client does not know renders nothing at all -
 * guessing would tell the reader something untrue about their run.
 */
export function SessionNow({ state }: { state: SessionNowState }) {
  const { locale, translate } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const ticking = (state.kind === "working" && state.since !== undefined) ||
    (state.kind === "lost" && state.since !== undefined);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);

  switch (state.kind) {
    case "working": {
      const what = state.toolName
        ? translate("session.thread.tool.running", { name: state.toolName })
        : translate("session.thread.now.working");
      return (
        <NowLine
          tone="active"
          edge={state.since === undefined
            ? undefined
            : elapsed(state.since, now, locale)}
          onSelect={state.onSelect}
        >
          {state.stepName
            ? translate("session.thread.now.step", {
              step: state.stepName,
              what,
            })
            : what}
        </NowLine>
      );
    }
    case "waiting": {
      const what = translate("session.thread.now.waiting");
      return (
        <NowLine tone="idle" onSelect={state.onSelect}>
          {state.stepName
            ? translate("session.thread.now.step", {
              step: state.stepName,
              what,
            })
            : what}
        </NowLine>
      );
    }
    case "failed":
      return (
        <NowLine tone="danger" icon="close">
          <strong>{translate("session.thread.now.failed")}</strong>
          {state.reason ? ` ${state.reason}` : null}
        </NowLine>
      );
    case "lost": {
      const canRetry = state.onTryNow !== undefined &&
        (state.since === undefined ||
          now - new Date(state.since).getTime() >= TRY_NOW_AFTER_MS);
      return (
        <NowLine
          tone="warning"
          icon="warning"
          action={canRetry
            ? (
              <UI.Button variant="quiet" onClick={state.onTryNow}>
                {translate("session.feed.tryNow")}
              </UI.Button>
            )
            : undefined}
        >
          {state.lastUpdate
            ? translate("session.thread.now.lost", { when: state.lastUpdate })
            : translate("session.feed.disconnected")}
        </NowLine>
      );
    }
    case "idle":
      return null;
  }
}

function NowLine(
  { action, children, edge, icon, onSelect, tone }: {
    action?: ReactNode;
    children: ReactNode;
    /** Fine print at the edge; hidden from assistive technology so it never re-announces. */
    edge?: string;
    icon?: UI.IconGlyphName;
    onSelect?: () => void;
    tone: "active" | "idle" | "danger" | "warning";
  },
) {
  const text = <span className="ui-session-now__text">{children}</span>;
  return (
    <p
      className="ui-session-now"
      data-tone={tone}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-ui-component="sessionNow"
    >
      <span className="ui-session-now__mark" aria-hidden="true">
        {icon
          ? <UI.IconGlyph name={icon} />
          : <span className="ui-session-now__dot" />}
      </span>
      {onSelect
        ? (
          <button
            type="button"
            className="ui-session-now__select"
            onClick={onSelect}
          >
            {text}
          </button>
        )
        : text}
      {edge
        ? (
          <span className="ui-session-now__elapsed" aria-hidden="true">
            {edge}
          </span>
        )
        : null}
      {action}
    </p>
  );
}
