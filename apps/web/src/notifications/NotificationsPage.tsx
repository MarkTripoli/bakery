import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  notificationCountQueryOptions,
  notificationsListQueryOptions,
} from "../api/query.ts";
import type { NotificationResponse } from "../api/client.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { NotificationsList } from "./NotificationsList.tsx";
import { isNotificationView, type NotificationView } from "./presentation.ts";

export type NotificationsPageProps = {
  readonly view: NotificationView;
  readonly onViewChange: (view: NotificationView) => void;
  /** The row to outline once, from `/notifications?item=`. */
  readonly item?: string | null;
};

const PAGE_SIZE = 30;

/**
 * `/notifications`: the whole inbox, with the three views in the URL so Back and
 * a reload return to the tab the person was reading.
 */
export function NotificationsPage(
  { item = null, onViewChange, view }: NotificationsPageProps,
) {
  const { translate } = useI18n();
  const client = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();

  const [pages, setPages] = useState<string[]>([]);
  const [marking, setMarking] = useState(false);
  const [toast, setToast] = useState<
    { tone: "success" | "error"; message: string } | null
  >(null);

  // A new view starts from its first page: cursors belong to one filter.
  const cursor = pages.length === 0 ? undefined : pages[pages.length - 1];
  const list = useQuery(
    notificationsListQueryOptions(client, scope, {
      filter: view,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const count = useQuery(notificationCountQueryOptions(client, scope));

  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const nextCursor = list.data?.nextCursor ?? null;
  const unreadCount = count.data?.unread ?? null;
  const hasUnread = unreadCount !== null && unreadCount > 0;

  const refresh = useCallback(async () => {
    setPages([]);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notifications.list"] }),
      queryClient.invalidateQueries({ queryKey: ["notifications.count"] }),
    ]);
  }, [queryClient]);

  const markAllRead = useCallback(async () => {
    // Bounded by the moment it was pressed: anything arriving during it stays
    // unread and shows up at the top with its dot.
    const cutoff = new Date().toISOString();
    setMarking(true);
    try {
      const result = await client.markAllNotificationsRead({
        organizationId: scope.organizationId!,
        readBefore: cutoff,
        idempotencyKey: `mark-all-${cutoff}`,
      });
      if (!result.ok) {
        setToast({
          tone: "error",
          message: translate("notifications.markAllRead.failed"),
        });
        return;
      }
      const marked = result.data.marked;
      const arrived = result.data.remainingUnread ?? 0;
      setToast({
        tone: "success",
        message: arrived > 0
          ? translate("notifications.markAllRead.doneWithArrivals", {
            count: marked,
            arrived,
          })
          : translate("notifications.markAllRead.done", { count: marked }),
      });
      await refresh();
    } finally {
      setMarking(false);
    }
  }, [client, refresh, scope.organizationId, translate]);

  const toggleRead = useCallback(
    async (row: NotificationResponse) => {
      const result = await client.setNotificationRead({
        organizationId: scope.organizationId!,
        id: row.id,
        read: !row.read,
        expectedCasVersion: row.revision,
        idempotencyKey: `read-${row.id}-${row.revision}-${!row.read}`,
      });
      if (result.ok) await refresh();
    },
    [client, refresh, scope.organizationId],
  );

  const tabs = [
    { id: "all", content: null },
    { id: "unread", content: null },
    { id: "mentions", content: null },
  ].map((tab) => ({
    ...tab,
    label: tab.id === "all"
      ? translate("notifications.views.all")
      : tab.id === "unread"
      ? hasUnread
        ? translate("notifications.views.unreadWithCount", {
          count: unreadCount,
        })
        : translate("notifications.views.unread")
      : translate("notifications.views.mentions"),
  }));

  const empty = rows.length === 0 && !list.isPending && !list.isError;
  const emptyKey = (): { title: string; sentence: string } => {
    if (view === "unread") {
      return {
        title: translate("notifications.empty.unread.title"),
        sentence: translate("notifications.empty.unread.sentence"),
      };
    }
    if (view === "mentions") {
      return {
        title: translate("notifications.empty.mentions.title"),
        sentence: translate("notifications.empty.mentions.sentence"),
      };
    }
    return {
      title: translate("notifications.empty.all.title"),
      sentence: translate("notifications.empty.all.sentence"),
    };
  };

  return (
    <UI.Stack gap="spacious">
      <UI.NotificationPageHeader>
        <UI.Heading level="page">{translate("notifications.title")}</UI.Heading>
        <UI.Button
          disabled={!hasUnread || marking}
          title={hasUnread
            ? undefined
            : translate("notifications.markAllRead.disabled")}
          onClick={() => void markAllRead()}
          variant="secondary"
        >
          {marking
            ? translate("notifications.markAllRead.running")
            : translate("notifications.markAllRead")}
        </UI.Button>
      </UI.NotificationPageHeader>
      <UI.Tabs
        aria-label={translate("notifications.title")}
        onSelect={(id) => {
          if (isNotificationView(id)) {
            setPages([]);
            onViewChange(id);
          }
        }}
        selectedId={view}
        tabs={tabs}
      />
      {toast === null
        ? null
        : (
          <UI.Toast tone={toast.tone} onDismiss={() => setToast(null)}>
            {toast.message}
          </UI.Toast>
        )}
      {list.isError && rows.length > 0
        ? (
          <UI.InlineNotice
            tone="error"
            action={
              <UI.Button onClick={() => void refresh()} variant="quiet">
                {translate("notifications.tryAgain")}
              </UI.Button>
            }
          >
            {translate("notifications.failed")}
          </UI.InlineNotice>
        )
        : null}
      {list.isPending
        ? (
          <UI.Stack gap="compact">
            {Array.from({ length: 6 }).map((_, index) => (
              <UI.Skeleton key={index} shape="text" />
            ))}
          </UI.Stack>
        )
        : list.isError && rows.length === 0
        ? (
          <UI.InlineNotice
            tone="error"
            action={
              <UI.Button onClick={() => void refresh()} variant="quiet">
                {translate("notifications.tryAgain")}
              </UI.Button>
            }
          >
            {translate("notifications.failed")}
          </UI.InlineNotice>
        )
        : empty
        ? (
          <UI.EmptyState
            title={emptyKey().title}
            description={emptyKey().sentence}
            variant="filtered"
          />
        )
        : (
          <>
            <NotificationsList
              rows={rows}
              highlightId={item}
              unreadLabel={translate("notifications.row.unread")}
              menuLabel={translate("notifications.row.menu")}
              untitledLabel={translate("notifications.row.untitled")}
              someoneLabel={translate("notifications.row.someone")}
              unavailableLabel={translate("notifications.row.unavailable")}
              onToggleRead={(row) => void toggleRead(row)}
            />
            {nextCursor === null ? null : (
              <UI.Button
                onClick={() => setPages([...pages, nextCursor])}
                variant="secondary"
              >
                {translate("notifications.showMore")}
              </UI.Button>
            )}
          </>
        )}
    </UI.Stack>
  );
}
