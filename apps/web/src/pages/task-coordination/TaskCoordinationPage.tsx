import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { isUuid } from "@bakery/contracts/contracts";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../api/context.tsx";
import {
  applicationRepositoryRolesQueryOptions,
  artifactsListQueryOptions,
  coordinationPlansQueryOptions,
  repositoriesListQueryOptions,
  taskQueryOptions,
  workflowQueryOptions,
} from "../../api/query.ts";
import { useLiveEvents } from "../../api/use-live-events.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { commandFailure } from "../task-conversation/model.ts";
import { LaneCards, useLaneColumns } from "./LaneRow.tsx";
import { PlanProvenance, PlanTicketClaim } from "./PlanProvenance.tsx";
import { FingerprintRow } from "../FingerprintRow.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { ShellFlushMain, ShellSlot } from "../../shell/shell-slots.tsx";
import {
  cancelable,
  committed,
  currentPlan,
  type HandoffState,
  hasProvenance,
  laneCounts,
  type PlanLane,
  planLanes,
  planOrigin,
} from "./model.ts";

const POLL_MS = 5_000;
const LIVE_POLL_MS = 10_000;
const READS = new Set([
  "tasks.get",
  "coordinationPlans.list",
  "applicationRepositoryRoles.list",
  "artifacts.list",
  "workflows.get",
]);

type CancelPhase =
  | "idle"
  | "confirming"
  | "canceling"
  | "unknown"
  | "forbidden"
  | "conflict"
  | "error";

/**
 * The coordination plan of a parent task: its current revision, one row per
 * lane (repository, status, prerequisites, declared and committed handoffs,
 * child task), the aggregate state including partial delivery, and the cancel
 * action. Every value is read from the server; events only trigger re-reads.
 */
