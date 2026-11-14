import { type ReactNode, useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import { useShellViewport } from "../app/responsive.ts";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";

export type ArtifactEvidence = {
  readonly title: string;
  readonly baseLabel: string;
  readonly headLabel: string;
  readonly context: string;
  readonly base: string;
  readonly head: string;
  readonly digest: string;
  readonly taskAction: { readonly label: string; readonly onClick: () => void };
  readonly details: {
    readonly label: string;
    readonly content: ReactNode;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  };
};

export type ArtifactRetrievalViewProps = {
  readonly title: string;
  readonly kind: string;
  readonly artifactLabel: string;
  readonly revision: string;
  readonly description: string;
  readonly versions: readonly { readonly id: string; readonly label: string }[];
  readonly versionId: string;
  readonly versionLabel: string;
  readonly onVersionChange: (id: string) => void;
  readonly download?: {
    readonly label: string;
    readonly busy?: boolean;
    readonly onClick: () => void;
    readonly testId?: string;
  };
  readonly pinControl: ReactNode;
  /** Isolated-preview handoff; absent where no preview can be offered. */
  readonly previewHandoff?: ReactNode;
  readonly notices?: readonly UI.ArtifactLayoutNotice[];
  readonly banner?: ReactNode;
  readonly evidence: ArtifactEvidence;
  readonly preview: ReactNode;
  readonly discussion: ReactNode;
  readonly comments: {
    readonly title: string;
    readonly openLabel: string;
    readonly linkedCommentId?: string | null;
  };
  readonly testId?: string;
};

/** Shared page composition; controllers supply revision-bound data and actions. */
export function ArtifactRetrievalView(props: ArtifactRetrievalViewProps) {
  const isPhone = useShellViewport() === "phone";
  const [commentsOpen, setCommentsOpen] = useState(false);
  const discussionRef = useRef<HTMLDivElement>(null);
  const [focusDiscussion, setFocusDiscussion] = useState(false);
  // The phone trigger is replaced by the discussion; move focus into it.
  useEffect(() => {
    if (focusDiscussion && commentsOpen) discussionRef.current?.focus();
  }, [focusDiscussion, commentsOpen]);
  useEffect(() => {
    if (props.comments.linkedCommentId) setCommentsOpen(true);
  }, [props.comments.linkedCommentId]);
  const evidence = props.evidence;
  return (
    <>
      <ShellActiveNavigation id="work" />
      <UI.ArtifactLayout
        data-testid={props.testId}
        data-artifact-retrieval-detail="true"
        title={props.title}
        eyebrow={
          <UI.Inline>
            <UI.Text variant="caption">
              {props.artifactLabel} · {props.kind.toUpperCase()}
            </UI.Text>
            <UI.Badge>{props.revision}</UI.Badge>
          </UI.Inline>
        }
        description={props.description}
        versions={
          <UI.VersionPicker
            name="versions"
            label={props.versionLabel}
            labelHidden
            value={props.versionId}
            versions={props.versions}
            onChange={props.onVersionChange}
          />
        }
        actions={
          <>
            {props.download
              ? (
                <UI.Button
                  variant="outline"
                  aria-busy={props.download.busy || undefined}
                  data-testid={props.download.testId}
                  state={props.download.busy ? "loading" : "default"}
                  onClick={props.download.onClick}
                >
                  {props.download.label}
                </UI.Button>
              )
              : null}
            {props.pinControl}
            {props.previewHandoff}
          </>
        }
        notices={props.notices}
        banner={props.banner}
        evidence={
          <>
            <UI.Heading rank={2} level="subsection">
              {evidence.title}
            </UI.Heading>
            <UI.Text variant="caption">{evidence.context}</UI.Text>
            <UI.CodeBlock
              code={`${evidence.baseLabel} ${evidence.base}  →  ${evidence.headLabel} ${evidence.head}\nsha256 ${evidence.digest}`}
            />
            <UI.Inline>
              <UI.Button
                variant="outline"
                onClick={evidence.taskAction.onClick}
              >
                {evidence.taskAction.label}
              </UI.Button>
              <UI.Button
                id="artifact-revision-details-toggle"
                data-testid="artifact-retrieval-details-toggle"
                variant="outline"
                aria-expanded={evidence.details.open}
                aria-controls="artifact-revision-details"
                onClick={() =>
                  evidence.details.onOpenChange(!evidence.details.open)}
              >
                {evidence.details.label}
              </UI.Button>
            </UI.Inline>
            <div
              id="artifact-revision-details"
              data-testid="artifact-retrieval-details"
              hidden={!evidence.details.open}
            >
              {evidence.details.content}
            </div>
          </>
        }
        comments={!isPhone
          ? props.discussion
          : commentsOpen
          ? (
            <div ref={discussionRef} tabIndex={-1}>
              {props.discussion}
            </div>
          )
          : (
            <UI.Inline>
              <UI.Button
                variant="outline"
                onClick={() => {
                  setFocusDiscussion(true);
                  setCommentsOpen(true);
                }}
              >
                {props.comments.openLabel}
              </UI.Button>
            </UI.Inline>
          )}
      >
        {props.preview}
      </UI.ArtifactLayout>
    </>
  );
}

type ArtifactUnavailablePreview = {
  readonly title: string;
  readonly description: string;
  readonly action: { readonly label: string; readonly onClick: () => void };
  readonly expired?: boolean;
};
export type ArtifactPreviewViewProps =
  & {
    readonly label: string;
    readonly footer?: ReactNode;
  }
  & (
    | { readonly state: "content"; readonly content: UI.ArtifactViewerContent }
    | {
      readonly state: "unavailable";
      readonly unavailable: ArtifactUnavailablePreview;
    }
  );

export function ArtifactPreviewView(props: ArtifactPreviewViewProps) {
  const content: UI.ArtifactViewerContent = props.state === "content"
    ? props.content
    : {
      kind: "unsupported",
      message: props.unavailable.expired
        ? (
          <UI.ArtifactTombstone
            title={props.unavailable.title}
            description={props.unavailable.description}
            state="expired"
            variant="embedded"
            actions={
              <UI.Button
                variant="outline"
                onClick={props.unavailable.action.onClick}
              >
                {props.unavailable.action.label}
              </UI.Button>
            }
          />
        )
        : (
          <UI.Stack>
            <UI.Heading level="subsection" rank={2}>
              {props.unavailable.title}
            </UI.Heading>
            <UI.Text variant="muted">{props.unavailable.description}</UI.Text>
            <UI.Inline>
              <UI.Button
                variant="outline"
                onClick={props.unavailable.action.onClick}
              >
                {props.unavailable.action.label}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        ),
    };
  return (
    <UI.ArtifactViewer
      label={props.label}
      content={content}
      footer={props.footer}
    />
  );
}

export function ArtifactUnavailableView(
  { title, description, preview, status, testId }: {
    readonly title: string;
    readonly description: string;
    /** A forbidden read never mounts the artifact viewer, only a denial. */
    readonly preview:
      | ArtifactPreviewViewProps
      | {
        readonly state: "denied";
        readonly label: string;
        readonly denied: ArtifactUnavailablePreview;
      };
    readonly status?: string;
    readonly testId?: string;
  },
) {
  return (
    <>
      <ShellActiveNavigation id="work" />
      <UI.ArtifactLayout
        data-testid={testId}
        title={title}
        description={description}
        variant="unavailable"
        unavailableLabel={preview.state === "denied"
          ? preview.label
          : undefined}
      >
        {preview.state === "denied"
          ? (
            <UI.ErrorState
              title={preview.denied.title}
              description={preview.denied.description}
              action={
                <UI.Button
                  variant="outline"
                  onClick={preview.denied.action.onClick}
                >
                  {preview.denied.action.label}
                </UI.Button>
              }
            />
          )
          : <ArtifactPreviewView {...preview} />}
        {status ? <UI.Text role="status">{status}</UI.Text> : null}
      </UI.ArtifactLayout>
    </>
  );
}
