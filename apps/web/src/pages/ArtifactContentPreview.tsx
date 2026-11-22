import { type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SupportedLocale } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { ArtifactPreviewView } from "./ArtifactRetrievalView.tsx";
import type { ArtifactVersionResponse } from "../api/client.ts";
import { isArtifactContentMismatch } from "./artifact-mismatch.ts";
import { previewActions } from "./preview-actions.ts";
import { useBakeryApi } from "../api/context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
} from "./artifact-media.ts";
import { previewFacts } from "./preview-facts.ts";
import { formatFileSize } from "./file-size.ts";
import { probeFromAnswer } from "./probe-answer.ts";
import {
  declaredPreviewState,
  type PreviewState,
  previewState,
} from "./preview-state.ts";

/**
 * The artifact preview, decided by what the probe measured (#437 slice 3).
 *
 * Design's rule (issue comment 7029326304) is that the kind comes from the bytes,
 * never from the name, and that each refusal has its own state. `previewState`
 * owns that table; this component fetches, renders and adds no judgement.
 *
 * The bytes still come through a header-authenticated fetch, digest-checked
 * against the version record, and handed to the player as a blob URL. A ranged
 * `<video src>` cannot check the digest, so it is not used here yet: the
 * mismatch state promises Bakery will not show the file, and a stream that
 * skipped the check would be the one path that showed it anyway.
 */
export type PreviewVersion = Pick<
  ArtifactVersionResponse,
  "id" | "mediaType" | "sha256" | "sizeBytes"
>;

/** The artifact page's own preview: the body of the viewer, with its title. */
export function ArtifactContentPreview(
  { version, onDownload, onViewDetails, onMismatch }: {
    readonly version: ArtifactVersionResponse;
    readonly onDownload: () => void;
    readonly onViewDetails: () => void;
    /** Told when the bytes on screen are not the bytes the record describes. */
    readonly onMismatch?: ((mismatch: boolean) => void) | undefined;
  },
) {
  const t = useI18n().translate;
  return (
    <ArtifactPreviewBody
      version={version}
      label={t("artifact.preview.title")}
      onDownload={onDownload}
      onViewDetails={onViewDetails}
      onMismatch={onMismatch}
    />
  );
}

/**
 * The preview, decided by what the probe measured (#437 slice 3).
 *
 * Both surfaces render this: the artifact page puts it in the viewer's body, the
 * task pane puts it in the pane's preview region, and neither decides anything
 * about the file itself. `previewState` owns that table.
 *
 * The bytes come through a header-authenticated fetch, digest-checked against
 * the version record, and handed to the player as a blob URL. A ranged
 * `<video src>` cannot check the digest yet, so it is not used here: the mismatch
 * state promises Bakery will not show the file, and a stream that skipped the
 * check would be the one path that showed it anyway.
 */
