import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type { RunControl } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { useConnectivity } from "../app/connectivity.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { runControlCapabilitiesQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

type Receipt =
  | "idle"
  | "pending"
  | "accepted"
  | "unknown"
  | "conflict"
  | "forbidden"
  | "rejected";
type Intent = { key: string; input: RunControl };
/** What the menu can offer. Resume is the one primary button of a paused run, not a menu item. */
const MENU_ACTIONS = ["pause", "interrupt", "cancel"] as const;
const receiptLabels = {
  pending: "tasks.controls.requestPending",
  accepted: "tasks.controls.accepted",
  unknown: "tasks.controls.unknown",
  conflict: "tasks.controls.requestConflict",
  forbidden: "tasks.controls.requestForbidden",
  rejected: "tasks.controls.rejected",
} as const;
const HEADING_ID = "task-run-heading";

/**
 * The run's actions (#57, run section redesign): a primary Resume button while
 * the run is paused, and one "Run actions" menu that lists only what the server
 * allows, so there is nothing faded and nothing to explain. Admission receipts
 * are not worker effects; rendered run state comes from GET.
 */
export function TaskRunControls(
  { taskId, runId, enabled, paused, onReceipt }: {
    taskId: string;
    runId: string;
    enabled: boolean;
    /** The run is paused: Resume run is the primary button. */
    paused: boolean;
    onReceipt: (event: UI.RunTimelineEvent) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const cache = useQueryClient();
  const { translate: t, locale, timeZone } = useI18n();
  const capabilities = useQuery({
    ...runControlCapabilitiesQueryOptions(api, scope, runId),
    enabled: enabled && scope.organizationId !== null,
  });
  const [receipt, setReceipt] = useState<Receipt>("idle");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const intentRef = useRef<Intent | null>(null);
  const pending = useRef<AbortController | null>(null);
  const receiptSequence = useRef(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const online = useConnectivity() === "online";
  const authority =
    `${scope.sessionGeneration}:${scope.organizationId}:${taskId}:${runId}`;
  const currentAuthority = useRef(authority);
  currentAuthority.current = authority;
  useEffect(() => {
    return () => {
      pending.current?.abort();
    };
  }, []);

  const refreshWinner = async () => {
    setRefreshFailed(false);
    try {
      await cache.invalidateQueries({
        predicate: ({ queryKey: key }) => {
          if (
            key[0] !== "protected" || key[1] !== scope.sessionGeneration ||
            key[2] !== scope.organizationId
          ) return false;
          const input = key[4];
          if (typeof input !== "object" || input === null) return false;
          return ("id" in input && input.id === taskId) ||
            ("taskId" in input && input.taskId === taskId) ||
            ("runId" in input && input.runId === runId);
        },
      }, { throwOnError: true });
    } catch {
      if (currentAuthority.current === authority) setRefreshFailed(true);
    }
  };

  const submit = async (action: RunControl["action"]) => {
    if (
      pending.current || !scope.organizationId || !enabled || !navigator.onLine
    ) return;
    const previous = intentRef.current;
    if (
      previous && (receipt !== "unknown" || previous.input.action !== action)
    ) return;
    if (
      !previous && (capabilities.isError || capabilities.isFetching ||
        !capabilities.data?.actions.some((item) =>
          item.action === action && item.canRequest
        ))
    ) return;
    const next = previous ?? { key: crypto.randomUUID(), input: { action } };
    intentRef.current = next;
    setIntent(next);
    const controller = new AbortController();
    pending.current = controller;
    setReceipt("pending");
    let outcome: Receipt = "unknown";
    try {
      const result = await api.controlRun({
        organizationId: scope.organizationId,
        runId,
        input: next.input,
        idempotencyKey: next.key,
        signal: controller.signal,
      });
      if (result.ok) {
        if (result.data.id === runId && result.data.taskId === taskId) {
          outcome = "accepted";
        }
      } else if (result.error.kind === "problem") {
        const problem = result.error.problem;
        if (
          !problem.retryable && problem.status >= 400 && problem.status < 500 &&
          problem.status !== 408 && problem.status !== 429
        ) {
          outcome = problem.status === 403
            ? "forbidden"
            : problem.status === 409 || problem.status === 412
            ? "conflict"
            : "rejected";
        }
      }
    } catch {
      // An interrupted or malformed transport response cannot prove non-admission.
    }
    if (controller.signal.aborted || currentAuthority.current !== authority) {
      return;
    }
    onReceipt({
      id: `receipt:${next.key}:${++receiptSequence.current}`,
      scope: "control",
      title: `${
        t("tasks.controls.receiptAt", {
          time: formatDate(new Date(), locale, {
            timeZone,
            timeStyle: "short",
          }),
        })
      } — ${t(`tasks.controls.action.${action}`)}`,
      description: t(receiptLabels[outcome]),
    });
    await refreshWinner();
    if (controller.signal.aborted || currentAuthority.current !== authority) {
      return;
    }
    pending.current = null;
    // Only an outcome that is not confirmed keeps its request: the refreshed
    // capabilities decide what is offered next, so the menu is never stuck on
    // a request that was answered.
    if (outcome !== "unknown") {
      intentRef.current = null;
      setIntent(null);
    }
    setReceipt(outcome);
  };

  const forbidden = capabilities.error?.kind === "problem" &&
    capabilities.error.problem.status === 403;
  const allowed = (action: RunControl["action"]) =>
    capabilities.data?.actions.some((item) =>
      item.action === action && item.canRequest
    ) === true;
  const busy = receipt === "pending" || capabilities.isFetching;
  const canControl = enabled && online && !forbidden;
  const showResume = canControl && paused && allowed("resume");
  const unconfirmed = receipt === "unknown" && intent !== null;
  const items = !canControl ? [] : [
    ...MENU_ACTIONS.filter(allowed).map((action) => ({
      id: action,
      label: t(`tasks.controls.menu.${action}`),
      disabled: busy || (receipt === "unknown" && !unconfirmed),
    })),
    // Only after a request whose outcome is not confirmed, or when what the
    // server allows could not be read.
    ...(unconfirmed || capabilities.isError
      ? [{
        id: "check",
        label: t("tasks.controls.menu.refresh"),
        disabled: receipt === "pending",
      }]
      : []),
  ];
  const onSelect = (id: string) => {
    setMenuOpen(false);
    if (id === "cancel") {
      setConfirmCancel(true);
    } else if (id === "check") {
      if (unconfirmed && intent !== null) void submit(intent.input.action);
      else void capabilities.refetch();
    } else if (id === "pause" || id === "interrupt") {
      void submit(id);
    }
  };
  const confirm = async () => {
    setConfirmCancel(false);
    await submit("cancel");
    // After Cancel run, focus goes to the run line's heading.
    focusAfterPaint(() => document.getElementById(HEADING_ID));
  };

  return (
    <>
      {showResume && (
        <UI.Button
          disabled={busy}
          onClick={() => void submit("resume")}
          variant="primary"
        >
          {t("tasks.controls.menu.resume")}
        </UI.Button>
      )}
      {items.length > 0 && (
        <UI.Popover
          label={t("tasks.controls.menu.label")}
          onOpenChange={setMenuOpen}
          open={menuOpen}
          trigger={t("tasks.controls.menu.label")}
          triggerAppearance="toolbar"
          variant="interactive"
        >
          <UI.Menu
            aria-label={t("tasks.controls.menu.label")}
            items={items}
            onSelect={onSelect}
          />
        </UI.Popover>
      )}
      <UI.VisuallyHidden
        aria-atomic="true"
        aria-label={t("tasks.controls.receipt")}
        aria-live="polite"
        role="status"
      >
        {receipt !== "idle" ? t(receiptLabels[receipt]) : null}
      </UI.VisuallyHidden>
      {refreshFailed && (
        <UI.Text variant="caption">{t("tasks.controls.refreshFailed")}</UI.Text>
      )}
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            onClick={() => setConfirmCancel(false)}
            variant="secondary"
          >
            {t("tasks.controls.cancelDialog.keep")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            disabled={busy}
            onClick={() => void confirm()}
            variant="destructive"
          >
            {t("tasks.controls.cancelDialog.confirm")}
          </UI.Button>
        }
        onOpenChange={(open) => !open && setConfirmCancel(false)}
        open={confirmCancel}
        state="open"
        title={t("tasks.controls.cancelDialog.title")}
        variant="destructive"
      >
        <UI.Text>{t("tasks.controls.cancelDialog.body")}</UI.Text>
      </UI.AlertDialog>
    </>
  );
}
