import type { ButtonHTMLAttributes } from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import "../data.css";

/**
 * How the badge should read. `unknown` is distinct from `0` on purpose: an
 * unknown count (offline, or the request failed) draws a hollow ring and says
 * "count unavailable", because a confident "nothing unread" that later turns
 * out wrong is worse than admitting the number is not known yet.
 */
export type NotificationBellStatus =
  | { readonly state: "none" }
  | { readonly state: "unread"; readonly count: number }
  | { readonly state: "unknown" };

export type NotificationBellProps =
  & Omit<
    SemanticNativeProps<ButtonHTMLAttributes<HTMLButtonElement>>,
    "children" | "type"
  >
  & {
    /** The badge state; omit for `none`. */
    readonly status?: NotificationBellStatus;
    /** Word for the control, used inside the accessible name. */
    readonly label: string;
    /** Accessible name for the unread state, given the true count. */
    readonly unreadLabel: (count: number) => string;
    /** Accessible name for the unknown state. */
    readonly unknownLabel: string;
    /** The drawn badge cap: 100 or more reads "99+" (the name keeps the truth). */
    readonly cap?: number;
    readonly open?: boolean;
    readonly state?: "default" | "open" | "focused";
    /**
     * The batched arrival sentence ("2 new notifications"). It rides a polite
     * live region so a new arrival is announced without moving focus; the
     * caller batches it, so three arrivals in a second are one announcement.
     */
    readonly arrivalAnnouncement?: string | null;
  };

/**
 * The bell at the right end of the top bar. Always a number in the badge, never
 * a bare dot, so the badge and the page can never disagree.
 */
export function NotificationBell(
  {
    cap = 99,
    label,
    open = false,
    state = "default",
    status = { state: "none" },
    unknownLabel,
    unreadLabel,
    arrivalAnnouncement = null,
    ...unsafeProps
  }: NotificationBellProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const resolvedState = state === "default" && open ? "open" : state;
  const variant = status.state;
  const accessibleName = status.state === "unread"
    ? unreadLabel(status.count)
    : status.state === "unknown"
    ? unknownLabel
    : label;
  const drawn = status.state === "unread"
    ? (status.count >= cap ? `${cap}+` : String(status.count))
    : null;
  return (
    <span
      className={`ui-notification-bell ui-notification-bell--${variant}`}
      data-ui-component="notificationBell"
      data-state={resolvedState}
      data-variant={variant}
    >
      <button
        aria-expanded={open}
        aria-label={accessibleName}
        type="button"
        {...props}
      >
        <IconGlyph name="bell" size="medium" />
        {drawn === null ? null : (
          <span
            aria-hidden="true"
            className="ui-notification-bell__badge"
            data-ui-part="notificationBadge"
          >
            {drawn}
          </span>
        )}
        {status.state === "unknown"
          ? (
            <span
              aria-hidden="true"
              className="ui-notification-bell__badge ui-notification-bell__badge--unknown"
              data-ui-part="notificationBadgeUnknown"
            />
          )
          : null}
      </button>
      <span
        aria-live="polite"
        aria-atomic="true"
        className="bakery-visually-hidden"
        data-ui-part="notificationArrival"
        role="status"
      >
        {arrivalAnnouncement ?? ""}
      </span>
    </span>
  );
}
