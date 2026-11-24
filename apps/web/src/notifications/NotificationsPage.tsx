import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  invalidateNotificationQueries,
  notificationCountQueryOptions,
  notificationsInfiniteQueryOptions,
} from "../api/query.ts";
import { useConnectivity } from "../app/connectivity.ts";
import type { NotificationResponse } from "../api/client.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { NotificationsList } from "./NotificationsList.tsx";
import { isNotificationView, type NotificationView } from "./presentation.ts";

export type NotificationsPageProps = {
  readonly view: NotificationView;
  readonly onViewChange: (view: NotificationView) => void;
  readonly onOpenRow?: (row: NotificationResponse) => void;
  /** The row to outline once, from `/notifications?item=`. */
  readonly item?: string | null;
};

const SCROLL_MEMORY_KEY = "bakery.notifications.scroll";
const PAGE_SIZE = 30;
const UNDO_WINDOW_MS = 10_000;

/**
 * `/notifications`: the whole inbox, with the three views in the URL so Back and
 * a reload return to the tab the person was reading.
 */
export function NotificationsPage(
  { item = null, onOpenRow, onViewChange, view }: NotificationsPageProps,
) {
  const { translate } = useI18n();
  const client = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();

  const offline = useConnectivity() === "offline";
  const entryKey = useRouterState({
    select: (state) => state.location.state.__TSR_key,
  });
  const [marking, setMarking] = useState(false);
  const [pendingReadIds, setPendingReadIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [undo, setUndo] = useState<string | null>(null);
  const [toast, setToast] = useState<
    { tone: "success" | "error"; message: string } | null
  >(null);

  const list = useInfiniteQuery(
    notificationsInfiniteQueryOptions(client, scope, {
      filter: view,
      limit: PAGE_SIZE,
    }),
  );
  const count = useQuery(notificationCountQueryOptions(client, scope));

  const rows = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );
  const unreadCount = count.data?.unread ?? null;
  const hasUnread = unreadCount !== null && unreadCount > 0;

  const refresh = useCallback(
    () => invalidateNotificationQueries(queryClient),
    [queryClient],
  );

  useEffect(() => {
    if (undo === null) return;
    const timer = globalThis.setTimeout(() => {
      setUndo(null);
      setToast(null);
    }, UNDO_WINDOW_MS);
    return () => globalThis.clearTimeout(timer);
  }, [undo]);

  const openRow = useCallback((row: NotificationResponse) => {
    globalThis.sessionStorage.setItem(
      SCROLL_MEMORY_KEY,
      JSON.stringify({ entry: entryKey, y: globalThis.scrollY }),
    );
    onOpenRow?.(row);
  }, [entryKey, onOpenRow]);

  const scrollRestored = useRef(false);
  useEffect(() => {
    if (scrollRestored.current || rows.length === 0) return;
    scrollRestored.current = true;
    const remembered = globalThis.sessionStorage.getItem(SCROLL_MEMORY_KEY);
    globalThis.sessionStorage.removeItem(SCROLL_MEMORY_KEY);
    if (remembered === null || item !== null) return;
    const saved: unknown = JSON.parse(remembered);
    if (
      typeof saved !== "object" || saved === null || !("entry" in saved) ||
      !("y" in saved) || saved.entry !== entryKey || typeof saved.y !== "number"
    ) return;
    const y = saved.y;
    globalThis.requestAnimationFrame(() =>
      globalThis.requestAnimationFrame(() => globalThis.scrollTo(0, y))
    );
  }, [entryKey, item, rows]);

  const scrolled = useRef<string | null>(null);
  const [outlined, setOutlined] = useState<string | null>(item);
  useEffect(() => {
    setOutlined(item);
  }, [item]);
  useEffect(() => {
    if (item === null || scrolled.current === item) return;
    const target = globalThis.document.getElementById(`notification-${item}`);
    if (target === null) return;
    scrolled.current = item;
    target.scrollIntoView({ block: "center" });
    const timer = globalThis.setTimeout(() => setOutlined(null), 2500);
    return () => globalThis.clearTimeout(timer);
  }, [item, rows]);

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
      setUndo(marked > 0 ? result.data.batchId ?? null : null);
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

  const undoMarkAll = useCallback(async () => {
    if (undo === null) return;
    const batchId = undo;
    setUndo(null);
    const result = await client.undoMarkAllNotificationsRead({
      organizationId: scope.organizationId!,
      batchId,
      idempotencyKey: `undo-${batchId}`,
    });
    if (!result.ok) {
      setToast({
        tone: "error",
        message: translate("notifications.undo.failed"),
      });
      return;
    }
    setToast({
      tone: "success",
      message: translate("notifications.undo.done", {
        count: result.data.restored,
      }),
    });
    await refresh();
  }, [client, refresh, scope.organizationId, translate, undo]);

  const toggleRead = useCallback(
    async (row: NotificationResponse) => {
      setPendingReadIds((current) => new Set(current).add(row.id));
      try {
        const result = await client.setNotificationRead({
          organizationId: scope.organizationId!,
          id: row.id,
          read: !row.read,
          expectedCasVersion: row.revision,
          idempotencyKey: `read-${row.id}-${row.revision}-${!row.read}`,
        });
        if (result.ok) await refresh();
        else {
          setToast({
            tone: "error",
            message: translate("notifications.row.saveFailed"),
          });
        }
      } finally {
        setPendingReadIds((current) => {
          const next = new Set(current);
          next.delete(row.id);
          return next;
        });
      }
    },
    [client, refresh, scope.organizationId, translate],
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
          if (isNotificationView(id)) onViewChange(id);
        }}
        selectedId={view}
        tabs={tabs}
      />
      {toast === null ? null : (
        <UI.Toast
          action={undo === null || toast.tone !== "success"
            ? undefined
            : (
              <UI.Button onClick={() => void undoMarkAll()} variant="quiet">
                {translate("notifications.undo")}
              </UI.Button>
            )}
          tone={toast.tone}
          onDismiss={() => {
            setToast(null);
            setUndo(null);
          }}
        >
          {toast.message}
        </UI.Toast>
      )}
      {offline
        ? (
          <UI.InlineNotice tone="information">
            {translate("notifications.offline")}
          </UI.InlineNotice>
        )
        : null}
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
              highlightId={outlined}
              unreadLabel={translate("notifications.row.unread")}
              menuLabel={translate("notifications.row.menu")}
              untitledLabel={translate("notifications.row.untitled")}
              someoneLabel={translate("notifications.row.someone")}
              unavailableLabel={translate("notifications.row.unavailable")}
              onOpenRow={onOpenRow === undefined ? undefined : openRow}
              onToggleRead={(row) => void toggleRead(row)}
              pendingReadIds={pendingReadIds}
            />
            {list.hasNextPage
              ? (
                <UI.Button
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                  variant="secondary"
                >
                  {translate("notifications.showMore")}
                </UI.Button>
              )
              : null}
          </>
        )}
    </UI.Stack>
  );
}
