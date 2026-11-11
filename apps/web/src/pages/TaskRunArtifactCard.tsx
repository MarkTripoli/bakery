import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { ArtifactResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { artifactVersionsQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export function TaskRunArtifactCard(
  { artifact, taskId }: { artifact: ArtifactResponse; taskId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t, locale } = useI18n();
  const [downloadState, setDownloadState] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const pending = useRef<AbortController | null>(null);
  const versions = useQuery({
    ...artifactVersionsQueryOptions(api, scope, artifact.id, { limit: 100 }),
    queryKey: protectedQueryKey(scope, "runArtifactCurrentVersion.list", {
      artifactId: artifact.id,
      taskId,
      currentVersionId: artifact.currentVersionId,
      limit: 100,
    }),
    enabled: scope.organizationId !== null && artifact.taskId === taskId,
  });
  const version = versions.isError
    ? undefined
    : versions.data?.items.find((item) =>
      item.id === artifact.currentVersionId && item.artifactId === artifact.id
    );
  useEffect(() => {
    setDownloadState("idle");
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [artifact.id, version?.id, scope.sessionGeneration, scope.organizationId]);
  if (artifact.taskId !== taskId) return null;
  const download = async () => {
    if (
      !version || !scope.organizationId || pending.current ||
      version.sizeBytes > MAX_DOWNLOAD_BYTES
    ) return;
    const controller = new AbortController();
    pending.current = controller;
    setDownloadState("loading");
    try {
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId: version.id,
        expectedSha256: version.sha256,
        signal: controller.signal,
      });
      if (
        !result.ok || result.data.status !== 200 ||
        result.data.contentLength !== version.sizeBytes ||
        result.data.content.byteLength !== version.sizeBytes ||
        result.data.contentDigest !== version.sha256.toLowerCase()
      ) throw new Error("ARTIFACT_DOWNLOAD_INVALID");
      if (controller.signal.aborted) return;
      const href = URL.createObjectURL(
        new Blob([result.data.content.buffer as ArrayBuffer], {
          type: result.data.contentType,
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download =
        artifact.name.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-")
          .slice(0, 80) || "artifact";
      anchor.click();
      URL.revokeObjectURL(href);
      setDownloadState("idle");
    } catch {
      if (!controller.signal.aborted) setDownloadState("error");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  return (
    <UI.Stack>
      <UI.RunArtifactSummary
        title={t("tasks.run.artifact.title")}
        name={artifact.name}
        state={version ? "ready" : "unknown"}
        revision={version
          ? t("tasks.run.artifact.revision", { revision: version.revision })
          : t("tasks.run.unknown")}
        size={version
          ? t("tasks.run.artifact.size", {
            size: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
              .format(version.sizeBytes / 1024),
          })
          : t("tasks.run.unknown")}
        detail={version
          ? t("tasks.run.artifact.detail", {
            digest: `${version.sha256.slice(0, 8)}…${version.sha256.slice(-8)}`,
          })
          : t("tasks.run.unknown")}
        actions={
          <>
            <UI.Link
              variant="button"
              href={`/tasks/${taskId}/artifacts/${artifact.id}`}
            >
              {t("tasks.run.artifact.open")}
            </UI.Link>
            <UI.Button
              variant="outline"
              disabled={!version || downloadState === "loading" ||
                version.sizeBytes > MAX_DOWNLOAD_BYTES}
              onClick={() => void download()}
            >
              {t(
                downloadState === "loading"
                  ? "tasks.run.artifact.downloading"
                  : "tasks.run.artifact.download",
              )}
            </UI.Button>
          </>
        }
      />
      {downloadState === "error" && (
        <UI.InlineNotice tone="error">
          {t("tasks.run.artifact.downloadError")}
        </UI.InlineNotice>
      )}
      {version && version.sizeBytes > MAX_DOWNLOAD_BYTES && (
        <UI.Text>{t("tasks.run.artifact.tooLarge")}</UI.Text>
      )}
    </UI.Stack>
  );
}
