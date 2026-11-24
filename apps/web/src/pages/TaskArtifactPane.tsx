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
  runStepsListQueryOptions,
} from "../api/query.ts";
import type { ApiFailure } from "../api/client.ts";
import type { DurableSyncConnectivity } from "../api/durable-sync.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { formatFileSize } from "./file-size.ts";
import {
  isDiffMediaType,
  isExtractableMediaType,
  MAX_TEXT_PREVIEW_BYTES,
} from "./artifact-media.ts";
import { ArtifactPreviewBody } from "./ArtifactContentPreview.tsx";
import { FingerprintRow } from "./FingerprintRow.tsx";
import { stepTitle } from "./task-timeline.ts";

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
  const { translate: t, locale } = useI18n();
  const translateForSize = (
    key: string,
    values?: Record<string, string | number>,
  ) =>
    (t as (id: string, v?: Record<string, string | number>) => string)(
      key,
      values,
    );
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
  // The first page of steps, the same read (and cache entry) the run section
  // makes, names the step that made the selected version.
  const stepNames = useQuery({
    ...runStepsListQueryOptions(api, scope, runId, {
      cursor: undefined,
      limit: 25,
    }),
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
  // A patch or diff is text too: its verified bytes are read the way the
  // revision card reads them (the server's extract does not serve diffs).
  const isDiff = selected !== undefined &&
    isDiffMediaType(selected.mediaType) &&
    selected.sizeBytes <= MAX_TEXT_PREVIEW_BYTES;
  const extractable = selected !== undefined &&
    (isExtractableMediaType(selected.mediaType) || isDiff);
  const extract = useQuery({
    ...artifactExtractionQueryOptions(api, scope, selected?.id ?? "", {
      startByte: 0,
      maxBytes: PREVIEW_BYTES,
    }),
    enabled: scope.organizationId !== null && extractable && !isDiff,
  });
  const diff = useQuery({
    queryKey: protectedQueryKey(scope, "taskArtifact.diff", {
      versionId: selected?.id ?? "",
      digest: selected?.sha256 ?? "",
    }),
    enabled: scope.organizationId !== null && isDiff,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!scope.organizationId || selected === undefined) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId: selected.id,
        expectedSha256: selected.sha256.toLowerCase(),
        signal,
      });
      if (!result.ok) throw result.error;
      if (
        result.data.status !== 200 ||
        result.data.content.byteLength !== selected.sizeBytes
      ) throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        result.data.content,
      );
      return {
        versionId: selected.id,
        sha256: selected.sha256,
        text: text.slice(0, PREVIEW_BYTES),
        hasMore: text.length > PREVIEW_BYTES,
      };
    },
  });
  const read = isDiff ? diff : extract;
  const extraction = read.data !== undefined && selected !== undefined &&
      read.data.versionId === selected.id &&
      read.data.sha256.toLowerCase() === selected.sha256.toLowerCase()
    ? read.data
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
    read.error;
  const state: UI.ArtifactPaneState = failure
    ? (isForbidden(failure) ? "forbidden" : "error")
    : artifacts.isPending ||
        ((candidates.length > 0 || !pageSettled || nextCursor !== null) &&
          resolving) ||
        (extractable && read.isPending)
    ? "loading"
    : artifact === undefined || selected === undefined
    ? "empty"
    // Extraction is how a *text* file is read; an image, a video or a refusal is
    // decided by `previewState` inside the body, which owns that table. Marking
    // anything else "unavailable" here hid every picture and every refusal the
    // pane could have shown (#437).
    : !extractable
    ? "ready"
    : extraction === undefined
    ? "error"
    : extraction.hasMore
    ? "partial"
    : connectivity === "offline"
    ? "offline"
    : connectivity === "reconnecting"
    ? "reconnecting"
    : "ready";

  // A run that has published nothing draws no pane: the section appears with its
  // first artifact (the run section design, "Removed").
  if (state === "empty") return null;
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
    details: t("tasks.artifactPane.details"),
  };
  // Who made the selected version: the name of the step that published it,
  // the raw step id only when that step is not among the ones read.
  const madeByStep = selected?.runStepId
    ? stepNames.data?.items.find((item) => item.id === selected.runStepId)
    : undefined;
  const madeBy = selected === undefined
    ? undefined
    : madeByStep
    ? stepTitle(t, madeByStep.stepKey)
    : selected.runStepId ?? t("tasks.artifact.unknown");
  const openHref = artifact
    ? `/tasks/${taskId}/artifacts/${artifact.id}`
    : undefined;
  // What the selected version is, said the same way the artifact page says it.
  // The pane has its own Download and Open in the footer, so the preview offers
  // no second copy of them.
  // Rendered, not called: a function call would put the preview's hooks on this
  // component and change its hook count whenever the selection appears (#437).
  const preview = selected === undefined ? undefined : (
    <ArtifactPreviewBody
      version={selected}
      label={t("tasks.artifactPane.preview")}
      // The pane caps the text and fades the cut, so its Download and Open stay above
      // the fold (#437).
      cutText
    />
  );
  return (
    <UI.ArtifactPane
      details={artifact && selected
        ? (
          <UI.Stack gap="compact">
            <FingerprintRow
              copyFailedText={t("tasks.artifact.idCopyFailed")}
              display={artifact.id.slice(0, 8)}
              fingerprint={artifact.id}
              label={t("tasks.artifact.id")}
              noHelp
              testId="artifact-id-row"
            />
            <FingerprintRow
              fingerprint={selected.sha256}
              testId="artifact-fingerprint-row"
            />
            <UI.DetailRow label={t("tasks.artifact.size")}>
              {t("artifact.retrieval.sizeValue", {
                size: formatFileSize(
                  selected.sizeBytes,
                  locale,
                  translateForSize,
                ),
              })}
            </UI.DetailRow>
            <UI.DetailRow label={t("tasks.artifact.madeBy")}>
              {madeBy}
            </UI.DetailRow>
          </UI.Stack>
        )
        : undefined}
      descriptor={artifact && selected
        ? {
          artifactId: artifact.id,
          version: String(selected.revision),
          digest: selected.sha256,
          size: formatFileSize(selected.sizeBytes, locale, translateForSize),
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
      preview={preview}
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
