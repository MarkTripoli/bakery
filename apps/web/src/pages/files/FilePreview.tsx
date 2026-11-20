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
  { file, version, expectedSha256 }: {
    readonly file: StorageFolderItem;
    /** An older version being shown; null for the current one. */
    readonly version: StorageFileVersion | null;
    /**
     * The digest this file's record claims for the bytes on screen (#437).
     *
     * Without it a storage file could never be in the mismatch state, and the dead
     * branch would be a promise the page does not keep.
     */
    readonly expectedSha256: string | null;
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
  const state: PreviewState = answer !== null
    ? previewState(answer, { mismatch })
    : mismatch
    ? { kind: "mismatch" }
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
  useEffect(() => {
    if (content.data === undefined || expectedSha256 === null) {
      setMismatch(false);
      return;
    }
    let live = true;
    void sha256Hex(content.data).then(
      (digest) => {
        if (live) setMismatch(digest !== expectedSha256);
      },
      () => {
        // An unhashable body is not evidence of a mismatch; the read path's own
        // checks still apply.
        if (live) setMismatch(false);
      },
    );
    return () => {
      live = false;
    };
  }, [content.data, expectedSha256]);
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
            <UI.Button variant="secondary" onClick={() => void probe.refetch()}>
              {translate("files.preview.state.retry")}
            </UI.Button>
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

/**
 * The digest of the bytes a person is looking at, for the mismatch state.
 *
 * The read path already refuses bytes that do not match their record when it can
 * verify them; this is the panel's own second opinion, because a mismatched file is
 * the one thing the design says Bakery must never show or offer to download.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
