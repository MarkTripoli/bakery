import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { WorkerAttemptResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { workerAttemptsQueryOptions } from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { formatMachineDate } from "./machine-state.ts";
import {
  agentKey,
  leaseKey,
  placeOf,
  slotsOf,
  statusKey,
  stepHref,
  WORK_STATES,
  type WorkState,
  workState,
} from "./machine-work.ts";

type Tone = "neutral" | "success" | "warning" | "danger";

const TONE: Readonly<Record<WorkerAttemptResponse["status"], Tone>> = {
  leased: "neutral",
  running: "success",
  canceling: "warning",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
  lost: "warning",
  quarantined: "danger",
};

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
  const open = (href: string) => void navigate({ to: href });

  const place = (attempt: WorkerAttemptResponse) => {
    const where = placeOf(attempt);
    const step = stepHref(attempt);
    return (
      <UI.Stack gap="none">
        {where.kind === "task"
          ? (
            <UI.Link
              href={`/tasks/${where.taskId}`}
              onClick={(event) => {
                event.preventDefault();
                open(`/tasks/${where.taskId}`);
              }}
            >
              {where.title === ""
                ? message("machines.work.untitled")
                : where.title}
            </UI.Link>
          )
          : (
            <UI.Text>
              {message("machines.work.noTask")}{" "}
              <UI.DataText>{where.action}</UI.DataText>
            </UI.Text>
          )}
        {attempt.stepKey === null
          ? null
          : step === null
          ? (
            <UI.Text variant="caption">
              {message("machines.work.step", { step: attempt.stepKey })}
            </UI.Text>
          )
          : (
            <UI.Link
              href={step}
              onClick={(event) => {
                event.preventDefault();
                open(step);
              }}
            >
              {message("machines.work.step", { step: attempt.stepKey })}
            </UI.Link>
          )}
      </UI.Stack>
    );
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
  const badge = (attempt: WorkerAttemptResponse) => (
    <UI.Badge tone={TONE[attempt.status]}>
      {message(statusKey(attempt.status))}
    </UI.Badge>
  );

  const forbidden = attempts.isError && isForbiddenFailure(attempts.error);
  const missing = attempts.isError && failureStatus(attempts.error) === 404;
  const offline = attempts.isError &&
    asyncKindForError(attempts.error) === "offline";
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
  if (forbidden || missing) {
    body = (
      <UI.EmptyState
        title={message(
          forbidden
            ? "machines.work.forbidden.title"
            : "machines.work.missing.title",
        )}
        description={message(
          forbidden
            ? "machines.work.forbidden.description"
            : "machines.work.missing.description",
        )}
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
            <UI.StackedRow title={place(attempt)} status={badge(attempt)}>
              <UI.Text variant="caption">{who(attempt)}</UI.Text>
              <UI.Text variant="caption">
                {message(leaseKey(attempt.leaseState))}
                {" · "}
                {attempt.startedAt === null
                  ? message("machines.work.notStarted")
                  : message("machines.work.startedAt", {
                    time: when(attempt.startedAt),
                  })}
              </UI.Text>
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
        inset="edge"
        rows={rows}
        emptyMessage={message(`machines.work.empty.${state}.title`)}
        getRowKey={(attempt) => attempt.id}
        getRowAttributes={(attempt) => ({ "data-attempt": attempt.id })}
        columns={[
          {
            id: "work",
            header: message("machines.work.column.work"),
            cell: place,
          },
          {
            id: "agent",
            header: message("machines.work.column.agent"),
            cell: who,
          },
          {
            id: "status",
            header: message("machines.work.column.status"),
            cell: (attempt) => (
              <UI.Stack gap="none">
                {badge(attempt)}
                <UI.Text variant="caption">
                  {message(leaseKey(attempt.leaseState))}
                </UI.Text>
              </UI.Stack>
            ),
          },
          {
            id: "started",
            header: message("machines.work.column.started"),
            cell: (attempt) =>
              attempt.startedAt === null
                ? message("machines.work.notStarted")
                : when(attempt.startedAt),
          },
        ]}
      />
    );
  }

  return (
    <UI.Stack gap="spacious" data-testid="machine-work">
      <UI.SettingsSection
        title={message("machines.work.slots.title")}
        variant="stack"
        data-testid="machine-slots"
      >
        <UI.DescriptionList>
          <UI.DescriptionItem
            title={message("machines.work.slots.total")}
            description={String(capacity.slots)}
          />
          <UI.DescriptionItem
            title={message("machines.work.slots.occupied")}
            description={String(capacity.occupied)}
          />
          <UI.DescriptionItem
            title={message("machines.work.slots.unoccupied")}
            description={String(capacity.unoccupied)}
          />
        </UI.DescriptionList>
        <UI.Text variant="caption">
          {message("machines.work.slots.what")}
        </UI.Text>
        {connectivity === "online" ? null : (
          <UI.InlineNotice tone="information">
            {lastHeartbeatAt === null
              ? message("machines.work.slots.lastKnownNever")
              : message("machines.work.slots.lastKnown", {
                time: when(lastHeartbeatAt),
              })}
          </UI.InlineNotice>
        )}
      </UI.SettingsSection>
      <UI.SettingsSection
        title={message("machines.work.title")}
        variant="stack"
        data-testid="machine-attempts"
      >
        {filter}
        {rows.length > 0 && attempts.isError
          ? (
            <UI.InlineNotice
              tone="error"
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => void attempts.fetchNextPage()}
                >
                  {message("machines.retry")}
                </UI.Button>
              }
            >
              {message(
                offline
                  ? "machines.work.moreOffline"
                  : "machines.work.moreFailed",
              )}
            </UI.InlineNotice>
          )
          : null}
        {body}
        {attempts.hasNextPage && !forbidden && !missing
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
      </UI.SettingsSection>
    </UI.Stack>
  );
}
