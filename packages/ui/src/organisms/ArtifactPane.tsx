import type { ReactNode } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Text } from "../atoms/Text.tsx";
import {
  ArtifactDescriptor,
  type ArtifactDescriptorProps,
  isSafeArtifactHref,
} from "../molecules/ArtifactDescriptor.tsx";
import { Combobox } from "../molecules/Combobox.tsx";
import { Disclosure } from "../molecules/Disclosure.tsx";
import { InlineNotice } from "../molecules/InlineNotice.tsx";
import { artifactViewerRegion } from "./ArtifactViewer.tsx";
import { SessionPane } from "./SessionPane.tsx";
import "../collaboration.css";

// A capitalised name, so the provider reads as JSX.
const PreviewRegion = artifactViewerRegion;

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
  /** The closed control that holds `details`, for example "Details". */
  details?: ReactNode;
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
  /**
   * The preview body: what `ArtifactViewer` renders, so the pane and the
   * artifact page show one file the same way. A caller that has only text passes
   * a `<pre>`; a caller that knows the kind from the probe passes the viewer.
   * Never HTML from the file.
   */
  preview?: ReactNode;
  downloadHref?: string;
  openHref?: string;
  /**
   * The facts about the selected version, shown under a closed Details control.
   * When given, it takes the place of the descriptor's table.
   */
  details?: ReactNode;
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
    details,
    downloadHref,
    label,
    labels,
    meta,
    onVersionChange,
    openHref,
    preview,
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
    preview !== undefined;
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
                <a className="ui-button ui-button--outline" href={open}>
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
        {details !== undefined && state !== "loading" && state !== "empty"
          ? <Disclosure summary={labels.details}>{details}</Disclosure>
          : descriptor && state !== "loading" && state !== "empty"
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
              <PreviewRegion.Provider value>
                {preview}
              </PreviewRegion.Provider>
            </div>
          )
          : null}
      </div>
    </SessionPane>
  );
}
