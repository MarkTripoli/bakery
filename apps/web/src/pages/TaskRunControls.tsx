import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type { RunControl } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { useConnectivity } from "../app/connectivity.ts";
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
const actions = ["pause", "resume", "cancel", "interrupt"] as const;
const receiptLabels = {
  pending: "tasks.controls.requestPending",
  accepted: "tasks.controls.accepted",
  unknown: "tasks.controls.unknown",
  conflict: "tasks.controls.requestConflict",
  forbidden: "tasks.controls.requestForbidden",
  rejected: "tasks.controls.rejected",
} as const;

/** Admission receipts are not worker effects; rendered run state comes from GET. */
export function TaskRunControls(
  { taskId, runId, enabled, onReceipt }: {
    taskId: string;
    runId: string;
    enabled: boolean;
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
    setReceipt(outcome);
  };

  const unavailable = !enabled || capabilities.isPending ||
    capabilities.isError;
  const forbidden = capabilities.error?.kind === "problem" &&
    capabilities.error.problem.status === 403;
  return (
    <UI.Stack>
      <UI.Heading level="subsection">{t("tasks.controls.heading")}</UI.Heading>
      <UI.Text>{t("tasks.controls.scope")}</UI.Text>
      {!online && <UI.Text>{t("tasks.controls.offline")}</UI.Text>}
      {unavailable && (
        <UI.Text>
          {t(
            forbidden
              ? "tasks.controls.requestForbidden"
              : "tasks.controls.unavailable",
          )}
        </UI.Text>
      )}
      {!unavailable &&
        capabilities.data?.actions.some((item) =>
          item.reason === "unsupported"
        ) && (
        <UI.InlineNotice
          tone="information"
          data-ui-region="steering-unsupported"
        >
          {t("tasks.conversation.steering.unsupported")}
        </UI.InlineNotice>
      )}
      <UI.Stack>
        {actions.map((action) => {
          const capability = capabilities.data?.actions.find((item) =>
            item.action === action
          );
          return (
            <UI.Stack key={action}>
              <UI.Button
                disabled={!online || unavailable || capabilities.isFetching ||
                  receipt !== "idle" || !capability?.canRequest}
                onClick={() => void submit(action)}
              >
                {t(`tasks.controls.action.${action}`)}
              </UI.Button>
              {!unavailable && capability && !capability.canRequest &&
                (
                  <UI.Text>
                    {t(`tasks.controls.reason.${capability.reason}`)}
                  </UI.Text>
                )}
            </UI.Stack>
          );
        })}
      </UI.Stack>
      <UI.Text
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={t("tasks.controls.receipt")}
      >
        {receipt !== "idle" ? t(receiptLabels[receipt]) : null}
        {intent
          ? (
            <>
              {" "}
              {t(`tasks.controls.action.${intent.input.action}`)} —{" "}
              {t("tasks.controls.key")}: {intent.key}
            </>
          )
          : null}
      </UI.Text>
      {refreshFailed && <UI.Text>{t("tasks.controls.refreshFailed")}</UI.Text>}
      {receipt === "unknown" && intent && (
        <UI.Button
          disabled={!online || !enabled}
          onClick={() => void submit(intent.input.action)}
        >
          {t("tasks.controls.retry")}
        </UI.Button>
      )}
      {receipt !== "idle" && receipt !== "pending" && receipt !== "unknown" && (
        <UI.Button
          onClick={() => {
            intentRef.current = null;
            setIntent(null);
            setReceipt("idle");
          }}
        >
          {t("tasks.controls.newRequest")}
        </UI.Button>
      )}
      <UI.Button
        disabled={!online || receipt === "pending" || capabilities.isFetching}
        onClick={() => void refreshWinner()}
      >
        {t("tasks.controls.refresh")}
      </UI.Button>
    </UI.Stack>
  );
}
