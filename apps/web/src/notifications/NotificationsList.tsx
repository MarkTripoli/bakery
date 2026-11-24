import { useState } from "react";
import type { NotificationResponse } from "../api/client.ts";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  DAY_GROUP_LABEL,
  groupByDay,
  NOTIFICATION_COPY,
  versionOfAnchor,
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
  readonly onOpenRow?: (row: NotificationResponse) => void;
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
    onOpenRow,
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
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const groups = showGroups ? groupByDay(rows, serverNow) : null;
  const relativeTime = (createdAt: string, now: Date = new Date()): string => {
    const minutes = Math.round(
      (now.getTime() - new Date(createdAt).getTime()) / 60_000,
    );
    if (minutes < 1) return translate("notifications.time.justNow");
    if (minutes < 60) {
      return translate("notifications.time.minutes", { count: minutes });
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return translate("notifications.time.hours", { count: hours });
    }
    const days = Math.round(hours / 24);
    if (days === 1) return translate("notifications.time.yesterday");
    return translate("notifications.time.days", { count: days });
  };

  const renderRow = (row: NotificationResponse) => {
    const copy = NOTIFICATION_COPY[row.kind];
    const actorName = row.actor?.displayName ?? someoneLabel;
    const destinationTitle = row.destination.available
      ? row.destination.title ?? untitledLabel
      : unavailableLabel;
    const headline = translate(copy.headline, { actor: actorName });
    const version = row.kind === "document_version"
      ? versionOfAnchor(row.targetAnchor)
      : null;
    const destination = copy.destination && version !== null &&
        row.destination.available
      ? translate(copy.destination, {
        document: row.destination.title ?? untitledLabel,
        version,
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
        relativeTime={relativeTime(row.createdAt, serverNow)}
        exactTime={new Date(row.createdAt).toLocaleString()}
        highlighted={row.id === highlightId}
        onSelect={(event) => {
          onOpened?.();
          if (
            onOpenRow === undefined || event.button !== 0 ||
            event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
          ) return;
          event.preventDefault();
          onOpenRow(row);
        }}
        menu={showMenu && onToggleRead
          ? (
            <UI.Popover
              align="end"
              floating
              label={menuLabel}
              onOpenChange={(open) => setMenuOpenId(open ? row.id : null)}
              open={menuOpenId === row.id}
              trigger={<UI.IconGlyph name="menu" size="small" />}
              triggerLabel={menuLabel}
              variant="interactive"
            >
              <UI.Menu
                aria-label={menuLabel}
                items={[{
                  id: "toggle-read",
                  label: translate(
                    row.read
                      ? "notifications.row.markUnread"
                      : "notifications.row.markRead",
                  ),
                  disabled: pendingReadIds?.has(row.id) ?? false,
                }]}
                onSelect={() => {
                  setMenuOpenId(null);
                  onToggleRead(row);
                }}
              />
            </UI.Popover>
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
