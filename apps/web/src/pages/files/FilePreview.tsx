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

/** How many lines of a text file the details panel shows; opened, all of it. */
export const PANEL_LINES = 20;

/** What the page can show of a file, from its media type. */
export function previewKind(
  mediaType: string | null | undefined,
): "text" | "image" | "media" | "other" {
  const type = (mediaType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (textModes[type] !== undefined) return "text";
  if (imageTypes.has(type)) return "image";
  if (type.startsWith("video/") || type.startsWith("audio/")) return "media";
  return "other";
}

/** The file's contents as far as the page can show them: text, images and players, bounded. */
export function FilePreview(
  { file, version, full = false, onOpenable }: {
    readonly file: StorageFolderItem;
    /**
     * Told whether the file has anything to open: false for a file with no
     * preview, one too large or unreadable, and a video that cannot be played.
     */
    readonly onOpenable?: (openable: boolean) => void;
    /** Opened full size in the page, rather than in the details panel. */
    readonly full?: boolean;
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
  // A player the browser could not play: it says so, and offers the download.
  const [playFailed, setPlayFailed] = useState(false);
  useEffect(() => setPlayFailed(false), [file.id, version?.revision]);
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

  const openable = !contentRemoved &&
    (media !== null ? !playFailed : supported && !tooLarge && !content.isError);
  useEffect(() => onOpenable?.(openable), [onOpenable, openable]);

  if (contentRemoved) return null;
  if (media !== null && playFailed) {
    // Nothing is wrong with Bakery and the details' own Download sits just
    // below, so this is a quiet line, not an alert.
    return (
      <UI.Text variant="muted">{translate("files.preview.unplayable")}</UI.Text>
    );
  }
  if (media !== null && scope.organizationId !== null) {
    return (
      <ArtifactPreviewView
        size={full ? "full" : "panel"}
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
          onError: () => setPlayFailed(true),
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
      size={full ? "full" : "panel"}
      state="content"
      label={translate("files.preview.title")}
      content={image && imageUrl !== null
        ? {
          kind: "image",
          src: imageUrl,
          alt: translate("files.preview.image", { name: file.name }),
          unavailableLabel: translate("files.preview.error"),
        }
        : (() => {
          // The panel shows the first lines, cut with a fade; opened, all of it.
          const all = new TextDecoder().decode(content.data);
          const lines = all.split("\n");
          const cut = !full && lines.length > PANEL_LINES;
          return {
            kind: textMode ?? "text",
            text: cut ? lines.slice(0, PANEL_LINES).join("\n") : all,
            cut,
          };
        })()}
    />
  );
}
