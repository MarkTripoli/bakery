import type { ReactNode } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import "../collaboration.css";

export type RunTimelineEvent = {
  description?: ReactNode;
  id: string;
  status?:
    | "queued"
    | "active"
    | "waiting"
    | "failed"
    | "complete"
    | "canceled"
    | "skipped"
    | "blocked";
  /**
   * `run` marks a run-level entry (queued, blocked, terminal) apart from a
   * step. `control` records a client-observed admission receipt, not an effect.
   */
  scope?: "step" | "run" | "control";
  /** Why a blocked run waits; shown with the entry. */
  reason?: ReactNode;
  time?: string;
  title: ReactNode;
};

export type RunTimelineConnectivity = "unknown" | "offline" | "reconnecting";

export type RunTimelineProps = {
  events: RunTimelineEvent[];
  label: string;
  /**
   * Connection to the server record. It is a banner, never a row, so a lost
   * connection cannot read as run progress.
   */
  connectivity?: RunTimelineConnectivity;
  /**
   * Text of the connectivity banner. Passing it renders the polite live
   * region, which stays mounted so a later change is announced.
   */
  connectivityLabel?: ReactNode;
  /**
   * `activity` is the inspector feed: glyph, title, then time and detail.
   * `steps` numbers each step as a session-pane section (HU-0); the active
   * step is the highlighted block.
   */
  variant?: "compact" | "detailed" | "activity" | "steps";
};

/** Ordered events from one run, without owning run state or actions. */
export function RunTimeline(
  { connectivity, connectivityLabel, events, label, variant = "detailed" }:
    RunTimelineProps,
) {
  // The owner is the labelled list so its entries are its direct children. The
  // connectivity banner is a sibling status region beside it, never a row.
  return (
    <>
      {connectivityLabel === undefined ? null : (
        <div
          aria-atomic="true"
          aria-live="polite"
          className="ui-run-timeline__connectivity"
          data-state={connectivity ?? "online"}
          role="status"
        >
          {connectivity ? connectivityLabel : null}
        </div>
      )}
      <ol
        aria-label={label}
        className={`ui-run-timeline ui-run-timeline--${variant}`}
        data-state={connectivity}
        data-variant={variant}
        data-ui-component="runTimeline"
      >
        {events.map((
          {
            description,
            id,
            reason,
            scope = "step",
            status = scope === "control" ? undefined : "queued",
            time,
            title,
          },
        ) => (
          <li
            className={`ui-run-timeline__event ui-run-timeline__event--${
              status ?? "control"
            }`}
            data-scope={scope}
            data-state={status}
            key={id}
          >
            {variant === "steps"
              ? (
                <>
                  <span className="ui-run-timeline__title">{title}</span>
                  <span className="ui-run-timeline__meta">
                    {description}
                    {description && reason ? " · " : null}
                    {reason}
                    {time ? <time dateTime={time}>{time}</time> : null}
                  </span>
                </>
              )
              : variant === "activity"
              ? (
                <>
                  <IconGlyph name="file" size="small" />
                  <div>
                    <span className="ui-run-timeline__title">{title}</span>
                    <span className="ui-run-timeline__meta">
                      {time ? <time dateTime={time}>{time}</time> : null}
                      {time && description ? " · " : null}
                      {description}
                    </span>
                  </div>
                </>
              )
              : (
                <>
                  <div>
                    <strong>{title}</strong>
                    {description ? <div>{description}</div> : null}
                    {reason
                      ? <div className="ui-run-timeline__reason">{reason}</div>
                      : null}
                  </div>
                  {time ? <time dateTime={time}>{time}</time> : null}
                </>
              )}
          </li>
        ))}
      </ol>
    </>
  );
}
