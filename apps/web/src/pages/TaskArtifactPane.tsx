import { useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  artifactExtractionQueryOptions,
  artifactsListQueryOptions,
  artifactVersionsQueryOptions,
  runOutputStepIdsQueryOptions,
  runQueryOptions,
} from "../api/query.ts";
import type { ApiFailure } from "../api/client.ts";
import type { DurableSyncConnectivity } from "../api/durable-sync.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { isExtractableMediaType } from "./artifact-media.ts";

/** Preview window: bounded text, far below the 64 KiB extraction cap. */
const PREVIEW_BYTES = 8_192;

function isForbidden(error: unknown): boolean {
  return typeof error === "object" && error !== null && "kind" in error &&
    error.kind === "problem" && "problem" in error &&
    (error.problem as { status?: number }).status === 403;
}

/**
 * This run's artifact beside its session: the first task artifact with a
 * version published by one of the run's steps, preferring patches, together
 * with its immutable versions and a bounded plain-text extract of the
 * selected one. Patches win when the run owns both a patch and another type
 * (the task brief is a markdown document the brief step publishes before any
 * patch exists). Diffs (`text/x-diff`) are not extractable media, so their
 * pane shows metadata, download and open with the unavailable-preview copy.
 * Bytes never become HTML, and nothing here fabricates a version or text the
 * server did not return.
 */
