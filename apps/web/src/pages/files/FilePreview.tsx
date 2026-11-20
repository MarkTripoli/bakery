import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatNumber } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type {
  StorageFileVersion,
  StorageFolderItem,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { protectedQueryKey } from "../../app/query-scope.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
} from "../artifact-media.ts";
import { ArtifactPreviewView } from "../ArtifactRetrievalView.tsx";
import { sizeParts } from "./files-state.ts";

const textModes: Readonly<Record<string, "text" | "markdown" | "patch">> = {
  "text/plain": "text",
  "text/markdown": "markdown",
  "application/json": "text",
  "text/csv": "text",
  "text/xml": "text",
  "application/xml": "text",
  "text/x-diff": "patch",
  "text/x-patch": "patch",
};
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The file's contents as far as the page can show them: text and images, bounded. */
export function FilePreview(
  { file, version }: {
    readonly file: StorageFolderItem;
    /** An older version being shown; null for the current one. */
    readonly version: StorageFileVersion | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale } = useI18n();
  const sizeBytes = version?.sizeBytes ?? file.sizeBytes;
  const contentRemoved = version?.contentRemoved ?? file.contentRemoved;
  const mediaType = (version?.mediaType ?? file.mediaType ?? "")
    .split(";", 1)[0]!.trim().toLowerCase();
  const textMode = textModes[mediaType];
  const image = imageTypes.has(mediaType);
  // A video or audio file is played from its address, never read into the page.
  const media = mediaType.startsWith("video/")
    ? "video"
    : mediaType.startsWith("audio/")
    ? "audio"
    : null;
  const supported = image || textMode !== undefined;
  const limit = image ? MAX_IMAGE_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES;
  const tooLarge = (sizeBytes ?? 0) > limit;
  const content = useQuery({
    queryKey: protectedQueryKey(scope, "storageFiles.preview", {
      fileId: file.id,
      updatedAt: file.updatedAt,
      revision: version?.revision ?? null,
    }),
    enabled: scope.organizationId !== null && supported && !tooLarge &&
      !contentRemoved,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (scope.organizationId === null) {
        throw new Error("ORGANIZATION_REQUIRED");
      }
      const result = await api.files.content(
        scope.organizationId,
        file.id,
        version?.revision,
        signal,
      );
      if (!result.ok) throw result.error;
      const data = result.data;
      if (data.status !== 200 || data.content === null) {
        throw new Error("PREVIEW_UNAVAILABLE");
      }
      if (data.content.byteLength > limit) throw new Error("PREVIEW_TOO_LARGE");
      return data.content;
    },
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image || !content.data) return;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(content.data)], { type: mediaType }),
    );
    setImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setImageUrl(null);
    };
  }, [content.data, image, mediaType]);

  if (contentRemoved) return null;
  if (media !== null && scope.organizationId !== null) {
    return (
      <ArtifactPreviewView
        state="content"
        label={translate("files.preview.title")}
        content={{
          kind: media,
          src: api.files.mediaUrl(
            scope.organizationId,
            file.id,
            version?.revision,
          ),
          label: translate("files.preview.player", { name: file.name }),
          unavailableLabel: translate("files.preview.error"),
        }}
      />
    );
  }
  if (!supported) {
    return (
      <UI.Text variant="muted">
        {translate("files.preview.unsupported")}
      </UI.Text>
    );
  }
  if (tooLarge || content.error?.message === "PREVIEW_TOO_LARGE") {
    const { value, unit } = sizeParts(sizeBytes ?? 0);
    return (
      <UI.Text variant="muted">
        {translate("files.preview.tooLarge", {
          size: translate(`files.size.${unit}` as never, {
            value: formatNumber(value, locale, { maximumFractionDigits: 1 }),
          }),
        })}
      </UI.Text>
    );
  }
  if (content.isError) {
    return (
      <UI.Stack gap="compact">
        <UI.InlineNotice tone="error">
          {translate("files.preview.error")}
        </UI.InlineNotice>
        <UI.Button variant="secondary" onClick={() => void content.refetch()}>
          {translate("files.retry")}
        </UI.Button>
      </UI.Stack>
    );
  }
  if (content.data === undefined || (image && imageUrl === null)) {
    return <UI.Skeleton shape="surface" />;
  }
  return (
    <ArtifactPreviewView
      state="content"
      label={translate("files.preview.title")}
      content={image && imageUrl !== null
        ? {
          kind: "image",
          src: imageUrl,
          alt: translate("files.preview.image", { name: file.name }),
          unavailableLabel: translate("files.preview.error"),
        }
        : {
          kind: textMode ?? "text",
          text: new TextDecoder().decode(content.data),
        }}
    />
  );
}
