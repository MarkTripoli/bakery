import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { ArtifactPreviewView } from "./ArtifactRetrievalView.tsx";
import {
  ARTIFACT_CONTENT_OVER_LIMIT_STATUS,
  type ArtifactVersionResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
} from "./artifact-media.ts";

const textModes: Readonly<
  Record<string, "text" | "markdown" | "patch" | "log">
> = {
  "text/plain": "text",
  "text/markdown": "markdown",
  "application/json": "text",
  "text/csv": "text",
  "text/x-diff": "patch",
  "text/x-patch": "patch",
  "text/log": "log",
};
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function ArtifactContentPreview({ version, onDownload, onViewDetails }: {
  readonly version: ArtifactVersionResponse;
  readonly onDownload: () => void;
  readonly onViewDetails: () => void;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const mediaType = version.mediaType.split(";", 1)[0].trim().toLowerCase();
  const textMode = textModes[mediaType];
  const image = imageTypes.has(mediaType);
  const supported = image || textMode !== undefined;
  const previewLimit = image ? MAX_IMAGE_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES;
  // The advertised size gates the fetch; the client still cancels a stream
  // that lies about it and crosses the same bound.
  const advertisedTooLarge = version.sizeBytes > previewLimit;
  const content = useQuery({
    queryKey: protectedQueryKey(scope, "artifactVersions.verifiedPreview", {
      versionId: version.id,
      sha256: version.sha256,
    }),
    enabled: scope.organizationId !== null && supported && !advertisedTooLarge,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (scope.organizationId === null) {
        throw new Error("ORGANIZATION_REQUIRED");
      }
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId: version.id,
        expectedSha256: version.sha256.toLowerCase(),
        maxBytes: previewLimit,
        signal,
      });
      if (!result.ok) throw result.error;
      const data = result.data;
      if (
        data.status !== 200 || data.content === null ||
        data.contentDigest !== version.sha256.toLowerCase() ||
        data.contentLength !== version.sizeBytes ||
        data.content.byteLength !== version.sizeBytes
      ) {
        throw new Error("ARTIFACT_PREVIEW_DIGEST_MISMATCH");
      }
      return data.content;
    },
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image || !content.data || content.isError) return;
    const blob = new Blob([new Uint8Array(content.data)], { type: mediaType });
    const url = URL.createObjectURL(blob);
    setImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setImageUrl(null);
    };
  }, [content.data, content.isError, image, mediaType]);
  const expired = content.error !== null && typeof content.error === "object" &&
    "kind" in content.error && content.error.kind === "problem" &&
    "problem" in content.error && typeof content.error.problem === "object" &&
    content.error.problem !== null && "status" in content.error.problem &&
    content.error.problem.status === 410;
  const overLimit = advertisedTooLarge || (
    content.error !== null && typeof content.error === "object" &&
    "kind" in content.error && content.error.kind === "invalid-response" &&
    "status" in content.error &&
    content.error.status === ARTIFACT_CONTENT_OVER_LIMIT_STATUS
  );
  if (supported && overLimit) {
    return (
      <ArtifactPreviewView
        state="unavailable"
        label={t("artifact.preview.title")}
        unavailable={{
          title: t("artifact.preview.tooLargeTitle"),
          description: t("artifact.preview.tooLargeDescription", {
            kind: image ? "image" : "text",
          }),
          action: {
            label: t("artifact.retrieval.download"),
            onClick: onDownload,
          },
        }}
      />
    );
  }
  if (expired) {
    return (
      <ArtifactPreviewView
        label={t("artifact.preview.title")}
        state="unavailable"
        unavailable={{
          title: t("artifact.expired.title"),
          description: t("artifact.expired.description"),
          expired: true,
          action: {
            label: t("artifact.retrieval.versionsTitle"),
            onClick: onViewDetails,
          },
        }}
      />
    );
  }
  if (!supported) {
    return (
      <ArtifactPreviewView
        state="unavailable"
        label={t("artifact.preview.title")}
        unavailable={{
          title: t("artifact.view.previewUnavailable"),
          description: t("artifact.preview.unsupported"),
          action: {
            label: t("artifact.retrieval.download"),
            onClick: onDownload,
          },
        }}
      />
    );
  }
  if (content.isError) {
    return (
      <UI.Stack gap="compact">
        <UI.InlineNotice tone="error">
          {t("artifact.preview.error")}
        </UI.InlineNotice>
        <UI.Button variant="secondary" onClick={() => void content.refetch()}>
          {t("core.actions.retry")}
        </UI.Button>
      </UI.Stack>
    );
  }
  if (!content.data || (image && imageUrl === null)) {
    return <UI.Skeleton shape="surface" />;
  }
  return (
    <ArtifactPreviewView
      state="content"
      label={t("artifact.preview.title")}
      content={image && imageUrl !== null
        ? {
          kind: "image",
          src: imageUrl,
          alt: t("artifact.preview.image"),
          unavailableLabel: t("artifact.preview.error"),
        }
        : {
          kind: textMode ?? "text",
          text: new TextDecoder().decode(content.data),
        }}
    />
  );
}
