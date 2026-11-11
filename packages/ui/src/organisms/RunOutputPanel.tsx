import { type ReactNode, useRef } from "react";
import { Button } from "../atoms/Button.tsx";
import { Link } from "../atoms/Link.tsx";
import { type LogEntry, LogViewer } from "./LogViewer.tsx";
import "../run.css";

export type RunOutputState =
  | "loading"
  | "live"
  | "reconnecting"
  | "paused"
  | "error"
  | "complete"
  | "reset"
  | "truncated"
  | "interrupted";

export type RunOutputPanelProps = {
  title: string;
  entries: LogEntry[];
  state: RunOutputState;
  statusLabel: string;
  captureLabel: string;
  savedLabel?: string;
  notice?: string;
  archiveLinks?: { id: string; href: string; label: string }[];
  archiveActions?: ReactNode;
  downloadLink?: {
    href: string;
    label: string;
    accessibleLabel?: string;
    filename?: string;
  };
  latestLabel: string;
};

export function RunOutputPanel(
  {
    title,
    entries,
    state,
    statusLabel,
    captureLabel,
    savedLabel,
    notice,
    archiveLinks,
    archiveActions,
    downloadLink,
    latestLabel,
  }: RunOutputPanelProps,
) {
  const outputRef = useRef<HTMLDivElement>(null);
  return (
    <section
      aria-label={title}
      className="ui-run-card"
      data-ui-component="runOutputPanel"
      data-variant="default"
      data-state={state}
    >
      <h2>{title}</h2>
      <div className="ui-run-card__row" role="status">
        <span className="ui-run-card__badge">{statusLabel}</span>
        <span className="ui-run-card__meta">{captureLabel}</span>
        {savedLabel
          ? <span className="ui-run-card__meta">{savedLabel}</span>
          : null}
      </div>
      {notice
        ? <p className="ui-run-card__notice" role="status">{notice}</p>
        : null}
      <div ref={outputRef}>
        <LogViewer
          label={`${title} ${captureLabel}`}
          entries={entries}
          presentation="output"
          variant={state === "live" ? "streaming" : "static"}
        />
      </div>
      <div className="ui-run-card__actions">
        {downloadLink
          ? (
            <Link
              href={downloadLink.href}
              download={downloadLink.filename}
              aria-label={downloadLink.accessibleLabel}
              variant="button"
            >
              {downloadLink.label}
            </Link>
          )
          : null}
        {archiveLinks?.map((link) => (
          <Link key={link.id} href={link.href} variant="button">
            {link.label}
          </Link>
        ))}
        {archiveActions}
        <Button
          variant="outline"
          onClick={() => {
            const viewer = outputRef.current?.querySelector("section");
            viewer?.scrollTo({ top: viewer.scrollHeight });
            viewer?.focus({ preventScroll: true });
          }}
        >
          {latestLabel}
        </Button>
      </div>
    </section>
  );
}
