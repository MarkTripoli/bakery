import { useDisplayedOutputDownload } from "./use-displayed-output-download.ts";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { JobAttemptRead, OutputStream } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { runAttemptsQueryOptions } from "../api/query.ts";
import { useOutputStream } from "../api/use-output-stream.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { runOutcomeState } from "./run-outcome.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

import { TaskRunArchive } from "./TaskRunArchive.tsx";
import { TaskRunStreamView } from "./task-run-stream-view.tsx";

export function StreamOutput({ stream, onUsageChange, onReload }: {
  readonly stream: OutputStream;
  readonly onReload: () => void;
  readonly onUsageChange: (usage: JobAttemptRead["outcome"]["usage"]) => void;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const [attemptCursor, setAttemptCursor] = useState<string | undefined>();
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const attempts = useQuery({
    ...runAttemptsQueryOptions(
      api,
      scope,
      stream.taskId ?? "",
      stream.jobId,
      attemptCursor,
    ),
    enabled: stream.taskId !== null,
  });
  const records = attempts.isError
    ? []
    : attempts.data?.items.filter((record) =>
      record.runStepId === stream.runStepId
    ) ?? [];
  const attempt = records.find((record) => record.id === attemptId) ??
    records.find((record) => record.isCurrent) ?? records[0];
  const outcome = runOutcomeState(attempt);
  const usage = attempt?.outcome.usage ?? null;
  useEffect(() => {
    onUsageChange(usage);
    return () => onUsageChange(null);
  }, [onUsageChange, usage]);
  const { translate: t } = useI18n();
  const { replay, connection, reconnect } = useOutputStream(stream.streamId);
  const downloadUrl = useDisplayedOutputDownload(
    replay.batches,
    connection === "forbidden",
  );
  const latest = replay.batches.at(-1);
  const capture =
    latest?.capture === "truncated" || latest?.capture === "interrupted"
      ? latest.capture
      : stream.capture;
  const state = connection === "expired"
    ? "reset"
    : connection === "forbidden" || connection === "error"
    ? "error"
    : connection === "connecting"
    ? "loading"
    : connection === "reconnecting"
    ? "reconnecting"
    : capture === "capturing"
    ? "live"
    : capture;
  const channels = new Set(
    replay.batches.flatMap((batch) => batch.parts.map((part) => part.channel)),
  );
  // Attribution: a retry continues the same stream, so each batch names the
  // producer generation that committed it and the stream's producers map that
  // generation to its attempt. Markers appear only when more than one attempt
  // wrote this stream; a one-attempt stream renders exactly as before.
  const attemptByGeneration = new Map(
    (stream.producers ?? []).map((producer) => [
      producer.writerGeneration,
      producer,
    ]),
  );
  const attemptKey = (generation: string) =>
    attemptByGeneration.get(generation)?.attemptId ?? `unlisted:${generation}`;
  const attributed = new Set(
    replay.batches.map((batch) => attemptKey(batch.writerGeneration)),
  );
  const showAttempts = attributed.size > 1;
  let previousAttempt: string | null = null;
  const entries = replay.batches.flatMap((batch) => {
    const lines = batch.parts.map((part) => ({
      id: `${batch.sessionId}:${batch.sequence}:${part.itemId}`,
      timestamp: "",
      source: channels.size > 1 ? part.channel : undefined,
      message: part.text,
    }));
    if (!showAttempts || lines.length === 0) return lines;
    const key = attemptKey(batch.writerGeneration);
    if (key === previousAttempt) return lines;
    previousAttempt = key;
    const producer = attemptByGeneration.get(batch.writerGeneration);
    return [
      {
        id: `${batch.sessionId}:${batch.sequence}:attempt`,
        timestamp: "",
        source: producer
          ? t("tasks.run.identity.attempt", {
            number: String(producer.attemptNo),
          })
          : t("tasks.run.output.attemptUnknown"),
        message: t("tasks.run.output.attemptStart"),
      },
      ...lines,
    ];
  });
  // A retry that began after the stream list loaded has batches this list
  // cannot attribute yet: reload the list once per newer generation.
  const unlistedMax = replay.batches.reduce<bigint | null>((max, batch) => {
    if (attemptByGeneration.has(batch.writerGeneration)) return max;
    const generation = BigInt(batch.writerGeneration);
    return max === null || generation > max ? generation : max;
  }, null);
  const reloadedFor = useRef<bigint | null>(null);
  const reloadList = useRef(onReload);
  reloadList.current = onReload;
  useEffect(() => {
    if (unlistedMax === null) return;
    if (reloadedFor.current !== null && unlistedMax <= reloadedFor.current) {
      return;
    }
    reloadedFor.current = unlistedMax;
    reloadList.current();
  }, [unlistedMax]);
  const reload = () => {
    void attempts.refetch();
    onReload();
  };
  const captureNotice = state === "reconnecting"
    ? {
      title: t("tasks.run.output.notice.reconnecting"),
      description: t("tasks.run.output.notice.reconnectingDescription"),
      action: (
        <UI.Button variant="outline" onClick={reconnect}>
          {t("tasks.run.action.reconnect")}
        </UI.Button>
      ),
    }
    : state === "reset" || state === "truncated" || state === "interrupted"
    ? {
      title: t(`tasks.run.output.notice.${state}`),
      description: t(
        state === "reset"
          ? "tasks.run.output.expired"
          : state === "truncated"
          ? "tasks.run.output.truncated"
          : "tasks.run.output.interrupted",
      ),
      action: state === "interrupted"
        ? (
          <UI.Button variant="outline" onClick={reload}>
            {t("tasks.run.action.reload")}
          </UI.Button>
        )
        : undefined,
    }
    : undefined;
  return (
    <TaskRunStreamView
      selection={
        <>
          {records.length > 1 && (
            <UI.Combobox
              label={t("tasks.run.identity.select")}
              value={attempt?.id ?? ""}
              options={[
                { value: "", label: t("tasks.run.identity.current") },
                ...records.map((record) => ({
                  value: record.id,
                  label: t("tasks.run.identity.attempt", {
                    number: String(record.attemptNo),
                  }),
                })),
              ]}
              onChange={(event) => {
                const id = event.target.value || null;
                setAttemptId(id);
                if (id === null) setAttemptCursor(undefined);
              }}
            />
          )}
        </>
      }
      identity={{
        title: t("tasks.run.identity.title"),
        worker: attempt?.workerName ?? null,
        attempt: attempt
          ? t("tasks.run.identity.attempt", {
            number: String(attempt.attemptNo),
          })
          : null,
        lease: attempt
          ? t(`tasks.run.identity.lease.${attempt.leaseState}`)
          : stream.reason === "lease-lost"
          ? t("tasks.run.identity.lostLease")
          : null,
        notice: outcome === "running" || outcome === "unknown"
          ? captureNotice
          : {
            title: outcome === "exit" && attempt?.outcome.exitCode !== null &&
                attempt?.outcome.exitCode !== undefined
              ? t("tasks.run.outcome.exit.titleCode", {
                code: String(attempt.outcome.exitCode),
              })
              : attempt?.isCurrent || outcome === "lost-lease"
              ? t(`tasks.run.outcome.${outcome}.title`)
              : t("tasks.run.outcome.historical", {
                state: t(`tasks.run.outcome.${outcome}.title`),
              }),
            action: outcome === "exit" || outcome === "completed"
              ? (
                <UI.Button
                  variant="outline"
                  onClick={() => focusEvidence("task-run-artifacts")}
                >
                  {t("tasks.run.action.artifacts")}
                </UI.Button>
              )
              : outcome === "timeout"
              ? (
                <UI.Button
                  variant="outline"
                  onClick={() => focusEvidence("runTimeline")}
                >
                  {t("tasks.run.action.details")}
                </UI.Button>
              )
              : outcome === "lost-lease"
              ? (
                <UI.Button variant="outline" onClick={reload}>
                  {t("tasks.run.action.reload")}
                </UI.Button>
              )
              : undefined,
            description: t(`tasks.run.outcome.${outcome}.description`),
          },
        unknownLabel: t("tasks.run.unknown"),
        detail: attempt && !attempt.isCurrent
          ? t("tasks.run.identity.recorded", {
            actor: stream.logicalActor,
            machine: attempt.workerName,
          })
          : attempt
          ? t("tasks.run.identity.actor", {
            actor: stream.logicalActor,
            machine: attempt.workerName,
          })
          : t("tasks.run.identity.unavailable"),
      }}
      output={{
        title: t("tasks.run.output.title"),
        entries,
        state,
        statusLabel: state === "complete" || state === "interrupted" ||
            state === "truncated" || state === "reset" ||
            state === "reconnecting"
          ? t("tasks.run.output.durable")
          : t(`tasks.run.output.state.${state}`),
        captureLabel: state === "live" || state === "loading"
          ? t("tasks.run.output.saved", { sequence: replay.sequence })
          : t("tasks.run.output.savedState", {
            state: t(`tasks.run.output.state.${state}`),
            sequence: replay.sequence,
          }),
        archiveActions: connection !== "forbidden" && connection !== "error"
          ? <TaskRunArchive stream={stream} />
          : undefined,
        latestLabel: t("tasks.run.output.latest"),
        downloadLink: downloadUrl
          ? {
            href: downloadUrl,
            label: t("tasks.run.output.downloadLabel"),
            accessibleLabel: t("tasks.run.output.download"),
            filename: `output-${stream.streamId}.txt`,
          }
          : undefined,
        notice: captureNotice &&
            (outcome === "running" || outcome === "unknown")
          ? undefined
          : replay.reset
          ? t("tasks.run.output.expired")
          : replay.windowed
          ? t("tasks.run.output.windowed")
          : state === "truncated"
          ? t("tasks.run.output.truncated")
          : undefined,
      }}
      pagination={
        <>
          {attemptCursor && (
            <UI.Button onClick={() => setAttemptCursor(undefined)}>
              {t("tasks.run.revision.first")}
            </UI.Button>
          )}
          {attempts.data?.nextCursor && !attempts.isError && (
            <UI.Button
              onClick={() =>
                setAttemptCursor(attempts.data?.nextCursor ?? undefined)}
            >
              {t("projects.onboarding.pagination.next")}
            </UI.Button>
          )}
        </>
      }
    />
  );
}

function focusEvidence(component: "task-run-artifacts" | "runTimeline") {
  const target = document.querySelector<HTMLElement>(
    component === "task-run-artifacts"
      ? "#task-run-artifacts"
      : `[data-ui-component="${component}"]`,
  );
  if (!target) return;
  target.tabIndex = -1;
  target.focus();
  target.scrollIntoView({ block: "start" });
}