export function ArtifactPreviewBody(
  { version, label, onDownload, onViewDetails, cutText, onMismatch }: {
    readonly version: PreviewVersion | null;
    readonly label: string;
    /** Absent when the surrounding surface already offers these. */
    readonly onDownload?: (() => void) | undefined;
    readonly onViewDetails?: (() => void) | undefined;
    /**
     * Show the first lines under a fade, at the panel's cap (#437).
     *
     * True in a side pane, where Download and the details must stay above the fold;
     * false on the artifact page, which is where a person reads the whole file.
     */
    readonly cutText?: boolean;
    /** Told when the bytes on screen are not the bytes the record describes. */
    readonly onMismatch?: ((mismatch: boolean) => void) | undefined;
  },
): ReactNode {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t, locale } = useI18n();
  // A caller with no version still calls the hooks, so the query key is empty
  // rather than the call being skipped.
  const versionId = version?.id ?? "";
  const probe = useQuery({
    queryKey: protectedQueryKey(scope, "artifactVersions.probe", { versionId }),
    enabled: scope.organizationId !== null && version !== null,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (scope.organizationId === null) {
        throw new Error("ORGANIZATION_REQUIRED");
      }
      const result = await api.readArtifactProbe({
        organizationId: scope.organizationId,
        versionId,
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
  });
  // No `return null` before the hooks below: a caller that mounts with a null
  // version and then a real one would otherwise render a different number of
  // hooks on each pass, which React refuses and the task pane did once.
  const answer = probeFromAnswer(probe.data ?? null);
  // No answer is not a refusal: a version whose bytes are stored inline, or one
  // nothing has probed yet, has never been asked about. Falling back to the
  // declared name is what this screen did before the probe existed, and it beats
  // a skeleton that would never resolve.
  const mediaType = (version?.mediaType ?? "").split(";", 1)[0].trim()
    .toLowerCase();
  const state = answer === null
    ? (probe.isPending
      ? { kind: "pending" as const }
      : declaredPreviewState(mediaType))
    : previewState(answer, { mismatch: contentMismatch(probe.error) });
  const facts = answer === null
    ? ""
    : previewFacts(answer, locale, (key, values) =>
      // The facts keys are catalog keys like every other, but the helper takes a
      // plain string so it stays free of React and of this file's key type.
      (t as (id: string, v?: Record<string, string | number>) => string)(
        key,
        values,
      ));
  const textMode = textModes[mediaType] ?? "text";
  const previewLimit = state.kind === "text"
    ? MAX_TEXT_PREVIEW_BYTES
    : MAX_IMAGE_PREVIEW_BYTES;
  const wantsBytes = state.kind === "image" || state.kind === "text" ||
    state.kind === "video" || state.kind === "audio";
  const content = useQuery({
    queryKey: protectedQueryKey(scope, "artifactVersions.verifiedPreview", {
      versionId,
      sha256: version?.sha256 ?? "",
    }),
    enabled: scope.organizationId !== null && wantsBytes,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (scope.organizationId === null) {
        throw new Error("ORGANIZATION_REQUIRED");
      }
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId,
        expectedSha256: (version?.sha256 ?? "").toLowerCase(),
        maxBytes: previewLimit,
        signal,
      });
      if (!result.ok) throw result.error;
      const data = result.data;
      if (
        data.status !== 200 || data.content === null ||
        data.contentDigest !== (version?.sha256 ?? "").toLowerCase() ||
        data.contentLength !== version?.sizeBytes ||
        data.content.byteLength !== version?.sizeBytes
      ) {
        throw new Error("ARTIFACT_PREVIEW_DIGEST_MISMATCH");
      }
      return data.content;
    },
  });
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const urlKind = state.kind === "image" || state.kind === "video" ||
      state.kind === "audio"
    ? state.kind
    : null;
  useEffect(() => {
    if (urlKind === null || !content.data || content.isError) return;
    const blob = new Blob([new Uint8Array(content.data)], { type: mediaType });
    const url = URL.createObjectURL(blob);
    setMediaUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setMediaUrl(null);
    };
  }, [content.data, content.isError, mediaType, urlKind]);
  const mismatched = contentMismatch(content.error);
  useEffect(() => {
    onMismatch?.(mismatched);
  }, [onMismatch, mismatched]);
  if (version === null) return null;
  const expired = isExpired(probe.error) || isExpired(content.error);
  const footer = facts ? <UI.Text variant="muted">{facts}</UI.Text> : undefined;

  // The bytes are not the bytes the record describes. Design's answer is a
  // danger Banner and no preview and no download, because here something really
  // is wrong; the server refuses the content for such a version, so hiding a
  // button is not what keeps the promise.
  const mismatchNotice = (
    <UI.Stack gap="compact">
      <UI.AlertBanner tone="error">
        {t("files.preview.state.mismatchTitle")}
      </UI.AlertBanner>
      <UI.Text variant="muted">
        {t("files.preview.state.mismatchDescription")}
      </UI.Text>
    </UI.Stack>
  );
  if (state.kind === "mismatch" || mismatched) {
    return mismatchNotice;
  }
  if (expired) {
    return (
      <ArtifactPreviewView
        label={label}
        state="unavailable"
        unavailable={{
          title: t("artifact.expired.title"),
          description: t("artifact.expired.description"),
          expired: true,
          action: {
            label: t("artifact.retrieval.versionsTitle"),
            onClick: onViewDetails ?? (() => void probe.refetch()),
          },
        }}
      />
    );
  }
  if (probe.isLoading || state.kind === "pending") {
    return (
      <div aria-busy="true" data-testid="artifact-preview-pending">
        <UI.Skeleton shape="surface" />
      </div>
    );
  }
  const retry: { label: string; onClick: () => void } = {
    label: t("files.preview.state.retry"),
    onClick: () => void probe.refetch(),
  };
  if (
    state.kind !== "image" && state.kind !== "text" && state.kind !== "video" &&
    state.kind !== "audio"
  ) {
    const copy = stateCopy(
      state,
      (key, values) =>
        (t as (id: string, v?: Record<string, string | number>) => string)(
          key,
          values,
        ),
      { sizeBytes: version.sizeBytes, locale },
    );
    const offered = previewActions(state, {
      retry,
      download: onDownload === undefined
        ? undefined
        : { label: t("artifact.retrieval.download"), onClick: onDownload },
    });
    return (
      <ArtifactPreviewView
        label={label}
        state="unavailable"
        footer={footer}
        unavailable={{
          title: copy.title,
          description: copy.description,
          ...(offered.action === undefined ? {} : { action: offered.action }),
          ...(offered.secondaryAction === undefined
            ? {}
            : { secondaryAction: offered.secondaryAction }),
        }}
      />
    );
  }
  if (content.isError) {
    return (
      <UI.Stack gap="compact">
        <UI.InlineNotice tone="error">
          {t("files.preview.error")}
        </UI.InlineNotice>
        <UI.Inline>
          <UI.Button variant="outline" onClick={() => void content.refetch()}>
            {t("core.actions.retry")}
          </UI.Button>
          {onDownload === undefined
            ? null
            : (
              <UI.Button variant="secondary" onClick={onDownload}>
                {t("artifact.retrieval.download")}
              </UI.Button>
            )}
        </UI.Inline>
      </UI.Stack>
    );
  }
  if (!content.data || (urlKind !== null && mediaUrl === null)) {
    return (
      <div aria-busy="true" data-testid="artifact-preview-pending">
        <UI.Skeleton shape="surface" />
      </div>
    );
  }
  if (state.kind === "video" || state.kind === "audio") {
    return (
      <ArtifactPreviewView
        label={label}
        state="content"
        footer={footer}
        content={{
          kind: state.kind,
          src: mediaUrl ?? "",
          label,
          unavailableLabel: t("artifact.preview.error"),
        }}
      />
    );
  }
  return (
    <ArtifactPreviewView
      label={label}
      state="content"
      footer={footer}
      content={state.kind === "image"
        ? {
          kind: "image",
          src: mediaUrl ?? "",
          alt: t("artifact.preview.image"),
          unavailableLabel: t("artifact.preview.error"),
        }
        : {
          kind: textMode,
          text: new TextDecoder().decode(content.data),
          cut: cutText === true,
        }}
    />
  );
}

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

