import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import { invalidateNotificationQueries } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type MarkAllReadSurface = "page" | "bell";

export type MarkAllReadToast = {
  readonly surface: MarkAllReadSurface;
  readonly tone: "success" | "error";
  readonly message: string;
  readonly undoBatchId: string | null;
};

type MarkAllReadState = {
  readonly marking: boolean;
  readonly failed: boolean;
  readonly toast: MarkAllReadToast | null;
};

const UNDO_WINDOW_MS = 10_000;

const idle: MarkAllReadState = { failed: false, marking: false, toast: null };

let state: MarkAllReadState = idle;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function write(next: MarkAllReadState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clearDismissTimer() {
  if (dismissTimer === null) return;
  globalThis.clearTimeout(dismissTimer);
  dismissTimer = null;
}

function scheduleDismiss() {
  clearDismissTimer();
  dismissTimer = globalThis.setTimeout(() => {
    dismissTimer = null;
    write({ ...state, toast: null });
  }, UNDO_WINDOW_MS);
}

export function useMarkAllRead(surface: MarkAllReadSurface) {
  const client = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const current = useSyncExternalStore(subscribe, () => state, () => state);

  const showToast = useCallback(
    (toast: Omit<MarkAllReadToast, "surface">) => {
      write({ ...state, toast: { ...toast, surface } });
      if (toast.undoBatchId === null) clearDismissTimer();
      else scheduleDismiss();
    },
    [surface],
  );

  const markAllRead = useCallback(async () => {
    if (state.marking) return;
    clearDismissTimer();
    write({ failed: false, marking: true, toast: null });
    const cutoff = new Date().toISOString();
    const result = await client.markAllNotificationsRead({
      organizationId: scope.organizationId!,
      readBefore: cutoff,
      idempotencyKey: `mark-all-${cutoff}`,
    }).catch(() => null);
    if (result === null || !result.ok) {
      write({ failed: true, marking: false, toast: null });
      return;
    }
    const marked = result.data.marked;
    const arrived = result.data.remainingUnread ?? 0;
    write({ failed: false, marking: false, toast: null });
    showToast({
      message: arrived > 0
        ? translate("notifications.markAllRead.doneWithArrivals", {
          count: marked,
          arrived,
        })
        : translate("notifications.markAllRead.done", { count: marked }),
      tone: "success",
      undoBatchId: marked > 0 ? result.data.batchId ?? null : null,
    });
    await invalidateNotificationQueries(queryClient);
  }, [client, queryClient, scope.organizationId, showToast, translate]);

  const undo = useCallback(async () => {
    const batchId = state.toast?.undoBatchId ?? null;
    if (batchId === null) return;
    clearDismissTimer();
    write({ ...state, toast: null });
    const result = await client.undoMarkAllNotificationsRead({
      organizationId: scope.organizationId!,
      batchId,
      idempotencyKey: `undo-${batchId}`,
    });
    if (!result.ok) {
      showToast({
        message: translate("notifications.undo.failed"),
        tone: "error",
        undoBatchId: null,
      });
      return;
    }
    showToast({
      message: translate("notifications.undo.done", {
        count: result.data.restored,
      }),
      tone: "success",
      undoBatchId: null,
    });
    await invalidateNotificationQueries(queryClient);
  }, [client, queryClient, scope.organizationId, showToast, translate]);

  const dismissToast = useCallback(() => {
    clearDismissTimer();
    write({ ...state, toast: null });
  }, []);

  return {
    dismissToast,
    failed: current.failed,
    markAllRead,
    marking: current.marking,
    toast: current.toast?.surface === surface ? current.toast : null,
    undo,
  };
}
