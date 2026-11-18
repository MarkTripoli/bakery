import type { ReactNode } from "react";
import "../data.css";

export type NotificationGroupsState = "ready" | "empty" | "loading" | "error";

export type NotificationGroupsProps = {
  readonly children: ReactNode;
  /** What the column is showing; the caller supplies the matching children. */
  readonly state?: NotificationGroupsState;
};

/** The column that stacks day groups on the page. */
export function NotificationGroups(
  { children, state = "ready" }: NotificationGroupsProps,
) {
  return (
    <div
      className="ui-notification-groups"
      data-state={state}
      data-ui-component="notificationGroups"
      data-variant="default"
    >
      {children}
    </div>
  );
}