/** The words for a state with no preview, from design's table. */
function stateCopy(
  state: PreviewState,
  t: (key: string, values?: Record<string, string | number>) => string,
  context: { sizeBytes: number; locale: SupportedLocale },
): { title: string; description: string } {
  switch (state.kind) {
    case "too-large":
      // The file's own size and the limit are different numbers, and naming the
      // limit twice ("10 MB; the limit is 10 MB") is the kind of copy a reader
      // stops trusting.
      return {
        title: t("artifact.preview.tooLargeTitle"),
        description: t("files.preview.state.tooLarge", {
          size: formatFileSize(context.sizeBytes, context.locale, t),
          limit: formatFileSize(state.limit, context.locale, t),
        }),
      };
    case "unreadable":
      // A refusal carries no kind, so the sentence cannot name one.
      return {
        title: t("artifact.view.previewUnavailable"),
        description: t("files.preview.state.unreadableUnknown"),
      };
    case "unchecked":
      return {
        title: t("artifact.view.previewUnavailable"),
        description: t("files.preview.state.unchecked"),
      };
    case "host-unavailable":
      return {
        title: t("artifact.view.previewUnavailable"),
        description: t("files.preview.state.hostUnavailable"),
      };
    default:
      return {
        title: t("artifact.view.previewUnavailable"),
        description: t("files.preview.state.unsupported"),
      };
  }
}

function contentMismatch(error: unknown): boolean {
  // Two reporters: this page, when the parts of a read disagree with each other,
  // and the server, which refuses bytes that do not hash to the record. Both mean
  // the same thing to a person, so both show the Banner.
  return (error instanceof Error &&
    error.message === "ARTIFACT_PREVIEW_DIGEST_MISMATCH") ||
    isArtifactContentMismatch(error);
}

function isExpired(error: unknown): boolean {
  return error !== null && typeof error === "object" && "kind" in error &&
    error.kind === "problem" && "problem" in error &&
    typeof error.problem === "object" && error.problem !== null &&
    "status" in error.problem && error.problem.status === 410;
}
