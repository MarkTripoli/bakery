import type { ReactNode } from "react";
import "../data.css";

export type NotificationPageHeaderProps = {
  readonly children: ReactNode;
  /** "mark-all-read-running" while the page's one action is in flight. */
  readonly state?: "default" | "mark-all-read-running";
};

/** The page's title row: the heading and the one page-level action. */
export function NotificationPageHeader(
  { children, state = "default" }: NotificationPageHeaderProps,
) {
  return (
    <div
      className="ui-notification-page-header"
      data-state={state}
      data-ui-component="notificationPageHeader"
      data-variant="default"
    >
      {children}
    </div>
  );
}
