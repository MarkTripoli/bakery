import { useCallback, useState } from "react";
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

  if (viewport === "phone") {
    return (
      <UI.NotificationBell
        label={accessibleLabel}
        status={status}
        unreadLabel={(value) =>
          translate("notifications.bell.unread", { count: value })}
        unknownLabel={translate("notifications.bell.unknown")}
        onClick={() => {
          globalThis.location.assign(NOTIFICATIONS_PATH);
        }}
      />
    );
  }

  return (
    <UI.Popover
      label={accessibleLabel}
      open={open}
      onOpenChange={setOpen}
      triggerAppearance="plain"
      triggerLabel={accessibleLabel}
      trigger={<NotificationBellGlyph status={status} />}
    >
      <NotificationBellPopover
        status={status}
        onClose={close}
      />
    </UI.Popover>
  );
}

function NotificationBellGlyph({
  status,
}: {
  readonly status: ReturnType<typeof bellStatusOf>;
}) {
  const { translate } = useI18n();
  return (
    <UI.NotificationBell
      label={translate("notifications.bell.label")}
      status={status}
      unreadLabel={(value) =>
        translate("notifications.bell.unread", { count: value })}
      unknownLabel={translate("notifications.bell.unknown")}
    />
  );
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
