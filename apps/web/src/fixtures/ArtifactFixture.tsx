import { useRef, useState } from "react";
import { ArtifactStorageView } from "../pages/ArtifactStorageStatus.tsx";
import { ArtifactPinView } from "../pages/ArtifactPinControl.tsx";
import {
  ArtifactAgentControlView,
  ArtifactAgentDialogView,
  ArtifactDiscussionView,
} from "../pages/ArtifactDiscussionView.tsx";
import * as UI from "@bakery/ui";
import { ArtifactRevisionDetailsView } from "../pages/ArtifactRevisionDetailsView.tsx";
import { artifactFixtureDetails } from "./artifact-fixture-data.ts";
import {
  ArtifactPreviewView,
  ArtifactRetrievalView,
  ArtifactUnavailableView,
} from "../pages/ArtifactRetrievalView.tsx";
import {
  contentFor,
  knownBanner,
  unavailablePreview,
} from "./artifact-fixture-data.ts";
import { useArtifactFixtureImage } from "./artifact-fixture-image.ts";

export function ArtifactFixture(
  { state = "default" }: { readonly state?: string },
) {
  const openDiscussion = [
    "comments",
    "outdated",
    "deleted",
    "reply",
    "failed-mutation",
    "publish-conflict",
    "send-to-agent",
  ].includes(state);
  const [startByteInput, setStartByteInput] = useState("0");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [agentMessage, setAgentMessage] = useState("");
  const [version, setVersion] = useState("3");
  const [confirmUnpin, setConfirmUnpin] = useState(false);
  const [pinned, setPinned] = useState(state === "pinned");
  const [resolved, setResolved] = useState(false);
  const [agentOpen, setAgentOpen] = useState(state === "send-to-agent");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState(
    ["reply", "failed-mutation", "publish-conflict"].includes(state)
      ? "I checked the retained revision and its digest."
      : "",
  );
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [replies, setReplies] = useState([{
    id: "reply-1",
    author: "Sam Rivera · reply",
    body: "Yes. Revision 3 is the audit reference.",
  }]);
  const image = useArtifactFixtureImage(state);

  const kind = state === "unsupported"
    ? "Binary"
    : ["image", "patch", "log", "text"].includes(state)
    ? state
    : "Markdown";
  const title = state === "image"
    ? "lifecycle.png"
    : state === "patch"
    ? "retention.patch"
    : state === "log"
    ? "run-42.log"
    : state === "text"
    ? "delivery-notes.txt"
    : state === "unsupported"
    ? "delivery.bundle"
    : "delivery-notes.md";
  const size = state === "image"
    ? "2.4 KiB"
    : state === "patch"
    ? "1.2 KiB"
    : state === "log"
    ? "248 KiB"
    : state === "unsupported"
    ? "128 KiB"
    : "12.8 KiB";
  const banner = knownBanner(state);
  const missing = unavailablePreview(state);
  const download = () =>
    setMessage(
      "Download selected.",
    );

  if (state === "forbidden") {
    return (
      <ArtifactUnavailableView
        title="Artifact access"
        description="Your current role cannot read this artifact."
        preview={{
          state: "denied",
          label: "Access denied",
          denied: {
            title: "Artifact access denied",
            description:
              "Your current role cannot read this artifact. Request access from an organization administrator.",
            action: {
              label: "Back to task",
              onClick: () => setMessage("Back to task"),
            },
          },
        }}
        status={message}
      />
    );
  }

  const agentDialog = (
    <ArtifactAgentDialogView
      title="Send discussion to agent"
      description="Create a task from this thread and its immutable revision context. This does not modify the current artifact."
      open={agentOpen}
      onOpenChange={setAgentOpen}
      dismissLabel="Close send discussion to agent"
      cancel={{ label: "Cancel", onClick: () => setAgentOpen(false) }}
      submit={{
        label: "Create task",
        disabled: !agentMessage.trim(),
        onClick: () => {
          setAgentOpen(false);
          setMessage("Task created from revision " + version);
        },
      }}
      message={{
        id: "artifact-agent-body",
        label: "Agent request",
        value: agentMessage,
        onChange: setAgentMessage,
      }}
      context={`delivery-notes.md · revision ${version}\nsha256 83b1f920…4e8d09a1\nThread: Retention / ${
        replies.length + 1
      } comments`}
    />
  );
  const fixtureDetails = artifactFixtureDetails({ state, version, pinned });
  const discussion = (
    <ArtifactDiscussionView
      id="comment-fixture-root"
      title="Discussion"
      count={replies.length + 1}
      location={state === "outdated"
        ? "Outdated anchor · Revision 2 / Retention"
        : `Revision ${version} / Retention`}
      notice={state === "outdated"
        ? (
          <UI.Button
            variant="outline"
            onClick={() => setVersion("2")}
          >
            Open original revision
          </UI.Button>
        )
        : undefined}
      author="Alex Lee"
      initials="AL"
      timestamp="5 min ago"
      body={state === "deleted"
        ? "This comment was deleted. Replies remain available."
        : "Can we keep the release evidence pinned until the audit is complete?"}
      state={state === "deleted"
        ? "deleted"
        : state === "outdated"
        ? "outdated"
        : resolved
        ? "resolved"
        : "open"}
      replies={replies}
      replyAction={{
        label: "Reply",
        pressed: true,
        onClick: () => replyRef.current?.focus(),
      }}
      resolveAction={{
        label: resolved ? "Reopen" : "Resolve",
        onClick: () => setResolved(!resolved),
      }}
      composer={{
        id: "artifact-comment-body",
        disabled: false,
        mode: {
          kind: "reply",
          onCancel: () => {
            setReply("");
            setMessage("Reply cancelled");
          },
        },
        inputRef: replyRef,
        label: "Reply to discussion",
        placeholder: "Write a reply…",
        value: reply,
        onChange: setReply,
        onSubmit: () => {
          if (!reply.trim()) return;
          setReplies([...replies, {
            id: `reply-${replies.length + 1}`,
            author: "You · reply",
            body: reply,
          }]);
          setReply("");
        },
        submitLabel: "Send reply",
        agentAction: (
          <ArtifactAgentControlView
            label="Send to agent"
            disabled={false}
            onOpen={() => setAgentOpen(true)}
            dialog={agentDialog}
          />
        ),
      }}
    />
  );

  return (
    <ArtifactRetrievalView
      testId="artifact-fixture"
      title={title}
      kind={kind}
      artifactLabel="ARTIFACT"
      revision={`Revision ${version}`}
      description={`Published by worker atlas-01 · Run 42 / Step 3 · ${size}`}
      versionLabel="Version"
      versionId={version}
      versions={[{ id: "3", label: "Revision 3" }, {
        id: "2",
        label: "Revision 2",
      }]}
      onVersionChange={setVersion}
      download={{ label: "Download", onClick: download }}
      pinControl={
        <ArtifactPinView
          label={pinned ? "Unpin artifact" : "Pin artifact"}
          busy={false}
          error={false}
          confirm={confirmUnpin}
          onPress={() => pinned ? setConfirmUnpin(true) : setPinned(true)}
          onConfirm={() => {
            setPinned(false);
            setConfirmUnpin(false);
          }}
          onOpenChange={setConfirmUnpin}
          onReload={() => setConfirmUnpin(false)}
          labels={{
            unpin: "Unpin artifact",
            error: "Pin could not be saved",
            reload: "Reload artifact",
            close: "Close",
            warning: "Unpinning allows retention to expire artifact content.",
          }}
        />
      }
      notices={[
        ...(banner
          ? [{
            id: state,
            title: banner.title,
            description: banner.body,
            tone: banner.tone,
            actions: (
              <UI.Button
                variant="outline"
                onClick={() => setMessage(banner.action)}
              >
                {banner.action}
              </UI.Button>
            ),
          }]
          : []),
        ...(pinned
          ? [{
            id: "pinned",
            title: "Pinned artifact",
            description:
              "All revisions remain available while this artifact is pinned.",
            tone: "success" as const,
          }]
          : []),
      ]}
      banner={
        <>
          {state === "capacity-paused"
            ? (
              <ArtifactStorageView
                title="Publishing paused · storage full"
                description="Pinned artifacts remain available. Free storage before publishing a new revision."
                state="paused"
                action={{
                  label: "Manage storage",
                  onClick: () => setMessage("Storage management opened"),
                }}
              />
            )
            : null}
          {message ? <UI.Text role="status">{message}</UI.Text> : null}
        </>
      }
      evidence={{
        title: "Evidence context",
        baseLabel: "base",
        headLabel: "head",
        context: "Task 130 / Run 42 / Step 3",
        base: "8ac02e1",
        head: "5d138ac",
        digest: "83b1f920…4e8d09a1",
        taskAction: {
          label: "Open task",
          onClick: () => setMessage("Task 130"),
        },
        details: {
          label: "View details",
          open: detailsOpen,
          onOpenChange: setDetailsOpen,
          content: (
            <ArtifactRevisionDetailsView
              artifact={fixtureDetails.artifact}
              organizationId="bakery"
              artifactCount={1}
              retrying={false}
              selectedVersion={fixtureDetails.selectedVersion}
              versionItems={fixtureDetails.versions}
              onSelectVersion={setVersion}
              extraction={{
                maxBytes: 65536,
                startByte: startByteInput,
                onStartByteChange: setStartByteInput,
                onExtract: () => setMessage("Bounded preview requested"),
                validationError: null,
                loading: false,
                failed: false,
                requested: false,
                invalid: false,
                result: null,
              }}
            />
          ),
        },
      }}
      comments={{
        title: "Comments",
        openLabel: `Open comments (${replies.length + 1})`,
        linkedCommentId: openDiscussion ? "fixture-root" : null,
      }}
      discussion={
        <UI.CommentRail title="Comments">{discussion}</UI.CommentRail>
      }
      preview={
        <ArtifactPreviewView
          label={`Preview · ${kind}`}
          {...(state === "expired"
            ? {
              state: "unavailable" as const,
              unavailable: {
                title: "Content expired",
                description:
                  "Revision 3 expired on October 10. Provenance and comments are retained. Pin an available artifact to retain its content.",
                expired: true,
                action: {
                  label: "View revisions",
                  onClick: () => setVersion("2"),
                },
              },
            }
            : missing
            ? {
              state: "unavailable" as const,
              unavailable: {
                title: missing.title,
                description: missing.body,
                action: {
                  label: missing.action,
                  onClick: () => setMessage(missing.action),
                },
              },
            }
            : { state: "content" as const, content: contentFor(state, image) })}
          footer={state === "log"
            ? (
              <UI.Stack>
                <UI.Text variant="caption">
                  Showing 64 KiB of 248 KiB. Preview truncated.
                </UI.Text>
                <UI.Inline>
                  <UI.Button variant="outline" onClick={download}>
                    Download full log
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            )
            : state === "image"
            ? (
              <UI.Text variant="caption">
                lifecycle.png · 640 × 240 · verified image preview
              </UI.Text>
            )
            : undefined}
        />
      }
    />
  );
}
