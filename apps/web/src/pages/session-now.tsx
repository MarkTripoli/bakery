import { useEffect, useState } from "react";
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
        <UI.SessionNowLine
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
        </UI.SessionNowLine>
      );
    }
    case "waiting": {
      const what = translate("session.thread.now.waiting");
      return (
        <UI.SessionNowLine tone="idle" onSelect={state.onSelect}>
          {state.stepName
            ? translate("session.thread.now.step", {
              step: state.stepName,
              what,
            })
            : what}
        </UI.SessionNowLine>
      );
    }
    case "failed":
      return (
        <UI.SessionNowLine tone="danger" icon="close">
          <strong>{translate("session.thread.now.failed")}</strong>
          {state.reason ? ` ${state.reason}` : null}
        </UI.SessionNowLine>
      );
    case "lost": {
      const canRetry = state.onTryNow !== undefined &&
        (state.since === undefined ||
          now - new Date(state.since).getTime() >= TRY_NOW_AFTER_MS);
      return (
        <UI.SessionNowLine
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
        </UI.SessionNowLine>
      );
    }
    case "idle":
      return null;
  }
}
