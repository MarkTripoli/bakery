import type { ButtonHTMLAttributes, ReactNode } from "react";
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
    /**
     * Lets a caller own the interactive control instead of the bell's own
     * button. It receives the drawn face and returns the control that wraps
     * it, so a popover can supply its own trigger button. The caller owns the
     * layout, so the bell does not add its own wrapper around the control; the
     * bell keeps the polite live region, and the caller is responsible for
     * giving its control the same accessible name.
     */
    readonly control?: (face: ReactNode) => ReactNode;
  };

/**
 * The bell's drawn face: the glyph and the badge, with no button of its own.
 *
 * It exists as a separate piece because the two places a bell appears own
 * opposite controls: on a phone it is a link to the page, and from 744px up it
 * is a popover trigger. A control cannot nest inside another control, so the
 * face must not be one. The bell draws its own button unless a caller passes
 * `control`, and then the caller supplies the interactive control instead.
 */
function NotificationBellGlyph(
  { cap = 99, status = { state: "none" } }: {
    readonly cap?: number;
    readonly status?: NotificationBellStatus;
  },
) {
  const drawn = status.state === "unread"
    ? (status.count > cap ? `${cap}+` : String(status.count))
    : null;
  return (
    <>
      {
        /* The icon's own box is the badge's positioning cell, so the offset is
          measured from the glyph on both surfaces rather than from whichever
          button wraps it. */
      }
      <span className="ui-notification-bell__glyph">
        <IconGlyph name="bell" size="medium" />
        {drawn === null ? null : (
          <span
            aria-hidden="true"
            className="ui-notification-bell__badge"
            data-ui-part="notificationBadge"
          >
            {
              /* A count is read left to right in every locale, so the cap gets
                its own isolating run. Without it a right-to-left page renders
                "99+" as "+99", which reads as the wrong number. `dir` sits on
                the text, not on the badge: the badge's own `inset-inline-start`
                is what mirrors the pill to the icon's top left. */
            }
            <span className="ui-notification-bell__badge-count" dir="ltr">
              {drawn}
            </span>
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
      </span>
    </>
  );
}

/**
 * The one polite live region a bell announces arrivals through. It is a
 * component of its own because the bell reaches the screen two ways — its own
 * button on a phone, a popover's button from 744px up — and both need the same
 * batched sentence announced once, without moving focus.
 */
function NotificationArrival(
  { announcement }: { readonly announcement?: string | null },
) {
  return (
    <span
      aria-atomic="true"
      aria-live="polite"
      className="bakery-visually-hidden"
      data-ui-part="notificationArrival"
      role="status"
    >
      {announcement ?? ""}
    </span>
  );
}

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
    control,
    ...unsafeProps
  }: NotificationBellProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const resolvedState = state === "default" && open ? "open" : state;
  // The approved variants are "unread" and "clear" (the catalog's names); a
  // bell with nothing unread is "clear", and one whose count is unknown keeps
  // its own name.
  const variant = status.state === "none" ? "clear" : status.state;
  const accessibleName = status.state === "unread"
    ? unreadLabel(status.count)
    : status.state === "unknown"
    ? unknownLabel
    : label;
  const face = <NotificationBellGlyph cap={cap} status={status} />;
  // A caller that supplies the control owns its own layout, so the bell does
  // not wrap it: the bell's wrapper is what positions the badge beside its own
  // button, and `.ui-notification-bell button` would otherwise restyle every
  // button inside a popover panel. The live region stays with the bell either
  // way, outside the control, so an arrival is announced once.
  if (control) {
    return (
      <>
        {control(face)}
        <NotificationArrival announcement={arrivalAnnouncement} />
      </>
    );
  }
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
        {face}
      </button>
      <NotificationArrival announcement={arrivalAnnouncement} />
    </span>
  );
}
