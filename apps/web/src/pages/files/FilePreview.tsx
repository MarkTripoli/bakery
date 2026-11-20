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
import { isArtifactContentMismatch } from "../artifact-mismatch.ts";

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
  { file, version, onMismatch }: {
    readonly file: StorageFolderItem;
    /** An older version being shown; null for the current one. */
    readonly version: StorageFileVersion | null;
    /**
     * Told when the bytes on screen are not the bytes the record describes, so the
     * panel can stop offering to save them (#437).
     */
    readonly onMismatch?: ((mismatch: boolean) => void) | undefined;
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
  const [mismatch, setMismatch] = useState(false);
  // A refused read outranks the answer: the bytes are not the bytes the record
  // describes, so what they would have looked like is not a fact about this file.
  const state: PreviewState = mismatch
    ? { kind: "mismatch" }
    : answer !== null
    ? previewState(answer)
    : probe.isPending
    ? { kind: "pending" }
    : declaredPreviewState(mediaType);
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
  // The read answers `ARTIFACT_CONTENT_MISMATCH` when the stored bytes are not the
  // bytes the version recorded; that refusal is the answer, and the panel says so
  // rather than showing a generic error beside a Download of the same bytes.
  const refusedAsMismatch = isArtifactContentMismatch(content.error);
  useEffect(() => {
    setMismatch(refusedAsMismatch);
    onMismatch?.(refusedAsMismatch);
  }, [refusedAsMismatch, onMismatch]);
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
        : {
          kind: textMode ?? "text",
          text: new TextDecoder().decode(content.data),
          cut: true,
        }}
    />
  );
}
