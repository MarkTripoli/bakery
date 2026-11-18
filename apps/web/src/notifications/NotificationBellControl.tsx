import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  notificationCountQueryOptions,
  notificationsListQueryOptions,
} from "../api/query.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { NotificationsList } from "./NotificationsList.tsx";
import { bellStatusOf } from "./presentation.ts";

const NOTIFICATIONS_PATH = "/notifications";
const POPOVER_ROWS = 6;

/**
 * The bell in the shell's top bar, with the recent-notifications popover on a
 * wide screen. Below 744px it is a plain link to the page, because a 360px
 * popover anchored under a phone header is a worse way to read the same list.
 */
export function NotificationBellControl() {
  const { translate } = useI18n();
  const client = useBakeryApi();
  const scope = useProtectedScope();
  const viewport = useShellViewport();
  const [open, setOpen] = useState(false);
  const count = useQuery(notificationCountQueryOptions(client, scope));
  const status = bellStatusOf(
    count.data?.unread ?? null,
    count.isError && count.data === undefined,
  );
  const close = useCallback(() => setOpen(false), []);

  const accessibleLabel = translate("notifications.bell.label");
  // One polite announcement per flush: the sentence carries the number that
  // arrived since the last count, and the badge updates in place beside it.
  const arrival = useArrivalAnnouncement(count.data?.unread ?? null);

  if (viewport === "phone") {
    return (
      <UI.NotificationBell
        label={accessibleLabel}
        status={status}
        unreadLabel={(value) =>
          translate("notifications.bell.unread", { count: value })}
        unknownLabel={translate("notifications.bell.unknown")}
        arrivalAnnouncement={arrival}
        onClick={() => {
          globalThis.location.assign(NOTIFICATIONS_PATH);
        }}
      />
    );
  }

  return (
    <UI.NotificationBell
      label={accessibleLabel}
      status={status}
      unreadLabel={(value) =>
        translate("notifications.bell.unread", { count: value })}
      unknownLabel={translate("notifications.bell.unknown")}
      arrivalAnnouncement={arrival}
      // The popover supplies the control, so its trigger is the bell's drawn
      // face alone: a button here would nest one control inside another. The
      // bell still owns the wrapper and the one polite live region.
      control={(face) => (
        <UI.Popover
          align="end"
          label={accessibleLabel}
          open={open}
          onOpenChange={setOpen}
          trigger={face}
          triggerAppearance="plain"
          triggerLabel={accessibleLabel}
        >
          <NotificationBellPopover status={status} onClose={close} />
        </UI.Popover>
      )}
    />
  );
}

/**
 * Announces only the *increase* in the unread count, and only after a short
 * quiet period, so a burst of arrivals is one sentence rather than five. A
 * decrease (someone read something) is silent: it is not news.
 */
function useArrivalAnnouncement(unread: number | null): string | null {
  const { translate } = useI18n();
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const previous = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = unread;
    if (unread === null || before === null || unread <= before) return;
    if (timer.current !== null) globalThis.clearTimeout(timer.current);
    const arrived = unread - before;
    timer.current = globalThis.setTimeout(() => {
      setAnnouncement(
        translate("notifications.bell.newArrivals", { count: arrived }),
      );
      timer.current = null;
    }, 800);
    return () => {
      if (timer.current !== null) {
        globalThis.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [translate, unread]);

  return announcement;
}

function NotificationBellPopover(
  { onClose, status }: {
    readonly status: ReturnType<typeof bellStatusOf>;
    readonly onClose: () => void;
  },
) {
  const { translate } = useI18n();
  const client = useBakeryApi();
  const scope = useProtectedScope();
  const list = useQuery(
    notificationsListQueryOptions(client, scope, {
      filter: "all",
      limit: POPOVER_ROWS,
    }),
  );
  const rows = list.data?.items ?? [];
  const nothingUnread = status.state === "none";

  return (
    <UI.NotificationPopover
      title={translate("notifications.title")}
      markAllReadLabel={translate("notifications.markAllRead")}
      markAllReadDisabled={nothingUnread}
      markAllReadDisabledReason={translate(
        "notifications.markAllRead.disabled",
      )}
      onMarkAllRead={() => {
        // Marking all read from the popover is the page's action; the page owns
        // the toast and the cutoff, so the popover just goes there.
        globalThis.location.assign(NOTIFICATIONS_PATH);
      }}
      viewAllHref={NOTIFICATIONS_PATH}
      viewAllLabel={translate("notifications.popover.viewAll")}
      footerNote={translate("notifications.popover.empty")}
      state={list.isPending
        ? "loading"
        : list.isError
        ? "failed"
        : rows.length === 0
        ? "empty"
        : "ready"}
    >
      <NotificationsList
        rows={rows}
        unreadLabel={translate("notifications.row.unread")}
        menuLabel={translate("notifications.row.menu")}
        untitledLabel={translate("notifications.row.untitled")}
        someoneLabel={translate("notifications.row.someone")}
        unavailableLabel={translate("notifications.row.unavailable")}
        onOpened={onClose}
        showMenu={false}
        showGroups={false}
      />
    </UI.NotificationPopover>
  );
}
