import type { ReactNode } from "react";
import { Button } from "../atoms/Button.tsx";
import { Link } from "../atoms/Link.tsx";
import { Skeleton } from "../atoms/Skeleton.tsx";
import { VisuallyHidden } from "../atoms/VisuallyHidden.tsx";
import "../data.css";

export type NotificationPopoverProps = {
  readonly title: string;
  readonly markAllReadLabel?: string;
  readonly markAllReadDisabled?: boolean;
  readonly onMarkAllRead: () => void;
  readonly viewAllHref: string;
  readonly viewAllLabel: string;
  /** Said in the body when there is nothing to list. */
  readonly footerNote?: string;
  /**
   * What the panel shows. "scrolling" is a ready list long enough to scroll
   * under the block cap; the caller names it because the panel cannot tell
   * from its children alone.
   */
  readonly state?: "ready" | "loading" | "empty" | "failed" | "scrolling";
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly failedLabel?: string;
  readonly loadingLabel?: string;
  readonly actionFailedLabel?: string;
  readonly onActionRetry?: () => void;
  /** The rows; omitted for the loading, empty and failed states. */
  readonly children?: ReactNode;
};

/**
 * The 360px panel under the bell: a header with one quiet action, the newest
 * rows, and a way to the page. It scrolls inside itself and is capped to the
 * viewport, so the last row is always reachable without the panel growing past
 * the window.
 */
export function NotificationPopover(
  {
    actionFailedLabel,
    children,
    failedLabel = "Notifications could not load.",
    footerNote,
    loadingLabel = "Loading notifications",
    markAllReadDisabled = false,
    markAllReadLabel,
    onMarkAllRead,
    onActionRetry,
    onRetry,
    retryLabel = "Try again",
    state = "ready",
    title,
    viewAllHref,
    viewAllLabel,
  }: NotificationPopoverProps,
) {
  return (
    <div
      className="ui-notification-popover"
      data-state={state}
      data-ui-component="notificationPopover"
      data-variant="default"
    >
      <div className="ui-notification-popover__header">
        <h2 className="ui-notification-popover__title">{title}</h2>
        {markAllReadLabel === undefined
          ? null
          : (
            <span className="ui-notification-popover__action">
              <Button
                disabled={markAllReadDisabled}
                onClick={onMarkAllRead}
                variant="quiet"
              >
                {markAllReadLabel}
              </Button>
            </span>
          )}
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
          : (
            <>
              {actionFailedLabel === undefined ? null : (
                <div
                  className="ui-notification-popover__message ui-notification-popover__message--action"
                  role="alert"
                >
                  <span>{actionFailedLabel}</span>
                  {onActionRetry === undefined
                    ? null
                    : (
                      <Button onClick={onActionRetry} variant="quiet">
                        {retryLabel}
                      </Button>
                    )}
                </div>
              )}
              {children}
            </>
          )}
      </div>
      <div className="ui-notification-popover__footer">
        <Link href={viewAllHref} variant="quiet">{viewAllLabel}</Link>
      </div>
    </div>
  );
}
