import type { ReactNode } from "react";
import "../data.css";

export type NotificationGroupProps = {
  /** The day heading, already translated ("Today", "Yesterday"). */
  readonly heading: string;
  readonly children: ReactNode;
};

/**
 * A day's rows under its heading. The heading is a real `h3` under the page's
 * `h1`, so a screen reader can jump between days the way the eye does.
 */
export function NotificationGroup(
  { children, heading }: NotificationGroupProps,
) {
  return (
    <section
      className="ui-notification-group"
      data-ui-component="notificationGroup"
    >
      <h3 className="ui-notification-group__title">{heading}</h3>
      <ul className="ui-notification-group__rows">{children}</ul>
    </section>
  );
}

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

/** The page's title row: the heading and the one page-level action. */
export function NotificationPageHeader({ children }: NotificationListProps) {
  return (
    <div
      className="ui-notification-page-header"
      data-ui-component="notificationPageHeader"
    >
      {children}
    </div>
  );
}

/** The column that stacks day groups on the page. */
export function NotificationGroups({ children }: NotificationListProps) {
  return (
    <div
      className="ui-notification-groups"
      data-ui-component="notificationGroups"
    >
      {children}
    </div>
  );
}
