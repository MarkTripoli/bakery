import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  invalidateNotificationQueries,
  notificationCountQueryOptions,
  notificationsListQueryOptions,
} from "../api/query.ts";
import { useLiveEvents } from "../api/use-live-events.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useSession } from "../app/session-context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { NotificationsList } from "./NotificationsList.tsx";
import { useMarkAllRead } from "./useMarkAllRead.ts";
import { bellAccessibleName, bellStatusOf } from "./presentation.ts";

const NOTIFICATIONS_PATH = "/notifications";
const POPOVER_ROWS = 5;

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const principalId = useSession().identity?.principalId ?? null;
  const [open, setOpen] = useState(false);
  useLiveEvents(
    principalId === null ? [] : [{ type: "inbox", id: principalId }],
    () => void invalidateNotificationQueries(queryClient),
  );
  const count = useQuery(notificationCountQueryOptions(client, scope));
  const status = bellStatusOf(
    count.data?.unread ?? null,
    count.isError && count.data === undefined,
  );
  const close = useCallback(() => setOpen(false), []);

  // One name for both ways the bell reaches the screen: the badge is a drawn
  // cap, so the count has to live in the name or a screen reader never hears it.
  const accessibleLabel = bellAccessibleName(status, translate);
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
        onClick={() => void navigate({ to: NOTIFICATIONS_PATH })}
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
      // bell adds no wrapper of its own around the control, and keeps the one
      // polite live region.
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
  const { failed: markAllFailed, markAllRead: runMarkAllRead, marking } =
    useMarkAllRead("bell");
  const markAllRead = async () => {
    if (await runMarkAllRead()) onClose();
  };
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
      markAllReadLabel={nothingUnread
        ? undefined
        : marking
        ? translate("notifications.markAllRead.running")
        : translate("notifications.markAllRead")}
      markAllReadDisabled={marking}
      onMarkAllRead={() => void markAllRead()}
      failedLabel={translate("notifications.failed")}
      retryLabel={translate("notifications.tryAgain")}
      onRetry={() => void list.refetch()}
      actionFailedLabel={markAllFailed
        ? translate("notifications.markAll.failed")
        : undefined}
      onActionRetry={() => void markAllRead()}
      viewAllHref={NOTIFICATIONS_PATH}
      viewAllLabel={translate("notifications.popover.viewAll")}
      footerNote={translate("notifications.popover.empty")}
      state={list.isPending
        ? "loading"
        : list.isError
        ? "failed"
        : nothingUnread || rows.length === 0
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
