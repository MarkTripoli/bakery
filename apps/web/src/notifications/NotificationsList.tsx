import type { NotificationResponse } from "../api/client.ts";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  DAY_GROUP_LABEL,
  groupByDay,
  NOTIFICATION_COPY,
} from "./presentation.ts";

export type NotificationsListProps = {
  readonly rows: readonly NotificationResponse[];
  readonly unreadLabel: string;
  readonly menuLabel: string;
  readonly untitledLabel: string;
  readonly someoneLabel: string;
  readonly unavailableLabel: string;
  /** Closes the popover when a row is chosen; the page passes nothing. */
  readonly onOpened?: () => void;
  readonly onToggleRead?: (row: NotificationResponse) => void;
  readonly showMenu?: boolean;
  readonly showGroups?: boolean;
  readonly pendingReadIds?: ReadonlySet<string>;
  readonly highlightId?: string | null;
};

/**
 * The rows themselves. The popover and the page draw the same list: the page
 * adds day headings and the per-row menu, and nothing else about a row changes
 * between the two surfaces.
 */
export function NotificationsList(
  {
    highlightId = null,
    menuLabel,
    onOpened,
    onToggleRead,
    pendingReadIds,
    rows,
    serverNow,
    showGroups = true,
    showMenu = true,
    someoneLabel,
    unavailableLabel,
    unreadLabel,
    untitledLabel,
  }: NotificationsListProps & { readonly serverNow?: Date },
) {
  const { translate } = useI18n();
  const groups = showGroups ? groupByDay(rows, serverNow) : null;

  const renderRow = (row: NotificationResponse) => {
    const copy = NOTIFICATION_COPY[row.kind];
    const actorName = row.actor?.displayName ?? someoneLabel;
    const destinationTitle = row.destination.available
      ? row.destination.title ?? untitledLabel
      : unavailableLabel;
    // The step's own name and the document's own version number travel in the
    // row's anchor, the position within the target. Falling back to the task
    // title would print the same words on both lines, and the notification
    // revision is not the document's revision, so neither is a substitute.
    const headline = translate(copy.headline, {
      actor: actorName,
      step: row.targetAnchor ?? row.destination.title ?? untitledLabel,
      document: row.destination.title ?? untitledLabel,
    });
    const destination = copy.destination
      ? translate(copy.destination, {
        document: row.destination.title ?? untitledLabel,
        version: row.targetAnchor ?? String(row.revision),
      })
      : destinationTitle;
    return (
      <UI.NotificationRow
        key={row.id}
        id={row.id}
        unread={!row.read}
        unreadLabel={unreadLabel}
        headline={headline}
        destination={destination}
        actor={copy.lane === "person"
          ? {
            kind: "person",
            name: actorName,
            src: row.actor?.avatarUrl ?? null,
          }
          : { kind: "event", tile: copy.tile ?? "check" }}
        href={row.destination.available
          ? `/notifications?open=${row.id}&r=${row.revision}`
          : null}
        relativeTime={formatRelative(row.createdAt, serverNow)}
        exactTime={new Date(row.createdAt).toLocaleString()}
        highlighted={row.id === highlightId}
        onSelect={onOpened}
        menu={showMenu && onToggleRead
          ? (
            <UI.IconButton
              label={menuLabel}
              onClick={() => onToggleRead(row)}
              state={pendingReadIds?.has(row.id) ? "loading" : "default"}
            >
              <UI.IconGlyph name="menu" size="small" />
            </UI.IconButton>
          )
          : undefined}
      />
    );
  };

  if (groups === null) {
    return <UI.NotificationList>{rows.map(renderRow)}</UI.NotificationList>;
  }

  return (
    <UI.NotificationGroups>
      {groups.map(([group, groupRows]) => (
        <UI.NotificationGroup
          key={group}
          heading={translate(DAY_GROUP_LABEL[group])}
        >
          {groupRows.map(renderRow)}
        </UI.NotificationGroup>
      ))}
    </UI.NotificationGroups>
  );
}

/**
 * "5 min ago", "Yesterday": relative to the moment the list was read, so a row
 * does not drift while the page sits open. The exact date is always the row's
 * `title` and its accessible text, so the shortening never hides the truth.
 */
function formatRelative(createdAt: string, now: Date = new Date()): string {
  const created = new Date(createdAt);
  const minutes = Math.round((now.getTime() - created.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}
