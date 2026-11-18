import type { ReactNode } from "react";
import "../data.css";

export type NotificationPageHeaderProps = {
  readonly children: ReactNode;
};

/** The page's title row: the heading and the one page-level action. */
export function NotificationPageHeader(
  { children }: NotificationPageHeaderProps,
) {
  return (
    <div
      className="ui-notification-page-header"
      data-ui-component="notificationPageHeader"
    >
      {children}
    </div>
  );
}
