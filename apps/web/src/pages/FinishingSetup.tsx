import { useEffect, useState } from "react";
import type { Translator } from "@bakery/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  BakeryApiClient,
  WorkerEnrollmentListResponse,
} from "../api/client.ts";
import type { ProtectedScope } from "../app/query-scope.ts";
import { workerEnrollmentsListQueryOptions } from "../api/query.ts";
import { installState } from "./machine-wizard.ts";

type EnrollmentRow = WorkerEnrollmentListResponse["items"][number];

/**
 * Machines whose setup was started and not finished (#70): "Finishing setup",
 * at the top of the list. A setup that is waiting for its machine can be
 * given new settings or canceled; so can one whose settings expired (the
 * server cancels any setup that has not connected). Connected and canceled setups are not listed: a
 * connected machine is a row in the list below.
 */
export function FinishingSetup(
  { organizationId, scope, api, translate }: {
    organizationId: string;
    scope: ProtectedScope;
    api: BakeryApiClient;
    translate: Translator;
  },
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const firstOptions = workerEnrollmentsListQueryOptions(api, scope, {
    limit: 100,
  });
  const first = useQuery(firstOptions);
  const continuationOptions = workerEnrollmentsListQueryOptions(api, scope, {
    cursor: cursor ?? undefined,
    limit: 100,
  });
  const continuation = useQuery({
    ...continuationOptions,
    queryKey: [...continuationOptions.queryKey, "continuation"] as const,
    enabled: Boolean(cursor),
  });
  const nextCursor = continuation.data?.nextCursor ?? first.data?.nextCursor;
  useEffect(() => {
    setCursor(null);
  }, [scope.organizationId]);
  // Every page is read: a setup on a second page is still unfinished.
  useEffect(() => {
    if (nextCursor && nextCursor !== cursor && !continuation.isFetching) {
      setCursor(nextCursor);
    }
  }, [nextCursor, cursor, continuation.isFetching]);

  const now = Date.now();
  const rows = [
    ...(first.data?.items ?? []),
    ...(continuation.data?.items ?? []),
  ].flatMap((row) => {
    const state = installState(row, now);
    return state === "waiting" || state === "expired" ? [{ row, state }] : [];
  });
  if (rows.length === 0 && !failed) return null;

  const cancel = async (row: EnrollmentRow) => {
    setFailed(false);
    const result = await api.workerEnrollments.cancel({
      organizationId,
      id: row.enrollmentId,
      version: row.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setFailed(true);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: firstOptions.queryKey });
  };

  return (
    <>
      <UI.Stack gap="standard" data-testid="machines-finishing-setup">
        <UI.Heading level="section" rank={2} inset="row">
          {translate("machines.finishing.title" as never)}
        </UI.Heading>
        {failed
          ? (
            <UI.AlertBanner tone="error">
              {translate("machines.finishing.error" as never)}
            </UI.AlertBanner>
          )
          : null}
        <UI.Stack
          gap="none"
          role="list"
          aria-label={translate("machines.finishing.title" as never)}
        >
          {rows.map(({ row, state }) => (
            <div
              key={row.enrollmentId}
              role="listitem"
              data-enrollment-id={row.enrollmentId}
            >
              <UI.StackedRow
                title={row.name}
                status={
                  <UI.Badge tone={state === "expired" ? "warning" : "neutral"}>
                    {translate(
                      (state === "expired"
                        ? "machines.finishing.badge.expired"
                        : "machines.finishing.badge.waiting") as never,
                    )}
                  </UI.Badge>
                }
              >
                <UI.Text variant="caption">
                  {translate(
                    (state === "expired"
                      ? "machines.finishing.expired"
                      : "machines.finishing.waiting") as never,
                  )}
                </UI.Text>
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="secondary"
                    aria-label={translate(
                      "machines.finishing.continueNamed" as never,
                      { name: row.name },
                    )}
                    onClick={() =>
                      void navigate({
                        to: "/machines/new",
                        search: { finish: row.enrollmentId },
                      })}
                  >
                    {translate("machines.finishing.continue" as never)}
                  </UI.Button>
                  {
                    <UI.Button
                      variant="destructive-outline"
                      aria-label={translate(
                        "machines.finishing.cancelNamed" as never,
                        { name: row.name },
                      )}
                      onClick={() => void cancel(row)}
                    >
                      {translate("machines.finishing.cancel" as never)}
                    </UI.Button>
                  }
                </UI.Inline>
              </UI.StackedRow>
            </div>
          ))}
        </UI.Stack>
      </UI.Stack>
      {/* The machines below the group get their own heading at the same level. */}
      <UI.Heading level="section" rank={2} inset="row">
        {translate("machines.finishing.machines" as never)}
      </UI.Heading>
    </>
  );
}
