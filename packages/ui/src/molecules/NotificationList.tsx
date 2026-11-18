import type { ReactNode } from "react";
import "../data.css";

export type NotificationListState = "ready" | "empty" | "loading" | "error";

export type NotificationListProps = {
  readonly children: ReactNode;
  /** What the list is showing; the caller supplies the matching children. */
  readonly state?: NotificationListState;
};

/** The rows themselves, without day headings (the popover's flat list). */
export function NotificationList(
  { children, state = "ready" }: NotificationListProps,
) {
  return (
    <ul
      className="ui-notification-group__rows"
      data-state={state}
      data-ui-component="notificationList"
      data-variant="default"
    >
      {children}
    </ul>
  );
}
