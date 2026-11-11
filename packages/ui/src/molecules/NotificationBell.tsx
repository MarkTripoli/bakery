import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../data.css";

export type NotificationBellProps =
  & Omit<
    SemanticNativeProps<ButtonHTMLAttributes<HTMLButtonElement>>,
    "children" | "type"
  >
  & {
    count?: number;
    label?: string;
    panel?: ReactNode;
    open?: boolean;
    state?: "default" | "open" | "focused";
    variant?: "unread" | "clear";
  };

export function NotificationBell(
  {
    count = 0,
    label = "Notifications",
    open = false,
    panel,
    state = "default",
    variant,
    ...unsafeProps
  }: NotificationBellProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const resolvedVariant = variant ?? (count > 0 ? "unread" : "clear");
  const resolvedState = state === "default" && open ? "open" : state;
  return (
    <span
      className={`ui-notification-bell ui-notification-bell--${resolvedVariant}`}
      data-ui-component="notificationBell"
      data-state={resolvedState}
      data-variant={resolvedVariant}
    >
      <button
        aria-expanded={open}
        aria-label={count ? `${label}, ${count} unread` : label}
        type="button"
        {...props}
      >
        ◉{count ? <span aria-hidden="true">{count}</span> : null}
      </button>
      {open && panel
        ? <span className="ui-notification-bell__panel">{panel}</span>
        : null}
    </span>
  );
}
