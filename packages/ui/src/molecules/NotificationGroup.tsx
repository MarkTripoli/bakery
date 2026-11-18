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
