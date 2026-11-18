import { useI18n } from "../i18n/I18nProvider.tsx";

export type SessionNowState =
  | { readonly kind: "working"; readonly toolName?: string }
  | { readonly kind: "waiting" }
  | { readonly kind: "failed"; readonly reason?: string }
  | { readonly kind: "lost"; readonly lastUpdate?: string }
  | { readonly kind: "idle" };

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
  const { translate } = useI18n();
  switch (state.kind) {
    case "working":
      return (
        <NowLine tone="active">
          {state.toolName
            ? translate("session.thread.tool.running", {
              name: state.toolName,
            })
            : translate("session.thread.now.working")}
        </NowLine>
      );
    case "waiting":
      return (
        <NowLine tone="idle">
          {translate("session.thread.now.waiting")}
        </NowLine>
      );
    case "failed":
      return (
        <NowLine tone="danger">
          {translate("session.thread.now.failed")}
          {state.reason ? ` ${state.reason}` : null}
        </NowLine>
      );
    case "lost":
      return (
        <NowLine tone="warning">
          {state.lastUpdate
            ? translate("session.thread.now.lost", {
              when: state.lastUpdate,
            })
            : translate("session.feed.disconnected")}
        </NowLine>
      );
    case "idle":
      return null;
  }
}

function NowLine(
  { children, tone }: { children: React.ReactNode; tone: string },
) {
  return (
    <p
      className="ui-session-now"
      data-tone={tone}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-ui-component="sessionNow"
    >
      <span className="ui-session-now__dot" aria-hidden="true" />
      <span className="ui-session-now__text">{children}</span>
    </p>
  );
}
