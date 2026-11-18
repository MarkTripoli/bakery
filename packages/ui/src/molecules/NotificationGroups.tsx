import type { ReactNode } from "react";
import "../data.css";

export type NotificationGroupsProps = {
  readonly children: ReactNode;
};

/** The column that stacks day groups on the page. */
export function NotificationGroups({ children }: NotificationGroupsProps) {
  return (
    <div
      className="ui-notification-groups"
      data-ui-component="notificationGroups"
    >
      {children}
    </div>
  );
}
