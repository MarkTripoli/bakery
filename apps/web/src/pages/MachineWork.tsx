import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { WorkerAttemptResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { workerAttemptsQueryOptions } from "../api/query.ts";
import { asyncKindForError, isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { formatMachineDate } from "./machine-state.ts";
import {
  agentKey,
  placeOf,
  ROW_TONE,
  rowState,
  slotsOf,
  stateKey,
  stateLineKey,
  stepHref,
  WORK_STATES,
  type WorkState,
  workState,
} from "./machine-work.ts";

export function MachineWork(
  { machineId, slots, occupied, connectivity, lastHeartbeatAt }: {
    readonly machineId: string;
    readonly slots: number;
    readonly occupied: number;
    readonly connectivity: "online" | "stale" | "offline";
    readonly lastHeartbeatAt: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const [state, setState] = useState<WorkState>("now");
  const attempts = useInfiniteQuery(
    workerAttemptsQueryOptions(api, scope, machineId, state),
  );
  const rows: WorkerAttemptResponse[] =
    attempts.data?.pages.flatMap((page) => page.items) ?? [];
  const capacity = slotsOf(slots, occupied);
  const message = (key: string, values?: Record<string, string | number>) =>
    translate(key as never, values as never);
  const when = (iso: string | null) =>
    formatMachineDate(
      iso,
      locale,
      timeZone,
      message("machines.work.notStarted"),
    );
  const link = (href: string, label: string) => (
    <UI.Link
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void navigate({ to: href });
      }}
    >
      {label}
    </UI.Link>
  );

  const task = (attempt: WorkerAttemptResponse) => {
    const where = placeOf(attempt);
    if (where.kind === "taskless") {
      return <UI.Text>{message(where.nameKey)}</UI.Text>;
    }
    return link(
      `/tasks/${where.taskId}`,
      where.title === "" ? message("machines.work.untitled") : where.title,
    );
  };
  const step = (attempt: WorkerAttemptResponse, label: string) => {
    const href = stepHref(attempt);
    return href === null
      ? <UI.Text variant="caption">{label}</UI.Text>
      : link(href, label);
  };
  const who = (attempt: WorkerAttemptResponse) => {
    const key = agentKey(attempt.codingAgent);
    const parts = [
      ...(key === null ? [] : [message(key)]),
      ...(attempt.model === null ? [] : [attempt.model]),
    ];
    return parts.length === 0
      ? message("machines.work.noAgent")
      : parts.join(" · ");
  };
  const badge = (attempt: WorkerAttemptResponse) => {
    const shown = rowState(attempt);
    return (
      <UI.Badge tone={ROW_TONE[shown]}>{message(stateKey(shown))}</UI.Badge>
    );
  };
  const stateLine = (attempt: WorkerAttemptResponse) => {
    const silentSince = connectivity !== "online" && lastHeartbeatAt !== null;
    const key = stateLineKey(rowState(attempt), {
      hasTask: attempt.taskId !== null,
      silentSince,
    });
    return key === null ? null : (
      <UI.Text variant="caption">
        {message(
          key,
          silentSince ? { time: when(lastHeartbeatAt) } : undefined,
        )}
      </UI.Text>
    );
  };
  const started = (attempt: WorkerAttemptResponse) =>
    attempt.startedAt === null
      ? message("machines.work.notStarted")
      : when(attempt.startedAt);

  const forbidden = attempts.isError && isForbiddenFailure(attempts.error);
  const offline = attempts.isError &&
    asyncKindForError(attempts.error) === "offline";
  const moreFailed = attempts.isFetchNextPageError;
  const refreshFailed = attempts.isError && !moreFailed && rows.length > 0;
  const filter = (
    <UI.SegmentedControl
      aria-label={message("machines.work.filter")}
      name="machine-work-state"
      onChange={(value) => setState(workState(value))}
      options={WORK_STATES.map((value) => ({
        label: message(`machines.work.state.${value}`),
        value,
      }))}
      value={state}
      variant="inline"
    />
  );

  let body;
  if (forbidden) {
    body = (
      <UI.EmptyState
        title={message("machines.work.forbidden.title")}
        description={message("machines.work.forbidden.description")}
        variant="filtered"
      />
    );
  } else if (attempts.isPending) {
    body = (
      <UI.Stack gap="standard" aria-busy="true">
        <UI.Text variant="muted" role="status">
          {message("machines.work.loading")}
        </UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  } else if (rows.length === 0 && attempts.isError) {
    body = (
      <UI.ErrorState
        title={message(
          offline ? "library.offlineTitle" : "machines.work.error.title",
        )}
        description={message(
          offline
            ? "library.offlineDescription"
            : "machines.work.error.description",
        )}
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void attempts.refetch()}
          >
            {message("machines.retry")}
          </UI.Button>
        }
      />
    );
  } else if (rows.length === 0) {
    body = (
      <UI.EmptyState
        title={message(`machines.work.empty.${state}.title`)}
        description={message(`machines.work.empty.${state}.description`)}
        variant="firstUse"
      />
    );
  } else if (phone) {
    body = (
      <UI.Stack
        aria-label={message("machines.work.caption")}
        gap="none"
        role="list"
      >
        {rows.map((attempt) => (
          <div key={attempt.id} role="listitem" data-attempt={attempt.id}>
            <UI.StackedRow
              title={task(attempt)}
              titleLines="wrap"
              status={badge(attempt)}
            >
              {attempt.stepKey === null ? null : step(
                attempt,
                message("machines.work.step", { step: attempt.stepKey }),
              )}
              <UI.Text variant="caption">{who(attempt)}</UI.Text>
              <UI.Text variant="caption">
                {attempt.startedAt === null
                  ? message("machines.work.notStarted")
                  : message("machines.work.startedAt", {
                    time: when(attempt.startedAt),
                  })}
              </UI.Text>
              {stateLine(attempt)}
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  } else {
    body = (
      <UI.DataTable<WorkerAttemptResponse>
        caption={message("machines.work.caption")}
        captionHidden
        variant="ruled"
        rows={rows}
        emptyMessage={message(`machines.work.empty.${state}.title`)}
        getRowKey={(attempt) => attempt.id}
        getRowAttributes={(attempt) => ({ "data-attempt": attempt.id })}
        columns={[
          {
            id: "task",
            header: message("machines.work.column.task"),
            cell: task,
          },
          {
            id: "step",
            header: message("machines.work.column.step"),
            cell: (attempt) =>
              attempt.stepKey === null ? "—" : step(attempt, attempt.stepKey),
          },
          {
            id: "agent",
            header: message("machines.work.column.agent"),
            cell: who,
          },
          {
            id: "started",
            header: message("machines.work.column.started"),
            cell: started,
          },
          {
            id: "status",
            header: message("machines.work.column.state"),
            width: "30%",
            cell: (attempt) => (
              <UI.Stack gap="tight">
                <UI.Inline>{badge(attempt)}</UI.Inline>
                {stateLine(attempt)}
              </UI.Stack>
            ),
          },
        ]}
      />
    );
  }

  return (
    <UI.Stack gap="spacious" data-testid="machine-work">
      <UI.Inline
        gap="spacious"
        data-controls="figures"
        data-testid="machine-slots"
      >
        <UI.StatTile
          label={message("machines.work.slots.total")}
          value={String(capacity.slots)}
        />
        <UI.StatTile
          label={message("machines.work.slots.running")}
          value={String(capacity.running)}
        />
        <UI.StatTile
          label={message("machines.work.slots.free")}
          value={String(capacity.free)}
        />
      </UI.Inline>
      <UI.Stack gap="standard" data-testid="machine-attempts">
        <UI.Inline gap="standard">{filter}</UI.Inline>
        {refreshFailed || moreFailed
          ? (
            <UI.InlineNotice
              tone="error"
              action={
                <UI.Button
                  variant="secondary"
                  loading={attempts.isFetching}
                  onClick={() =>
                    void (moreFailed
                      ? attempts.fetchNextPage()
                      : attempts.refetch())}
                >
                  {message("machines.retry")}
                </UI.Button>
              }
            >
              {message(
                moreFailed
                  ? offline
                    ? "machines.work.moreOffline"
                    : "machines.work.moreFailed"
                  : offline
                  ? "machines.work.refreshOffline"
                  : "machines.work.refreshFailed",
              )}
            </UI.InlineNotice>
          )
          : null}
        {body}
        {attempts.hasNextPage && !forbidden
          ? (
            <UI.Button
              variant="secondary"
              loading={attempts.isFetchingNextPage}
              onClick={() => void attempts.fetchNextPage()}
            >
              {message("machines.pagination.loadMore")}
            </UI.Button>
          )
          : null}
      </UI.Stack>
    </UI.Stack>
  );
}
