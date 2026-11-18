import type { ReactNode } from "react";
import "../data.css";

export type NotificationListProps = {
  readonly children: ReactNode;
};

/** The rows themselves, without day headings (the popover's flat list). */
export function NotificationList({ children }: NotificationListProps) {
  return (
    <ul
      className="ui-notification-group__rows"
      data-ui-component="notificationList"
    >
      {children}
    </ul>
  );
}