export function TaskCoordinationPage(
  { provenance = true, references, taskId }: {
    /**
     * Show plan origin and digest. Always on in the app; a design fixture of
     * Paper frames that do not draw them turns it off.
     */
    provenance?: boolean;
    /** Task reference text by id; a design fixture supplies Paper's keys. */
    references?: Readonly<Record<string, string>>;
    taskId: string;
  },
) {
  const { translate: t, locale } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const cache = useQueryClient();
  const connectivity = useConnectivity();
  const online = connectivity === "online";
  const valid = isUuid(taskId);
  const organizationId = scope.organizationId;
  const enabled = valid && organizationId !== null;
  const refreshRef = useRef<() => void>(() => {});
  const task = useQuery({
    ...taskQueryOptions(api, scope, taskId),
    enabled,
  });
  const live = useLiveEvents(
    task.data
      ? [
        { type: "task", id: taskId },
        { type: "application", id: task.data.applicationId },
      ]
      : [],
    () => refreshRef.current(),
  );
  const poll = online ? (live === "live" ? LIVE_POLL_MS : POLL_MS) : false;
  const plans = useQuery({
    ...coordinationPlansQueryOptions(api, scope, taskId),
    enabled,
    refetchInterval: poll,
  });
  const plan = currentPlan(plans.data?.items ?? []);
  const applicationId = task.data?.applicationId ?? plan?.applicationId;
  const roles = useQuery({
    ...applicationRepositoryRolesQueryOptions(api, scope, applicationId ?? ""),
    enabled: enabled && applicationId !== undefined,
  });
  const repositories = useQuery({
    ...repositoriesListQueryOptions(api, scope, { limit: 100 }),
    enabled,
  });
  const origin = plan ? planOrigin(plan) : undefined;
  const workflowId = origin?.kind === "saved_workflow"
    ? origin.workflowId
    : undefined;
  // The name is a nicety: a failed or forbidden read falls back to the id.
  const workflow = useQuery({
    ...workflowQueryOptions(api, scope, workflowId ?? ""),
    enabled: enabled && workflowId !== undefined,
  });
  const lanes: PlanLane[] = plan
    ? planLanes(plan, roles.data, repositories.data)
    : [];
  const artifactReads = useQueries({
    queries: lanes.map((lane) => ({
      ...artifactsListQueryOptions(api, scope, {
        taskId: lane.childTaskId ?? undefined,
        limit: 100,
      }),
      enabled: enabled && lane.childTaskId !== null,
      refetchInterval: poll,
    })),
  });
  const refresh = () =>
    cache.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === "protected" && queryKey[2] === organizationId &&
        READS.has(String(queryKey[3])),
    });
  refreshRef.current = () => void refresh();

  const phone = useShellViewport() === "phone";
  const handoff = (
    input: { fromLane: string; outputKey: string },
  ): HandoffState => {
    const index = lanes.findIndex((lane) => lane.key === input.fromLane);
    const output = lanes[index]?.outputs.find((item) =>
      item.key === input.outputKey
    );
    return output && committed(output, artifactReads[index]?.data?.items)
      ? "committed"
      : "waiting";
  };
  const laneColumns = useLaneColumns({
    handoff,
    titles: new Map(lanes.map((lane) => [lane.key, lane.title])),
    artifacts: (lane) => {
      const index = lanes.indexOf(lane);
      return artifactReads[index]?.data?.items;
    },
    reference: (id) => references?.[id] ?? id.slice(0, 8),
  });

  // ---- cancel ------------------------------------------------------------
  const [phase, setPhase] = useState<CancelPhase>("idle");
  const cancelKey = useRef<{ planId: string; key: string } | null>(null);
  useEffect(() => {
    // The safe choice takes focus when the confirmation replaces the button.
    // A timer lets the key press that opened it finish activating first.
    if (phase !== "confirming") return;
    const timer = setTimeout(
      () =>
        document.querySelector<HTMLButtonElement>("[data-plan-cancel-keep]")
          ?.focus(),
      0,
    );
    return () => clearTimeout(timer);
  }, [phase]);
  const cancel = async () => {
    if (organizationId === null || !plan) return;
    const pending = cancelKey.current?.planId === plan.id
      ? cancelKey.current
      : { planId: plan.id, key: crypto.randomUUID() };
    cancelKey.current = pending;
    setPhase("canceling");
    const result = await api.cancelCoordinationPlan({
      organizationId,
      planId: plan.id,
      idempotencyKey: pending.key,
    });
    if (result.ok) {
      cancelKey.current = null;
      setPhase("idle");
      void refresh();
      return;
    }
    const failure = commandFailure(result.error);
    if (failure === "unknown") return setPhase("unknown");
    cancelKey.current = null;
    setPhase(failure);
    void refresh();
  };

  // ---- view --------------------------------------------------------------
  const failure = plans.error ?? task.error;
  const forbidden = failure?.kind === "problem" &&
    failure.problem.status === 403;
  const missing = !valid ||
    (task.error?.kind === "problem" && task.error.problem.status === 404);
  const loading = valid && (task.isPending || plans.isPending) &&
    failure === null;
  const stale = plans.isError && plans.data !== undefined;
  const counts = laneCounts(lanes);
  const reference = (id: string) => references?.[id] ?? id.slice(0, 8);
  const heading = t("tasks.coordination.heading");
  const emptyHeader = (
    <UI.PageHeader
      variant="split"
      title={heading}
      subtitle={task.data ? <span>{task.data.title}</span> : undefined}
    />
  );
  const planTone = !plan
    ? "information"
    : plan.status === "completed"
    ? "success"
    : plan.status === "failed"
    ? "destructive"
    : plan.status === "partially_delivered"
    ? "warning"
    : plan.status === "canceled" || plan.status === "superseded"
    ? "neutral"
    : "information";
  const body = missing
    ? <UI.Text>{t("tasks.coordination.notFound")}</UI.Text>
    : forbidden
    ? (
      <UI.ErrorState
        title={t("shell.states.forbiddenTitle")}
        description={t("tasks.coordination.forbidden")}
      />
    )
    : loading
    ? (
      <UI.Stack gap="standard" role="status" aria-busy="true">
        <UI.Text>{t("tasks.coordination.loading")}</UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    )
    : failure !== null && plans.data === undefined
    ? (
      <UI.ErrorState
        title={t("tasks.coordination.error")}
        action={
          <UI.Button
            onClick={() => {
              void plans.refetch();
              void task.refetch();
            }}
          >
            {t("tasks.coordination.retry")}
          </UI.Button>
        }
      />
    )
    : !plan
    ? (
      <UI.EmptyState
        inset="page"
        icon={<UI.IconGlyph name="lanes" size="large" />}
        title={t("tasks.coordination.empty.title")}
        description={t("tasks.coordination.empty.description")}
      />
    )
    : (
      <>
        {plan.status === "partially_delivered" && (
          <UI.InlineNotice
            layout="bar"
            inset="page"
            icon="caution"
            tone="warning"
            data-ui-region="partial-delivery"
          >
            {t("tasks.coordination.partial", {
              completed: String(counts.completed),
              stopped: String(counts.stopped + counts.failed),
            })}
          </UI.InlineNotice>
        )}
        {counts.stale > 0 && (
          <UI.InlineNotice
            layout="bar"
            inset="page"
            icon="caution"
            tone="warning"
            data-ui-region="stale-lanes"
          >
            {t("tasks.coordination.staleNotice")}
          </UI.InlineNotice>
        )}
        {plan.status === "superseded" && (
          <UI.InlineNotice layout="bar" inset="page" tone="neutral">
            {t("tasks.coordination.superseded")}
          </UI.InlineNotice>
        )}
        {phone
          ? (
            <>
              <LaneCards
                lanes={lanes}
                titles={new Map(lanes.map((lane) => [lane.key, lane.title]))}
                artifacts={(lane) =>
                  artifactReads[lanes.indexOf(lane)]?.data?.items}
                reference={reference}
                handoff={handoff}
              />
              {
                /* The phone header keeps Paper's height, so origin and digest
                  follow the lanes (frame 2JQJ-0 has blank space there). */
              }
              {provenance && hasProvenance(plan) && (
                <UI.StackedRow
                  data-ui-region="plan-provenance-phone"
                  title={
                    <PlanProvenance
                      plan={plan}
                      workflowName={workflow.data?.name}
                    />
                  }
                >
                  <PlanTicketClaim plan={plan} />
                </UI.StackedRow>
              )}
            </>
          )
          : (
            <UI.DataTable
              variant="ruled"
              inset="page"
              caption={t("tasks.coordination.lanes")}
              columns={laneColumns}
              rows={lanes}
              getRowKey={(lane) => lane.key}
              getRowAttributes={(lane) => ({
                "data-lane-key": lane.key,
                "data-lane-status": lane.status,
              })}
            />
          )}
        {cancelable(plan) && phase !== "idle" && (
          <UI.Stack gap="compact" data-ui-region="plan-cancel">
            {phase === "confirming" || phase === "canceling" ||
                phase === "unknown"
              ? (
                <>
                  <UI.Text>{t("tasks.coordination.cancel.confirm")}</UI.Text>
                  <UI.Inline variant="actions">
                    <UI.Button
                      variant="destructive"
                      loading={phase === "canceling"}
                      disabled={phase === "canceling" || !online}
                      onClick={() => void cancel()}
                    >
                      {phase === "unknown"
                        ? t("tasks.coordination.cancel.retry")
                        : t("tasks.coordination.cancel.confirmAction")}
                    </UI.Button>
                    <UI.Button
                      data-plan-cancel-keep=""
                      variant="outline"
                      disabled={phase === "canceling"}
                      onClick={() =>
                        setPhase("idle")}
                    >
                      {t("tasks.coordination.cancel.keep")}
                    </UI.Button>
                  </UI.Inline>
                </>
              )
              : null}
            <div aria-atomic="true" aria-live="polite" role="status">
              {phase === "unknown" && (
                <UI.InlineNotice role="none" tone="warning">
                  {t("tasks.coordination.cancel.unknown")}
                </UI.InlineNotice>
              )}
              {phase === "forbidden" && (
                <UI.InlineNotice role="none" tone="error">
                  {t("tasks.coordination.cancel.forbidden")}
                </UI.InlineNotice>
              )}
              {phase === "conflict" && (
                <UI.InlineNotice role="none" tone="error">
                  {t("tasks.coordination.cancel.conflict")}
                </UI.InlineNotice>
              )}
              {phase === "error" && (
                <UI.InlineNotice role="none" tone="error">
                  {t("tasks.coordination.cancel.failed")}
                </UI.InlineNotice>
              )}
            </div>
          </UI.Stack>
        )}
      </>
    );
  return (
    <>
      <ShellFlushMain inset="pageWide" phoneHeader="page" />
      {!phone && (
        <ShellSlot name="breadcrumbs">
          <UI.Breadcrumbs
            items={[
              {
                label: (
                  <RouterLink to="/tasks/$taskId" params={{ taskId }}>
                    <UI.IconGlyph name="chevron-left" size="small" />
                    {t("tasks.coordination.back")}
                  </RouterLink>
                ),
              },
              { label: <UI.DataText>{reference(taskId)}</UI.DataText> },
            ]}
          />
        </ShellSlot>
      )}
      {!phone && plan && cancelable(plan) && phase === "idle" && (
        <ShellSlot name="actions">
          <UI.Button
            variant="destructive-outline"
            disabled={!online}
            onClick={() => setPhase("confirming")}
          >
            {t("tasks.coordination.cancel.action")}
          </UI.Button>
        </ShellSlot>
      )}
      <div data-ui-region="task-coordination">
        {phone && (
          <UI.TopBar
            variant="compact"
            leading={
              <RouterLink
                to="/tasks/$taskId"
                params={{ taskId }}
                variant="back"
              >
                <UI.IconGlyph name="chevron-left" size="small" />
                {t("tasks.coordination.back")}
              </RouterLink>
            }
            actions={plan && cancelable(plan) && phase === "idle"
              ? (
                <UI.Button
                  variant="destructive-quiet"
                  disabled={!online}
                  onClick={() => setPhase("confirming")}
                >
                  {t("tasks.coordination.cancel.action")}
                </UI.Button>
              )
              : undefined}
          />
        )}
        {plan
          ? (
            <UI.PageHeader
              variant="split"
              title={heading}
              subtitle={phone
                ? (
                  <span>
                    {[
                      task.data?.title,
                      t("tasks.coordination.revision", {
                        revision: String(plan.revision),
                      }),
                    ].filter((part) => part !== undefined).join(" · ")}
                  </span>
                )
                : (
                  <>
                    {task.data && <span>{task.data.title}</span>}
                    {provenance && hasProvenance(plan)
                      ? (
                        // One wrapping unit: the leading dot, revision, origin
                        // and digest share the subtitle's text style and move
                        // together, so no line ends in a lone dot.
                        <span>
                          {task.data && <span aria-hidden="true">·&nbsp;</span>}
                          {t("tasks.coordination.revision", {
                            revision: String(plan.revision),
                          })}{" "}
                          <PlanProvenance
                            leadingSeparator
                            plan={plan}
                            workflowName={workflow.data?.name}
                          />
                        </span>
                      )
                      : (
                        <>
                          {task.data && <span aria-hidden="true">·</span>}
                          <span>
                            {t("tasks.coordination.revision", {
                              revision: String(plan.revision),
                            })}
                          </span>
                        </>
                      )}
                  </>
                )}
              summary={phone
                ? (
                  <>
                    <UI.Inline gap="compact">
                      <UI.StatusDot
                        size="small"
                        tone={planTone}
                        data-plan-status={plan.status}
                      >
                        {t(`tasks.coordination.status.${plan.status}`)}
                      </UI.StatusDot>
                      <UI.Text variant="caption">
                        {t("tasks.coordination.progress", {
                          completed: String(counts.completed),
                          total: String(counts.total),
                        })}
                      </UI.Text>
                    </UI.Inline>
                    {plan.budgetLimitUsd !== null && (
                      <UI.Text variant="caption">
                        {t("tasks.coordination.budget", {
                          amount: Number.isFinite(Number(plan.budgetLimitUsd))
                            ? new Intl.NumberFormat(locale, {
                              style: "currency",
                              currency: "USD",
                            }).format(Number(plan.budgetLimitUsd))
                            : plan.budgetLimitUsd,
                        })}
                      </UI.Text>
                    )}
                  </>
                )
                : (
                  <>
                    <UI.StatusDot
                      size="strong"
                      tone={planTone}
                      data-plan-status={plan.status}
                    >
                      {t(`tasks.coordination.status.${plan.status}`)}
                    </UI.StatusDot>
                    <UI.Text variant="hint">
                      {[
                        t("tasks.coordination.progress", {
                          completed: String(counts.completed),
                          total: String(counts.total),
                        }),
                        plan.budgetLimitUsd !== null
                          ? t("tasks.coordination.budget", {
                            amount: Number.isFinite(Number(plan.budgetLimitUsd))
                              ? new Intl.NumberFormat(locale, {
                                style: "currency",
                                currency: "USD",
                              }).format(Number(plan.budgetLimitUsd))
                              : plan.budgetLimitUsd,
                          })
                          : null,
                      ].filter((part) => part !== null).join(" · ")}
                    </UI.Text>
                    <PlanTicketClaim plan={plan} />
                  </>
                )}
            />
          )
          : emptyHeader}
        {connectivity === "offline" && (
          <UI.InlineNotice tone="warning">
            {t("tasks.coordination.offline")}
          </UI.InlineNotice>
        )}
        {connectivity === "reconnecting" && (
          <UI.InlineNotice tone="warning">
            {t("tasks.coordination.reconnecting")}
          </UI.InlineNotice>
        )}
        {live === "lost" && online && (
          <UI.InlineNotice tone="warning" data-ui-region="live-lost">
            {t("tasks.conversation.live.lost")}
          </UI.InlineNotice>
        )}
        {stale && (
          <UI.InlineNotice tone="warning">
            <UI.Stack gap="compact">
              <UI.Text>{t("tasks.coordination.stale")}</UI.Text>
              <UI.Button variant="outline" onClick={() => void plans.refetch()}>
                {t("tasks.coordination.refresh")}
              </UI.Button>
            </UI.Stack>
          </UI.InlineNotice>
        )}
        {body}
        {plan && typeof plan.digest === "string" && plan.digest !== ""
          ? (
            <FingerprintRow
              fingerprint={plan.digest}
              helpText={t("tasks.coordination.digestHint")}
            />
          )
          : null}
      </div>
    </>
  );
}
