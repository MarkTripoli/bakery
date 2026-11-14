import type { ArtifactViewerContent } from "@bakery/ui";

const markdown = `# Durable artifact delivery

*Revision 3 · October 11, 2026*

Artifacts survive worker restarts. Each revision keeps its content digest, run provenance, and review discussion.

## Verification

- Immutable revisions retain their SHA-256.
- Downloads verify bytes before saving.
- Comments remain linked to their original revision.

## Retention

Pin artifacts that must remain available. Expired content keeps its provenance and discussion.`;

const banners = {
  stale: {
    title: "A newer revision is available",
    body:
      "You are reading revision 3. Your selection and comment draft remain on this revision.",
    action: "Open revision 4",
    tone: "information",
  },
  reconnecting: {
    title: "Reconnecting",
    body:
      "Showing the last saved state. Live updates will continue when you are reconnected.",
    action: "Retry connection",
    tone: "warning",
  },
  "digest-failure": {
    title: "Download verification failed",
    body:
      "The received bytes do not match this revision’s SHA-256. No file was saved.",
    action: "Retry download",
    tone: "error",
  },
  "publish-conflict": {
    title: "Revision changed",
    body:
      "Your draft is preserved. Compare with the latest revision before publishing again.",
    action: "Compare revisions",
    tone: "warning",
  },
  "failed-mutation": {
    title: "Comment could not be saved",
    body:
      "Your reply is preserved below. Retry when the connection is restored.",
    action: "Retry save",
    tone: "error",
  },
} as const;

const unavailable = {
  empty: {
    title: "No published revisions",
    body: "Artifacts appear here after a worker publishes a revision.",
    action: "Back to task",
  },
  loading: {
    title: "Loading revision",
    body: "Retrieving metadata and verifying the bounded preview…",
    action: "Back to task",
  },
  "missing-version": {
    title: "Revision not found",
    body: "This version is unavailable. Select another published revision.",
    action: "View revisions",
  },
  unsupported: {
    title: "Preview unavailable",
    body:
      "application/octet-stream · Download the verified file to inspect it locally.",
    action: "Download verified file",
  },
} as const;

export function knownBanner(state: string) {
  switch (state) {
    case "stale":
    case "reconnecting":
    case "digest-failure":
    case "publish-conflict":
    case "failed-mutation":
      return banners[state];
    default:
      return undefined;
  }
}
export function unavailablePreview(state: string) {
  switch (state) {
    case "empty":
    case "loading":
    case "missing-version":
    case "unsupported":
      return unavailable[state];
    default:
      return undefined;
  }
}

export function contentFor(
  state: string,
  image: string,
): ArtifactViewerContent {
  switch (state) {
    case "text":
      return {
        kind: "text",
        text:
          "Delivery notes\n\nArtifact: delivery-notes.txt\nRevision: 3\nResult: durable output is available.\n\nPlain text stays literal: <script> is text.",
      };
    case "patch":
      return {
        kind: "patch",
        text:
          "diff --git a/retention.ts b/retention.ts\n@@ -21,2 +21,3 @@\n- deleteContent(version);\n+ if (!version.pinned) {\n+   expireContent(version);\n+ }",
      };
    case "log":
      return {
        kind: "log",
        text:
          "0001  preparing archive\n0002  reading stdout\n0003  verifying SHA-256\n0004  archive available\n…\n2048  upload complete",
      };
    case "image":
      return {
        kind: "image",
        src: image,
        alt: "Artifact lifecycle: Publish, Verify, Retain",
        unavailableLabel: "Preparing verified image preview",
      };
    default:
      return { kind: "markdown", text: markdown };
  }
}

export function artifactFixtureDetails({ state, version, pinned }: {
  readonly state: string;
  readonly version: string;
  readonly pinned: boolean;
}): {
  readonly artifact: import("../api/client.ts").ArtifactResponse;
  readonly versions:
    readonly import("../api/client.ts").ArtifactVersionResponse[];
  readonly selectedVersion:
    | import("../api/client.ts").ArtifactVersionResponse
    | null;
} {
  const timestamp = "2026-10-11T12:00:00.000Z";
  const mediaType = state === "image"
    ? "image/png"
    : state === "patch"
    ? "text/x-diff"
    : state === "log"
    ? "text/log"
    : state === "text"
    ? "text/plain"
    : state === "unsupported"
    ? "application/octet-stream"
    : "text/markdown";
  const name = state === "image"
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
  const sizeBytes = state === "image"
    ? 2458
    : state === "patch"
    ? 1229
    : state === "log"
    ? 253952
    : state === "unsupported"
    ? 131072
    : 13107;
  const versions = [3, 2].map((revision) => ({
    id: String(revision),
    artifactId: "delivery-notes",
    revision,
    runStepId: "42 / 3",
    authorId: "atlas-01",
    mediaType,
    sizeBytes,
    sha256: "83b1f9200000000000000000000000000000000000000000000000004e8d09a1",
    subjectHeadSha: "5d138ac",
    subjectBaseSha: "8ac02e1",
    metadata: { task: 130, run: 42, step: 3 },
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  }));
  return {
    artifact: {
      id: "delivery-notes",
      taskId: "130",
      artifactType: "plan",
      name,
      currentVersionId: state === "empty" ? null : "3",
      pinnedAt: pinned ? timestamp : null,
      pinnedBy: pinned ? "atlas-01" : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    versions: state === "empty" ? [] : versions,
    selectedVersion: state === "empty" || state === "missing-version"
      ? null
      : versions.find((item) => item.id === version) ?? null,
  };
}