export function TaskArtifactPane(
  { taskId, runId, connectivity = "online" }: {
    taskId: string;
    runId: string;
    connectivity?: DurableSyncConnectivity;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [picked, setPicked] = useState<
    { artifactId: string; versionId: string } | null
  >(null);
  const scoped = scope.organizationId !== null;
  // Same read and key as the run section: a run that is not this task's must
  // suppress every child read here too, not only in the timeline.
  const run = useQuery({
    ...runQueryOptions(api, scope, runId),
    enabled: scoped,
  });
  const runMismatch = run.data !== undefined && run.data.taskId !== taskId;
  const enabled = scoped && run.data !== undefined && !runMismatch;
  const steps = useQuery({
    ...runOutputStepIdsQueryOptions(api, scope, runId),
    enabled,
  });
  // The server can only filter by type over the whole task, so page the task's
  // artifact list (no type filter) until one owns a version from this run;
  // versions are fetched in order so a task with many artifacts never fans out
  // concurrent requests.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const pages = useQueries({
    queries: cursors.map((cursor) => ({
      ...artifactsListQueryOptions(api, scope, {
        taskId,
        limit: 25,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      enabled,
    })),
  });
  const artifacts = pages[0]!;
  // Run-owned artifacts in list order, patches first. Transcript logs never
  // become the card (the server publishes them per session with a run-step
  // owner); otherwise the type does not gate it, only run-step ownership below.
  const candidates = pages.flatMap((page) =>
    page.data?.items.filter((item) =>
      item.taskId === taskId && item.artifactType !== "log"
    ) ?? []
  ).sort((a, b) =>
    (a.artifactType === "patch" ? 0 : 1) - (b.artifactType === "patch" ? 0 : 1)
  );
  const stepIds = steps.data ?? [];
  // Candidates unlock one at a time, in list order.
  const [unlocked, setUnlocked] = useState(1);
  const versionQueries = useQueries({
    queries: candidates.map((item, index) => ({
      ...artifactVersionsQueryOptions(api, scope, item.id, { limit: 100 }),
      enabled: enabled && steps.data !== undefined && index < unlocked,
    })),
  });
  // Same rule as the revision card: a version published by one of this run's
  // steps. No fallback to another run: an unowned artifact of any type never
  // becomes the card.
  const ownsRun = (index: number) =>
    versionQueries[index]?.data?.items.some((version) =>
      version.runStepId !== null && stepIds.includes(version.runStepId)
    ) ?? false;
  const lastPage = pages.at(-1);
  const nextCursor = lastPage?.data?.nextCursor ?? null;
  const unlockedSettled = versionQueries.slice(0, unlocked).every((q) =>
    !q.isPending
  );
  // A run-owned patch wins wherever it sits in the list; another run-owned
  // type is the card only once every page has been searched for a patch.
  const patchMatch = candidates.findIndex((item, index) =>
    item.artifactType === "patch" && ownsRun(index)
  );
  const pageSettled = !(lastPage?.isPending ?? true);
  const searched = pageSettled && unlockedSettled &&
    unlocked >= candidates.length &&
    (nextCursor === null || cursors.length >= 20);
  const matchIndex = patchMatch >= 0
    ? patchMatch
    : searched
    ? candidates.findIndex((_, index) => ownsRun(index))
    : -1;
  useEffect(() => {
    if (matchIndex >= 0 || steps.data === undefined) return;
    if (unlockedSettled && unlocked < candidates.length) {
      setUnlocked(unlocked + 1);
    }
  }, [matchIndex, steps.data, unlockedSettled, unlocked, candidates.length]);
  const allSettled = unlockedSettled && unlocked >= candidates.length &&
    pageSettled;
  useEffect(() => {
    if (matchIndex < 0 && allSettled && nextCursor !== null) {
      setCursors((current) =>
        current.at(-1) === nextCursor || current.length >= 20
          ? current
          : [...current, nextCursor]
      );
    }
  }, [matchIndex, allSettled, nextCursor]);
  const artifact = matchIndex >= 0 ? candidates[matchIndex] : undefined;
  const versions = matchIndex >= 0
    ? versionQueries[matchIndex]!
    : { data: undefined, error: null, isPending: false };
  const resolving = steps.data === undefined ||
    (matchIndex < 0 && (versionQueries.some((q) => q.isPending) ||
      !pageSettled || unlocked < candidates.length ||
      (nextCursor !== null && cursors.length < 20)));
  const list = [...(versions.data?.items ?? [])].sort((a, b) =>
    b.revision - a.revision
  );
  const selected =
    list.find((item) =>
      picked !== null && picked.artifactId === artifact?.id &&
      item.id === picked.versionId
    ) ?? list.find((item) => item.id === artifact?.currentVersionId) ??
      list[0];
  const extractable = selected !== undefined &&
    isExtractableMediaType(selected.mediaType);
  const extract = useQuery({
    ...artifactExtractionQueryOptions(api, scope, selected?.id ?? "", {
      startByte: 0,
      maxBytes: PREVIEW_BYTES,
    }),
    enabled: scope.organizationId !== null && extractable,
  });
  const extraction = extract.data !== undefined && selected !== undefined &&
      extract.data.versionId === selected.id &&
      extract.data.sha256.toLowerCase() === selected.sha256.toLowerCase()
    ? extract.data
    : undefined;

  // A failing candidate that is not this run's artifact must not hide a readable
  // match; with no match yet, any candidate failure still surfaces.
  const candidateError = matchIndex >= 0
    ? versionQueries[matchIndex]?.error
    : versionQueries.find((q) => q.error)?.error;
  const failure = run.error ??
    (runMismatch
      ? { kind: "invalid-response", status: 0 } satisfies ApiFailure
      : null) ??
    steps.error ?? artifacts.error ??
    pages.find((page) => page.error)?.error ??
    candidateError ??
    extract.error;
  const state: UI.ArtifactPaneState = failure
    ? (isForbidden(failure) ? "forbidden" : "error")
    : artifacts.isPending ||
        ((candidates.length > 0 || !pageSettled || nextCursor !== null) &&
          resolving) ||
        (extractable && extract.isPending)
    ? "loading"
    : artifact === undefined || selected === undefined
    ? "empty"
    : !extractable
    ? "unavailable"
    : extraction === undefined
    ? "error"
    : extraction.hasMore
    ? "partial"
    : connectivity === "offline"
    ? "offline"
    : connectivity === "reconnecting"
    ? "reconnecting"
    : "ready";

  const labels: UI.ArtifactPaneLabels = {
    paneTitle: t("tasks.artifactPane.label"),
    versionSelect: t("tasks.artifactPane.versionSelect"),
    preview: t("tasks.artifactPane.preview"),
    truncated: t("tasks.artifactPane.truncated"),
    unavailable: t("tasks.artifactPane.unavailable"),
    loading: t("tasks.artifactPane.loading"),
    empty: t("tasks.artifactPane.empty"),
    error: t("tasks.artifactPane.error"),
    forbidden: t("tasks.artifactPane.forbidden"),
    offline: t("tasks.artifactPane.offline"),
    reconnecting: t("tasks.artifactPane.reconnecting"),
    download: t("tasks.artifactPane.download"),
    open: t("tasks.artifactPane.open"),
  };
  const openHref = artifact
    ? `/tasks/${taskId}/artifacts/${artifact.id}`
    : undefined;
  return (
    <UI.ArtifactPane
      descriptor={artifact && selected
        ? {
          artifactId: artifact.id,
          version: String(selected.revision),
          digest: selected.sha256,
          size: t("artifact.retrieval.sizeValue", { size: selected.sizeBytes }),
          mediaType: selected.mediaType,
          provenance: selected.runStepId ?? t("tasks.artifact.unknown"),
          labels: {
            artifactId: t("tasks.artifact.id"),
            version: t("tasks.artifact.version"),
            digest: t("tasks.artifact.digest"),
            size: t("tasks.artifact.size"),
            mediaType: t("tasks.artifact.mediaType"),
            provenance: t("tasks.artifact.provenance"),
            link: t("tasks.artifact.open"),
          },
        }
        : undefined}
      label={t("tasks.artifactPane.label")}
      labels={labels}
      meta={selected
        ? t("tasks.artifactPane.meta", {
          version: selected.revision,
          mediaType: selected.mediaType,
        })
        : undefined}
      onVersionChange={(versionId) =>
        artifact && setPicked({ artifactId: artifact.id, versionId })}
      openHref={openHref}
      previewText={extraction?.text}
      state={state}
      title={artifact?.name}
      version={selected?.id ?? ""}
      versions={list.map((item) => ({
        value: item.id,
        label: t("tasks.artifactPane.version", { version: item.revision }),
      }))}
    />
  );
}
