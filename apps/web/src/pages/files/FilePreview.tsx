import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { previewFacts } from "../preview-facts.ts";
import { probeFromAnswer } from "../probe-answer.ts";
import {
  declaredPreviewState,
  type PreviewState,
  previewState,
} from "../preview-state.ts";
import { formatFileSize } from "../file-size.ts";
import { mediaFailureIsMismatch } from "./media-failure.ts";

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
  {
    file,
    version,
    full = false,
    onOpenable,
    onMismatch,
    downloadRefused = false,
  }: {
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
    /**
     * Told when the bytes on screen are not the bytes the record describes, so the
     * panel can stop offering to save them (#437).
     */
    readonly onMismatch?: ((mismatch: boolean) => void) | undefined;
    /**
     * The panel's own Download was refused because the bytes and the record
     * disagree. The player never asked, so nothing here has seen the refusal yet;
     * it is the same fact, and the preview must say it the same way (#437).
     */
    readonly downloadRefused?: boolean;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale } = useI18n();
  // `formatFileSize` wants the translator's own shape, which is what the size row
  // of this panel already passes.
  const translateForSize = (
    key: string,
    values?: Record<string, string | number>,
  ) =>
    (translate as (id: string, v?: Record<string, string | number>) => string)(
      key,
      values,
    );
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
  // What the probe measured, if anything has asked yet. A file stored inline has
  // no blob to probe, so it answers nothing for ever; that is "no answer", and
  // the declared name is what this panel falls back to, exactly as before the
  // probe existed.
  const probe = useQuery({
    queryKey: protectedQueryKey(scope, "storageFiles.probe", {
      fileId: file.id,
      revision: version?.revision ?? null,
    }),
    enabled: scope.organizationId !== null && !contentRemoved,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (scope.organizationId === null) {
        throw new Error("ORGANIZATION_REQUIRED");
      }
      const result = await api.files.probe(
        scope.organizationId,
        file.id,
        version?.revision,
        signal,
      );
      if (!result.ok) throw result.error;
      return result.data;
    },
  });
  const answer = probeFromAnswer(probe.data ?? null);
  // A version whose bytes do not hash to its recorded digest is not shown at all:
  // the stored record and the bytes disagree, and this panel is the only place that
  // holds both. Decided on the bytes actually received, never on the probe's word.
  const facts = answer === null
    ? ""
    : previewFacts(answer, locale, (key, values) =>
      (translate as (
        id: string,
        v?: Record<string, string | number>,
      ) => string)(
        key,
        values,
      ));
  const footer = facts ? <UI.Text variant="muted">{facts}</UI.Text> : undefined;
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
  // A player reads its address, never these bytes, so a file that does not match
  // its record reaches the player as a failure to play. Once it has failed, one
  // content read says which fault it is: a refusal is the answer, and the panel
  // says so rather than blaming the browser beside a Download of the same bytes.
  // The read asks for a single byte. A whole read would pull a two-gigabyte video
  // into the tab to answer a question about its digest, and the server checks the
  // digest before it answers either way. A blob-backed version above the range
  // ceiling answers 416 instead of a mismatch; the panel then keeps naming the
  // player, because nothing here proved the file wrong.
  const mediaCheck = useQuery({
    queryKey: protectedQueryKey(scope, "storageFiles.mediaCheck", {
      fileId: file.id,
      revision: version?.revision ?? null,
    }),
    enabled: media !== null && playFailed && scope.organizationId !== null &&
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
        "bytes=0-0",
      );
      if (!result.ok) throw result.error;
      return null;
    },
  });
  // The read answers `ARTIFACT_CONTENT_MISMATCH` when the stored bytes are not the
  // bytes the version recorded; that refusal is the answer.
  const refusedAsMismatch = mediaFailureIsMismatch(
    media !== null ? mediaCheck.error : content.error,
  );
  // A refusal the panel already met is not undone by a preview that has not met
  // one yet: the two are the same fact, and the panel's own Download found it.
  const mismatchKnown = refusedAsMismatch || downloadRefused;
  useEffect(() => {
    onMismatch?.(mismatchKnown);
  }, [mismatchKnown, onMismatch]);
  // A refused read outranks the answer: the bytes are not the bytes the record
  // describes, so what they would have looked like is not a fact about this file.
  // Read straight from the refusal rather than through state an effect sets: a
  // frame that drew the old state would show "The preview did not load." before
  // the banner replaced it (#437 review).
  const state: PreviewState = mismatchKnown
    ? { kind: "mismatch" }
    : answer !== null
    ? previewState(answer)
    : probe.isPending
    ? { kind: "pending" }
    : declaredPreviewState(mediaType);
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

  const refused = state.kind === "mismatch" || state.kind === "unreadable" ||
    state.kind === "unchecked" || state.kind === "host-unavailable" ||
    state.kind === "too-large";
  const openable = !contentRemoved && !refused &&
    (media !== null ? !playFailed : supported && !tooLarge && !content.isError);
  useEffect(() => onOpenable?.(openable), [onOpenable, openable]);

  if (contentRemoved) return null;
  // A refusal about the file, or a host that could not check it, is said the
  // same way the artifact page says it. Unsupported and too-large keep the copy
  // this panel already had, because a storage file's size is known without a
  // probe and the declared name is all a blob-less file can offer.
  if (
    state.kind === "unreadable" || state.kind === "unchecked" ||
    state.kind === "host-unavailable"
  ) {
    return (
      <UI.Stack gap="compact">
        <UI.Text variant="muted">
          {translate(
            state.kind === "unreadable"
              ? "files.preview.state.unreadableUnknown"
              : state.kind === "unchecked"
              ? "files.preview.state.unchecked"
              : "files.preview.state.hostUnavailable",
          )}
        </UI.Text>
        {state.kind === "host-unavailable"
          ? (
            // Inline, not full width: a retry is an offer, not the panel's subject.
            <UI.Inline>
              <UI.Button
                variant="secondary"
                onClick={() => void probe.refetch()}
              >
                {translate("files.preview.state.retry")}
              </UI.Button>
            </UI.Inline>
          )
          : null}
      </UI.Stack>
    );
  }
  if (state.kind === "mismatch") {
    return (
      <UI.Stack gap="compact">
        <UI.AlertBanner tone="error">
          {translate("files.preview.state.mismatchTitle")}
        </UI.AlertBanner>
        <UI.Text variant="muted">
          {translate("files.preview.state.mismatchDescription")}
        </UI.Text>
      </UI.Stack>
    );
  }
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
        footer={footer}
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
  // Three ways to be over a limit: the file is bigger than this panel displays,
  // the read refused it, or the probe refused it at the sandbox's own limit. All
  // three say the same sentence, with the file's size and the limit as the two
  // different numbers they are -- and the probe's limit is the probe's, not this
  // panel's, when that is what refused it.
  if (
    tooLarge || state.kind === "too-large" ||
    content.error?.message === "PREVIEW_TOO_LARGE"
  ) {
    return (
      <UI.Text variant="muted">
        {translate("files.preview.state.tooLarge", {
          size: formatFileSize(sizeBytes ?? 0, locale, translateForSize),
          limit: formatFileSize(
            state.kind === "too-large" ? state.limit : limit,
            locale,
            translateForSize,
          ),
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
      footer={footer}
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
