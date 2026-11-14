import { useEffect, useState } from "react";
import type { Translator } from "@bakery/i18n";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { WorkerResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  workersListQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { usePagedFocus } from "../app/focus.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { FinishingSetup } from "./FinishingSetup.tsx";
import { MachineList } from "./MachineList.tsx";
import { type MachineFilter, machineMatchesFilter } from "./machine-state.ts";

// Above this many machines the list offers a filter; below it, it is just a list.
const FILTER_MIN_MACHINES = 10;

type MachineRow = WorkerResponse;

export function formatMachineDate(
  value: string | null | undefined,
  locale: string,
  timeZone: string,
  fallback: string,
): string {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

export function boundedReason(reason: string | null | undefined): string {
  const text = reason?.trim() || "";
  if (text.length <= 240) return text;
  return `${text.slice(0, 237)}…`;
}

function StateError({
  busy = false,
  kind,
  onRetry,
  translate,
}: {
  /** A retry is in flight: the button stays where it is, busy, so focus never leaves it. */
  readonly busy?: boolean;
  readonly kind: "offline" | "error";
  readonly onRetry: () => void;
  readonly translate: Translator;
}) {
  return (
    <UI.ErrorState
      state={busy ? "retrying" : "default"}
      title={translate(`machines.${kind}.title` as never)}
      description={translate(`machines.${kind}.description` as never)}
      action={
        <UI.Button
          aria-busy={busy || undefined}
          variant="secondary"
          onClick={busy ? undefined : onRetry}
          // The paged-focus rule's retry target: a retried first read that
          // fails again puts focus back on this button.
          data-paged-retry="machines"
        >
          {translate("machines.retry" as never)}
        </UI.Button>
      }
    />
  );
}

export function MachinesPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const [workerCursor, setWorkerCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<MachineFilter>("all");
  const workers = useQuery(
    workersListQueryOptions(api, scope, { limit: 100 }),
  );
  const workerContinuationOptions = workersListQueryOptions(api, scope, {
    cursor: workerCursor ?? undefined,
    limit: 100,
  });
  const workerContinuation = useQuery({
    ...workerContinuationOptions,
    queryKey: [...workerContinuationOptions.queryKey, "continuation"] as const,
    enabled: Boolean(scope.organizationId && workerCursor),
  });
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const connectivity = useConnectivity({
    refetch: workers.refetch,
    refetching: workers.isFetching || workerContinuation.isFetching,
    dataUpdatedAt: workers.dataUpdatedAt,
  });
  useEffect(() => {
    setWorkerCursor(null);
  }, [scope.organizationId]);
  const organizationId = scope.organizationId;
  const rows = [
    ...(workers.data?.items ?? []),
    ...(workerContinuation.data?.items ?? []),
  ];
  const visible = rows.filter((row) => machineMatchesFilter(row, filter));
  // As above: the continuation's null cursor ends the list.
  const nextWorkerCursor = workerContinuation.data
    ? workerContinuation.data.nextCursor
    : workers.data?.nextCursor;
  const workerPaging = usePagedFocus("machines", {
    pending: workerContinuation.isFetching || workers.isFetching,
    failed: workerContinuation.isError || workers.isError,
    rowCount: rows.length,
    hasMore: Boolean(nextWorkerCursor),
  });
  // A retried first read: the failure stays on screen, with its Retry button
  // busy, until the answer arrives. Without it the button would be replaced by
  // the loading state and focus would fall to the page body for the wait.
  const [retryingFirst, setRetryingFirst] = useState<
    "offline" | "error" | null
  >(null);
  const forbidden = workers.isError && isForbiddenFailure(workers.error);
  // The add action is for an administrator who can read the list at all.
  const canAdd = isAdmin && !forbidden;
  // The empty card carries its own Add machine; everywhere else the page's
  // action is in the top bar (wide) or under the title (phone), on a failed
  // read too, and nowhere when the read is refused.
  const emptyCardShown = !forbidden && !workers.isError &&
    retryingFirst === null && rows.length === 0 && !workers.isPending;
  const connectivityKind = asyncKindForConnectivity(connectivity);
  const phone = useShellViewport() === "phone";
  const openMachine = (row: MachineRow) =>
    void navigate({
      to: "/machines/$machineId",
      params: { machineId: row.id },
    });
  // The page's one primary action: in the top bar on a wide screen, under the
  // title on a phone (the page header hides its actions on a wide one).
  const addMachine = (
    <UI.Button
      variant="primary"
      onClick={() =>
        void navigate({ to: "/machines/new", search: { finish: undefined } })}
    >
      {translate("machines.add" as never)}
    </UI.Button>
  );
  return (
    <>
      <ShellActiveNavigation id="machines" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            { label: translate("shell.navigation.workspace") },
            { label: translate("shell.navigation.machines") },
          ]}
        />
      </ShellSlot>
      {canAdd && !phone
        ? <ShellSlot name="actions">{addMachine}</ShellSlot>
        : null}
      <UI.SettingsContent data-testid="machines-page" variant="wide">
        {/* The wrapper is what the first-read retry looks for; the focus goes to its heading. */}
        <div data-paged-heading="machines">
          <UI.PageHeader
            flush
            variant="list"
            title={translate("machines.title")}
            subtitle={translate("machines.description")}
            actions={canAdd && phone && !emptyCardShown ? addMachine : null}
          />
        </div>
        {connectivityKind
          ? (
            <UI.AlertBanner
              tone={connectivityKind === "offline" ? "warning" : "information"}
            >
              {translate(`machines.${connectivityKind}.description` as never)}
            </UI.AlertBanner>
          )
          : null}
        {organizationId && canAdd
          ? (
            <FinishingSetup
              organizationId={organizationId}
              scope={scope}
              api={api}
              translate={translate}
            />
          )
          : null}
        {forbidden
          ? (
            <UI.EmptyState
              title={translate("machines.forbidden.title")}
              description={translate("machines.forbidden.description")}
              variant="firstUse"
            />
          )
          : workers.isError || retryingFirst !== null
          ? (
            <StateError
              busy={retryingFirst !== null}
              kind={retryingFirst ?? (asyncKindForError(workers.error) ===
                  "offline"
                ? "offline"
                : "error")}
              onRetry={() => {
                // A failed first read, retried: focus lands on the page heading
                // when it works, back on Retry when it fails again.
                workerPaging.ask("first");
                setRetryingFirst(
                  asyncKindForError(workers.error) === "offline"
                    ? "offline"
                    : "error",
                );
                void workers.refetch().finally(() => setRetryingFirst(null));
              }}
              translate={translate}
            />
          )
          : rows.length === 0 && !workers.isPending
          ? (
            <UI.EmptyState
              title={translate("machines.empty.title")}
              description={translate(
                (isAdmin
                  ? "machines.empty.description"
                  : "machines.empty.adminOnly") as never,
              )}
              action={isAdmin ? addMachine : undefined}
              variant="firstUse"
            />
          )
          : (
            <UI.Stack gap="standard">
              {nextWorkerCursor
                ? (
                  <UI.AlertBanner tone="information">
                    {translate(
                      "machines.pagination.truncated.machines" as never,
                      {
                        count: rows.length,
                      },
                    )}
                  </UI.AlertBanner>
                )
                : null}
              {rows.length > FILTER_MIN_MACHINES
                ? (
                  <UI.SegmentedControl
                    aria-label={translate("machines.filter.label" as never)}
                    name="machine-filter"
                    variant="inline"
                    value={filter}
                    onChange={(value) => setFilter(value as MachineFilter)}
                    options={(["all", "needsAttention", "offline"] as const)
                      .map((value) => ({
                        value,
                        label: translate(`machines.filter.${value}` as never),
                      }))}
                  />
                )
                : null}
              <div data-paged-list="machines">
                <MachineList
                  rows={visible}
                  loading={workers.isPending}
                  stale={connectivity !== "online"}
                  phone={phone}
                  onOpen={openMachine}
                  translate={translate}
                />
              </div>
              {workerContinuation.isError
                ? (
                  <UI.AlertBanner tone="error">
                    {translate("machines.pagination.error.machines" as never)}
                  </UI.AlertBanner>
                )
                : null}
              {nextWorkerCursor
                ? (
                  <UI.Button
                    variant="secondary"
                    data-paged-more="machines"
                    data-paged-retry={workerContinuation.isError
                      ? "machines"
                      : undefined}
                    disabled={workerContinuation.isFetching}
                    onClick={() => {
                      workerPaging.ask("more", workers.data?.items.length);
                      if (workerContinuation.isError) {
                        void workerContinuation.refetch();
                      } else setWorkerCursor(nextWorkerCursor);
                    }}
                  >
                    {workerContinuation.isFetching
                      ? translate("machines.pagination.loadingMore" as never)
                      : workerContinuation.isError
                      ? translate("machines.retry" as never)
                      : translate("machines.pagination.loadMore" as never)}
                  </UI.Button>
                )
                : null}
            </UI.Stack>
          )}
      </UI.SettingsContent>
    </>
  );
}
