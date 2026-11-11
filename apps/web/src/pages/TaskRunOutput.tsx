import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { JobAttemptRead } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { outputStreamsQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { StreamOutput } from "./TaskRunOutputStream.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function TaskRunOutput(
  { taskId, stepId, stepStatus, stepErrorCode, onUsageChange }: {
    readonly taskId: string;
    readonly stepId: string;
    /** Step status; a failed or canceled step with no stream still shows its outcome. */
    readonly stepStatus?: string;
    /** Recorded step fault code; only the closed set below is ever rendered. */
    readonly stepErrorCode?: string | null;
    readonly onUsageChange: (usage: JobAttemptRead["outcome"]["usage"]) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = useQuery({
    ...outputStreamsQueryOptions(api, scope, taskId, stepId, cursors.at(-1)),
    enabled: scope.organizationId !== null,
  });
  const streams = query.data?.items ?? [];
  const selected = streams.find((stream) => stream.streamId === selectedId) ??
    streams[0];
  if (query.isError) {
    return (
      <UI.InlineNotice tone="warning">
        {t("tasks.run.output.unavailable")}
      </UI.InlineNotice>
    );
  }
  if (
    streams.some((stream) =>
      stream.organizationId !== scope.organizationId ||
      stream.taskId !== taskId || stream.runStepId !== stepId
    )
  ) {
    return (
      <UI.InlineNotice tone="error">
        {t("tasks.run.output.unavailable")}
      </UI.InlineNotice>
    );
  }
  return (
    <UI.Stack>
      {query.isPending
        ? <UI.Text>{t("tasks.run.output.loading")}</UI.Text>
        : streams.length === 0
        ? (
          <>
            {stepStatus === "failed" && stepErrorCode === "quota_exceeded"
              ? (
                <UI.InlineNotice tone="warning">
                  {t("tasks.run.outcome.quota.title")}:{" "}
                  {t("tasks.run.outcome.quota.description")}
                </UI.InlineNotice>
              )
              : (stepStatus === "failed" || stepStatus === "canceled") && (
                <UI.InlineNotice tone="warning">
                  {t(`tasks.run.step.${stepStatus}`)}
                </UI.InlineNotice>
              )}
            <UI.Text>{t("tasks.run.output.empty")}</UI.Text>
          </>
        )
        : selected
        ? (
          <>
            {streams.length > 1 && (
              <UI.Combobox
                label={t("tasks.run.output.stream")}
                value={selected.streamId}
                options={streams.map((stream) => ({
                  value: stream.streamId,
                  label: `${stream.logicalActor} · ${stream.streamId}`,
                }))}
                onChange={(event) => setSelectedId(event.target.value)}
              />
            )}
            <StreamOutput
              key={`${scope.sessionGeneration}:${scope.organizationId}:${selected.streamId}`}
              stream={selected}
              onUsageChange={onUsageChange}
              onReload={() => void query.refetch()}
            />
          </>
        )
        : null}
      {cursors.length > 1 && (
        <UI.Button onClick={() => setCursors(cursors.slice(0, -1))}>
          {t("projects.onboarding.pagination.previous")}
        </UI.Button>
      )}
      {query.data?.nextCursor && (
        <UI.Button
          onClick={() =>
            setCursors([...cursors, query.data?.nextCursor ?? undefined])}
        >
          {t("projects.onboarding.pagination.next")}
        </UI.Button>
      )}
    </UI.Stack>
  );
}
