import type { ReactNode } from "react";
import "../data.css";

export type LogEntry = {
  id: string;
  message: ReactNode;
  source?: ReactNode;
  timestamp?: string;
};
export type LogViewerProps = {
  entries: LogEntry[];
  label: string;
  state?: "loading" | "ready" | "reconnecting" | "paused" | "error";
  variant?: "static" | "streaming";
  presentation?: "default" | "output";
  stateLabel?: string;
  errorLabel?: string;
};

export function LogViewer(
  {
    entries,
    label,
    state = "ready",
    variant = "static",
    presentation = "default",
    stateLabel = state,
    errorLabel = "Log stream unavailable.",
  }: LogViewerProps,
) {
  return (
    <section
      aria-label={label}
      aria-live={variant === "streaming" ? "polite" : undefined}
      className={`ui-log-viewer ui-log-viewer--${variant}`}
      data-state={state}
      data-variant={variant}
      data-presentation={presentation}
      data-ui-component="logViewer"
      tabIndex={presentation === "output" ? 0 : undefined}
    >
      {presentation === "default"
        ? <p className="ui-log-viewer__state">{stateLabel}</p>
        : null}
      {state === "error" ? <p role="alert">{errorLabel}</p> : null}
      <ol>
        {entries.map((entry) => (
          <li key={entry.id}>
            {entry.timestamp
              ? <time dateTime={entry.timestamp}>{entry.timestamp}</time>
              : null}
            {entry.source ? <span>{entry.source}</span> : null}
            <code>{entry.message}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}
