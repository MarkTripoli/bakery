import type { MouseEvent, ReactNode } from "react";
import { Avatar } from "../atoms/Avatar.tsx";
import { IconGlyph, type IconGlyphName } from "../atoms/IconGlyph.tsx";
import { VisuallyHidden } from "../atoms/VisuallyHidden.tsx";
import "../data.css";

/**
 * The event tile used when a notification has no person behind it. A person's
 * notification shows their avatar; a system event shows the glyph for what
 * happened, so the lane is never empty and never ambiguous.
 */
export type NotificationRowTile =
  | "check"
  | "warning"
  | "shield"
  | "question"
  | "document";

export type NotificationRowProps = {
  /** Line 1: what happened, already composed by the caller. */
  readonly headline: ReactNode;
  /** Line 2: where it happened; null when the destination is unavailable. */
  readonly destination: ReactNode;
  /** The exact date and time, carried as the time's accessible text. */
  readonly exactTime: string;
  readonly relativeTime: string;
  readonly unread: boolean;
  /** The hidden word before line 1 that marks an unread row to a screen reader. */
  readonly unreadLabel: string;
  /** `person` shows an avatar, `event` shows a glyph tile. */
  readonly actor:
    | {
      readonly kind: "person";
      readonly name: string;
      readonly src?: string | null;
    }
    | { readonly kind: "event"; readonly tile: NotificationRowTile }
    | null;
  /** The link target, or null while the destination is unknown/gone. */
  readonly href: string | null;
  /** The row menu button, drawn in its own lane so it never collides with text. */
  readonly menu?: ReactNode;
  /** The notification id, used as the row's DOM id so a link can anchor to it. */
  readonly id: string;
  /** Outlines the row once when it was arrived at from `/notifications?item=`. */
  readonly highlighted?: boolean;
  readonly onSelect?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * The row's catalogued state. It is derived (highlighted, unavailable
   * destination, unread, read) unless the caller names one, which only
   * "long-text" needs: the row cannot tell its own text is the worst case.
   */
  readonly state?: NotificationRowState;
};

export type NotificationRowState =
  | "read"
  | "unread"
  | "highlighted"
  | "long-text"
  | "unavailable-destination";

const TILE_GLYPH: Record<NotificationRowTile, IconGlyphName> = {
  check: "check",
  warning: "warning",
  shield: "shield",
  question: "question",
  document: "document",
};

const TILE_TONE: Record<NotificationRowTile, string> = {
  check: "neutral",
  warning: "error",
  shield: "neutral",
  question: "neutral",
  document: "neutral",
};

/**
 * One notification, in the same shape on the page and in the popover: unread
 * lane, actor lane, two text lines, time lane, menu lane. Fixed lanes mean the
 * time never wraps and the menu never drifts when line 1 grows.
 */
export function NotificationRow(
  {
    actor,
    destination,
    exactTime,
    headline,
    highlighted = false,
    href,
    id,
    menu,
    onSelect,
    relativeTime,
    state,
    unread,
    unreadLabel,
  }: NotificationRowProps,
) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className="ui-notification-row__dot"
        data-ui-part="notificationUnreadDot"
      />
      <span aria-hidden="true" className="ui-notification-row__actor">
        {actor?.kind === "person"
          ? (
            <Avatar
              alt=""
              fallback={actor.name.slice(0, 1).toUpperCase()}
              size="small"
              src={actor.src ?? undefined}
            />
          )
          : actor?.kind === "event"
          ? (
            <span
              className={`ui-notification-row__tile ui-notification-row__tile--${
                TILE_TONE[actor.tile]
              }`}
            >
              <IconGlyph name={TILE_GLYPH[actor.tile]} size="small" />
            </span>
          )
          : null}
      </span>
      <span className="ui-notification-row__text">
        <span
          className="ui-notification-row__headline"
          data-rail="truncation-allowed"
        >
          {unread ? <VisuallyHidden>{unreadLabel}</VisuallyHidden> : null}
          {headline}
        </span>
        <span
          className="ui-notification-row__destination"
          data-rail="truncation-allowed"
          data-ui-part="notificationDestination"
        >
          {destination}
        </span>
      </span>
      <time
        className="ui-notification-row__time"
        dateTime={exactTime}
        title={exactTime}
      >
        <span aria-hidden="true">{relativeTime}</span>
        <VisuallyHidden>{exactTime}</VisuallyHidden>
      </time>
    </>
  );

  return (
    <li
      className="ui-notification-row"
      data-highlighted={highlighted ? "true" : undefined}
      data-state={state ?? (highlighted
        ? "highlighted"
        : href === null
        ? "unavailable-destination"
        : unread
        ? "unread"
        : "read")}
      data-ui-component="notificationRow"
      data-unread={unread ? "true" : "false"}
      data-variant={actor?.kind ?? "event"}
      id={`notification-${id}`}
    >
      {href === null
        ? <div className="ui-notification-row__link">{body}</div>
        : (
          <a
            className="ui-notification-row__link"
            href={href}
            onClick={onSelect}
          >
            {body}
          </a>
        )}
      {menu === undefined
        ? null
        : <span className="ui-notification-row__menu">{menu}</span>}
    </li>
  );
}
