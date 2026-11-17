import type { ReactNode } from "react";
import { Button } from "../atoms/Button.tsx";
import { Skeleton } from "../atoms/Skeleton.tsx";
import { VisuallyHidden } from "../atoms/VisuallyHidden.tsx";
import "../data.css";

export type NotificationPopoverProps = {
  readonly title: string;
  readonly markAllReadLabel: string;
  readonly markAllReadDisabled: boolean;
  /** The reason, shown as a tooltip and as the button's description. */
  readonly markAllReadDisabledReason: string;
  readonly onMarkAllRead: () => void;
  readonly viewAllHref: string;
  readonly viewAllLabel: string;
  /** Said in the body when there is nothing to list. */
  readonly footerNote?: string;
  readonly state?: "ready" | "loading" | "empty" | "failed";
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly failedLabel?: string;
  readonly loadingLabel?: string;
  /** The rows; omitted for the loading, empty and failed states. */
  readonly children?: ReactNode;
};

/**
 * The 360px panel under the bell: a header with one quiet action, the six
 * newest rows, and a way to the page. It scrolls inside itself and is capped to
 * the viewport, so the last row is always reachable without the panel growing
 * past the window.
 */
export function NotificationPopover(
  {
    children,
    failedLabel = "Notifications could not load.",
    footerNote,
    loadingLabel = "Loading notifications",
    markAllReadDisabled,
    markAllReadDisabledReason,
    markAllReadLabel,
    onMarkAllRead,
    onRetry,
    retryLabel = "Try again",
    state = "ready",
    title,
    viewAllHref,
    viewAllLabel,
  }: NotificationPopoverProps,
) {
  const reasonId = markAllReadDisabled
    ? "notification-mark-all-reason"
    : undefined;
  return (
    <div
      className="ui-notification-popover"
      data-state={state}
      data-ui-component="notificationPopover"
      data-variant="default"
    >
      <div className="ui-notification-popover__header">
        <h2 className="ui-notification-popover__title">{title}</h2>
        <span className="ui-notification-popover__action">
          <Button
            aria-describedby={reasonId}
            disabled={markAllReadDisabled}
            onClick={onMarkAllRead}
            title={markAllReadDisabled ? markAllReadDisabledReason : undefined}
            variant="quiet"
          >
            {markAllReadLabel}
          </Button>
          {reasonId === undefined ? null : (
            <VisuallyHidden id={reasonId}>
              {markAllReadDisabledReason}
            </VisuallyHidden>
          )}
        </span>
      </div>
      <div
        className="ui-notification-popover__body"
        aria-busy={state === "loading" ? "true" : undefined}
      >
        {state === "loading"
          ? (
            <>
              <VisuallyHidden>{loadingLabel}</VisuallyHidden>
              <Skeleton shape="text" />
              <Skeleton shape="text" />
              <Skeleton shape="text" />
            </>
          )
          : state === "failed"
          ? (
            <div className="ui-notification-popover__message" role="alert">
              <span>{failedLabel}</span>
              {onRetry === undefined
                ? null
                : (
                  <Button onClick={onRetry} variant="quiet">
                    {retryLabel}
                  </Button>
                )}
            </div>
          )
          : state === "empty"
          ? <p className="ui-notification-popover__message">{footerNote}</p>
          : children}
      </div>
      <div className="ui-notification-popover__footer">
        <a href={viewAllHref}>{viewAllLabel}</a>
      </div>
    </div>
  );
}
