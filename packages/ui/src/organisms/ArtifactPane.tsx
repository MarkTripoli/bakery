import type { ReactNode } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Text } from "../atoms/Text.tsx";
import {
  ArtifactDescriptor,
  type ArtifactDescriptorProps,
  isSafeArtifactHref,
} from "../molecules/ArtifactDescriptor.tsx";
import { Combobox } from "../molecules/Combobox.tsx";
import { InlineNotice } from "../molecules/InlineNotice.tsx";
import { SessionPane } from "./SessionPane.tsx";
import "../collaboration.css";

export type ArtifactPaneState =
  | "ready"
  | "partial"
  | "unavailable"
  | "loading"
  | "empty"
  | "error"
  | "forbidden"
  | "offline"
  | "reconnecting";

export type ArtifactPaneLabels = Readonly<{
  /** Pane title in the ruled header row, beside the glyph. */
  paneTitle: ReactNode;
  versionSelect: string;
  preview: string;
  truncated: ReactNode;
  unavailable: ReactNode;
  loading: ReactNode;
  empty: ReactNode;
  error: ReactNode;
  forbidden: ReactNode;
  offline: ReactNode;
  reconnecting: ReactNode;
  download: ReactNode;
  open: ReactNode;
}>;

export type ArtifactPaneProps = {
  /** Accessible name of the pane region. */
  label: string;
  /** Artifact name, shown as the body heading (Paper HU-0 plan title). */
  title: ReactNode;
  meta?: ReactNode;
  labels: ArtifactPaneLabels;
  versions: readonly { value: string; label: string }[];
  version: string;
  onVersionChange: (value: string) => void;
  /** Descriptor facts of the selected version; absent while loading or empty. */
  descriptor?: ArtifactDescriptorProps extends infer D
    ? Omit<D & object, "href">
    : never;
  /** Bounded plain-text extract. Rendered as text, never as HTML. */
  previewText?: string;
  downloadHref?: string;
  openHref?: string;
  state?: ArtifactPaneState;
};

const NOTICES = {
  loading: "neutral",
  empty: "information",
  error: "error",
  forbidden: "error",
  offline: "warning",
  reconnecting: "warning",
  unavailable: "information",
  partial: "information",
} as const;

/**
 * The artifact side pane of a task session (Paper HU-0 plan pane). The ruled
 * header row, title block and footer come from `SessionPane`; the body holds
 * the descriptor and a bounded plain-text preview. Preview bytes are inert
 * text; an unsupported media type says "preview unavailable" and keeps the
 * actions.
 */
export function ArtifactPane(
  {
    descriptor,
    downloadHref,
    label,
    labels,
    meta,
    onVersionChange,
    openHref,
    previewText,
    state = "ready",
    title,
    version,
    versions,
  }: ArtifactPaneProps,
) {
  const notice = state === "ready" ? null : {
    text: labels[state === "partial" ? "truncated" : state],
    tone: NOTICES[state],
  };
  const showsText = (state === "ready" || state === "partial" ||
    state === "offline" || state === "reconnecting") &&
    previewText !== undefined;
  const actionable = state !== "loading" && state !== "empty" &&
    state !== "forbidden" && state !== "error";
  const download = actionable && isSafeArtifactHref(downloadHref)
    ? downloadHref
    : undefined;
  const open = actionable && isSafeArtifactHref(openHref)
    ? openHref
    : undefined;
  return (
    <SessionPane
      footer={download || open
        ? (
          <>
            {download
              ? (
                <a
                  className="ui-button ui-button--outline"
                  download
                  href={download}
                >
                  {labels.download}
                </a>
              )
              : null}
            {open
              ? (
                <a className="ui-button ui-button--primary" href={open}>
                  {labels.open}
                </a>
              )
              : null}
          </>
        )
        : undefined}
      header={
        <>
          <IconGlyph name="file" />
          <Text>{labels.paneTitle}</Text>
          {versions.length > 0 && (
            <Combobox
              appearance="filter"
              data-paged-list="versions"
              disabled={state === "loading"}
              label={labels.versionSelect}
              onChange={(event) => onVersionChange(event.target.value)}
              options={versions.map((item) => ({ ...item }))}
              value={version}
            />
          )}
        </>
      }
      label={label}
      meta={meta}
      state={state === "loading" ? "loading" : "default"}
      title={title}
    >
      <div
        className="ui-artifact-pane"
        data-state={state}
        data-ui-component="artifactPane"
        data-variant="pane"
      >
        <div
          aria-atomic="true"
          aria-live="polite"
          className="ui-artifact-pane__notice"
          role="status"
        >
          {notice
            ? (
              <InlineNotice role="none" tone={notice.tone}>
                {notice.text}
              </InlineNotice>
            )
            : null}
        </div>
        {descriptor && state !== "loading" && state !== "empty"
          ? <ArtifactDescriptor {...descriptor} />
          : null}
        {showsText
          ? (
            <div
              aria-label={labels.preview}
              className="ui-artifact-pane__preview"
              data-rail="truncation-allowed"
              role="region"
              tabIndex={0}
            >
              <pre dir="ltr">{previewText}</pre>
            </div>
          )
          : null}
      </div>
    </SessionPane>
  );
}
