import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { ArtifactVersionResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

import {
  type ArtifactAnchor,
  imageAnchor,
  isArtifactAnchor,
  markdownBlocks,
  patchAnchors,
  textAnchor,
} from "./ArtifactCommentAnchor.model.ts";
export type { ArtifactAnchor } from "./ArtifactCommentAnchor.model.ts";

export function ArtifactAnchorDescription(
  { anchor }: { readonly anchor: unknown },
) {
  const { translate: t } = useI18n();
  if (!isArtifactAnchor(anchor)) return null;
  switch (anchor.kind) {
    case "text":
      return (
        <UI.Text>
          {t("artifact.comments.anchorText")}{" "}
          {anchor.startLine}–{anchor.endLine}: {anchor.quote}
        </UI.Text>
      );
    case "markdown":
      return (
        <UI.Text>
          {t("artifact.comments.anchorMarkdown")} {anchor.blockIndex + 1}:{" "}
          {anchor.selectedText}
        </UI.Text>
      );
    case "image":
      return (
        <UI.Text>
          {t("artifact.comments.anchorImage")}: {anchor.x * 100}%,{" "}
          {anchor.y * 100}%; {anchor.width * 100}% × {anchor.height * 100}%
        </UI.Text>
      );
    case "patch":
      return (
        <UI.Text>
          {t("artifact.comments.anchorPatch")}: {anchor.path} ({anchor.side})
          {" "}
          {anchor.startLine}–{anchor.endLine}
        </UI.Text>
      );
    default: {
      const unreachable: never = anchor;
      return unreachable;
    }
  }
}

export function ArtifactCommentAnchor({ version, disabled, onChange }: {
  readonly version: ArtifactVersionResponse;
  readonly disabled: boolean;
  readonly onChange: (anchor: ArtifactAnchor | null, invalid: boolean) => void;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [location, setLocation] = useState(1);
  const [endLocation, setEndLocation] = useState(1);
  const [region, setRegion] = useState({ x: 0, y: 0, width: 100, height: 100 });
  const mediaType = version.mediaType.split(";", 1)[0].trim().toLowerCase();
  const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
    mediaType,
  );
  const supported = image ||
    [
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/log",
      "text/x-diff",
      "text/x-patch",
    ].includes(mediaType);
  const content = useQuery({
    queryKey: protectedQueryKey(scope, "artifactVersions.verifiedPreview", {
      versionId: version.id,
      sha256: version.sha256,
    }),
    enabled: enabled && supported && scope.organizationId !== null,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) throw new Error("ORGANIZATION_REQUIRED");
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId: version.id,
        expectedSha256: version.sha256.toLowerCase(),
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
  const text = useMemo(() => {
    if (!enabled || !content.data || image) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content.data);
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  }, [enabled, content.data, image]);
  const plainText = !image && mediaType !== "text/markdown" &&
    mediaType !== "text/x-diff" && mediaType !== "text/x-patch";
  const anchors = useMemo((): ArtifactAnchor[] => {
    if (!enabled || text === null || plainText) return [];
    if (mediaType === "text/markdown") {
      const blocks = markdownBlocks(text);
      return blocks.map((blockText, blockIndex) => ({
        kind: "markdown",
        blockIndex,
        blockText,
        selectedText: blockText,
        start: 0,
        end: blockText.length,
        previousBlock: blocks[blockIndex - 1] ?? null,
        nextBlock: blocks[blockIndex + 1] ?? null,
      }));
    }
    if (mediaType === "text/x-diff" || mediaType === "text/x-patch") {
      return patchAnchors(text, version);
    }
    return [];
  }, [enabled, text, mediaType, version, plainText]);
  const locationCount = useMemo(
    () => plainText && text !== null ? text.split("\n").length : anchors.length,
    [plainText, text, anchors],
  );
  const candidate = useMemo(
    () =>
      !enabled
        ? null
        : image
        ? imageAnchor(region)
        : plainText && text !== null
        ? textAnchor(text, location, endLocation)
        : anchors[location - 1],
    [enabled, image, region, plainText, text, location, endLocation, anchors],
  );
  const anchor = isArtifactAnchor(candidate) ? candidate : null;
  const valid = content.data !== undefined && !content.isError &&
    anchor !== null;
  const anchorKey = valid ? JSON.stringify(anchor) : "";
  useEffect(() => {
    onChange(enabled && valid ? anchor : null, enabled && !valid);
  }, [enabled, valid, anchorKey, onChange]);
  if (!supported) return null;
  return (
    <UI.Stack gap="compact">
      <UI.Checkbox
        checked={enabled}
        disabled={disabled}
        onChange={(event) => setEnabled(event.currentTarget.checked)}
      >
        {t("artifact.comments.anchor")}
      </UI.Checkbox>
      {enabled
        ? (
          <>
            {image
              ? (
                <UI.Stack gap="compact">
                  {(["x", "y", "width", "height"] as const).map((field) => (
                    <UI.Field
                      key={field}
                      htmlFor={`artifact-anchor-${field}`}
                      label={t(
                        ({
                          x: "artifact.comments.anchorX",
                          y: "artifact.comments.anchorY",
                          width: "artifact.comments.anchorWidth",
                          height: "artifact.comments.anchorHeight",
                        } as const)[field],
                      )}
                    >
                      <UI.TextInput
                        id={`artifact-anchor-${field}`}
                        name={`artifact-anchor-${field}`}
                        type="number"
                        autoComplete="off"
                        min={field === "x" || field === "y" ? 0 : 1}
                        max={100}
                        value={String(region[field])}
                        disabled={disabled}
                        onChange={(value) =>
                          setRegion({
                            ...region,
                            [field]: Number(value),
                          })}
                      />
                    </UI.Field>
                  ))}
                </UI.Stack>
              )
              : (
                <UI.Stack gap="compact">
                  <UI.Field
                    htmlFor="artifact-anchor-location"
                    label={t("artifact.comments.anchorSource")}
                  >
                    <UI.TextInput
                      id="artifact-anchor-location"
                      name="artifact-anchor-location"
                      type="number"
                      autoComplete="off"
                      min={1}
                      max={locationCount}
                      value={String(location)}
                      disabled={disabled}
                      onChange={(value) => {
                        const next = Number(value);
                        setLocation(next);
                        setEndLocation(next);
                      }}
                    />
                  </UI.Field>
                  {plainText
                    ? (
                      <UI.Field
                        htmlFor="artifact-anchor-end-location"
                        label={t("artifact.comments.anchorEnd")}
                      >
                        <UI.TextInput
                          id="artifact-anchor-end-location"
                          name="artifact-anchor-end-location"
                          type="number"
                          autoComplete="off"
                          min={location}
                          max={locationCount}
                          value={String(endLocation)}
                          disabled={disabled}
                          onChange={(value) => setEndLocation(Number(value))}
                        />
                      </UI.Field>
                    )
                    : null}
                </UI.Stack>
              )}
            {content.isPending
              ? <UI.Skeleton shape="text" />
              : valid && anchor
              ? <ArtifactAnchorDescription anchor={anchor} />
              : (
                <UI.InlineNotice tone="error">
                  {t(
                    content.isError
                      ? "artifact.comments.anchorUnavailable"
                      : "artifact.comments.anchorInvalid",
                  )}
                </UI.InlineNotice>
              )}
          </>
        )
        : null}
    </UI.Stack>
  );
}
