import type { ComponentProps } from "react";
import type * as UI from "@bakery/ui";

export const runOutputFixtureStates = [
  "default",
  "truncated",
  "reconnecting",
  "reset",
  "exit",
  "interrupted",
  "quota",
  "usage-unknown",
  "timeout",
  "lost-lease",
] as const;

export type RunOutputFixtureState = (typeof runOutputFixtureStates)[number];
type Notice = Readonly<{
  title: string;
  description: string;
  actionLabel: string;
}>;
type FixtureState = Readonly<{
  notice: Notice | undefined;
  lease: string;
  outputState: ComponentProps<typeof UI.RunOutputPanel>["state"];
}>;

const stateData: Record<RunOutputFixtureState, FixtureState> = {
  default: { notice: undefined, lease: "Lease active", outputState: "live" },
  truncated: {
    lease: "Lease active",
    outputState: "truncated",
    notice: {
      title: "Output truncated",
      description:
        "Showing the latest 64 KiB. Earlier output remains in the durable archive.",
      actionLabel: "Download full output",
    },
  },
  reconnecting: {
    lease: "Lease active",
    outputState: "reconnecting",
    notice: {
      title: "Reconnecting",
      description:
        "Showing the last saved state. Live updates will continue when you are reconnected.",
      actionLabel: "Retry connection",
    },
  },
  reset: {
    lease: "Lease active",
    outputState: "reset",
    notice: {
      title: "History expired",
      description:
        "The live cursor is no longer retained. Load the durable archive to recover earlier output.",
      actionLabel: "Load archive",
    },
  },
  exit: {
    lease: "Lease released",
    outputState: "complete",
    notice: {
      title: "Process exited · code 0",
      description:
        "Execution finished. Review and merge are separate decisions.",
      actionLabel: "Open artifacts",
    },
  },
  interrupted: {
    lease: "Lease active",
    outputState: "interrupted",
    notice: {
      title: "Output interrupted",
      description:
        "The stream ended before a terminal record. Execution outcome is unknown.",
      actionLabel: "Reload run",
    },
  },
  quota: {
    lease: "Lease active",
    outputState: "interrupted",
    notice: {
      title: "Run paused · storage capacity",
      description:
        "Free space or increase capacity before another artifact can publish.",
      actionLabel: "Manage storage",
    },
  },
  "usage-unknown": {
    lease: "Lease active",
    outputState: "interrupted",
    notice: {
      title: "Usage unavailable",
      description:
        "The provider has not reported final usage. No estimated charge is shown.",
      actionLabel: "Refresh usage",
    },
  },
  timeout: {
    lease: "Lease released",
    outputState: "interrupted",
    notice: {
      title: "Run timed out",
      description:
        "The worker exceeded its execution deadline. Last durable output is retained.",
      actionLabel: "View run details",
    },
  },
  "lost-lease": {
    lease: "Machine stopped responding",
    outputState: "interrupted",
    notice: {
      title: "Task taken back",
      description:
        "The machine stopped responding and the task was taken back. The last output is kept; live status is not confirmed.",
      actionLabel: "Reload run",
    },
  },
};

const output = [
  "14:32:01  worker atlas-01 acquired attempt 2",
  "14:32:02  $ pnpm test:unit",
  "14:32:03  artifact retention … passed",
  "14:32:04  immutable revision … passed",
  "14:32:05  18 tests passed, 0 failed",
  "14:32:06  writing delivery-notes.md",
  "14:32:07  published revision 3",
] as const;

export type RunOutputFixtureData = Readonly<{
  title: string;
  description: string;
  reference: string;
  status: string;
  notice: Notice | undefined;
  identity: ComponentProps<typeof UI.RunIdentity>;
  output: ComponentProps<typeof UI.RunOutputPanel>;
  revision: ComponentProps<typeof UI.RevisionSummary>;
  artifact: Omit<ComponentProps<typeof UI.RunArtifactSummary>, "actions">;
  inspector: Omit<ComponentProps<typeof UI.ArtifactPane>, "onVersionChange">;
}>;

export function runOutputFixtureData(state: string): RunOutputFixtureData {
  const selected = runOutputFixtureStates.find((value) => value === state) ??
    "default";
  const fixture = stateData[selected];
  return {
    title: "Make artifact delivery durable",
    description: "Platform / bakery · started 2 minutes ago",
    reference: "TASK 130 · RUN 42",
    status: fixture.notice?.title ?? "Running",
    notice: fixture.notice,
    identity: {
      title: "Execution identity",
      worker: "atlas-01",
      attempt: "Try 2",
      lease: fixture.lease,
      detail: "Codex · trusted worker record · run_42 / step_3",
      unknownLabel: "Unknown",
    },
    output: {
      title: "Run output",
      state: fixture.outputState,
      entries: [
        ...output,
        selected === "exit"
          ? "14:32:08  process exited (0)"
          : "14:32:08  waiting for next output…",
      ].map((message, index) => ({ id: String(index), message })),
      statusLabel: selected === "default" ? "Live" : "Last durable output",
      captureLabel: "stdout + stderr · cursor 128",
      downloadLink: { href: "#output", label: "Download output" },
      latestLabel: "Jump to latest",
    },
    revision: {
      title: "Changes",
      baseRevision: "8ac02e1",
      candidateRevision: "5d138ac",
      summary: "3 files · +84 −12",
      disclaimer:
        "Observed repository state. No review or merge decision recorded.",
      unknownLabel: "Unknown",
      diffLink: { href: "#diff", label: "View diff" },
    },
    artifact: {
      title: "Artifacts",
      name: "delivery-notes.md",
      revision: "r3",
      size: "12.8 KiB",
      detail: "Immutable revision · sha256 83b1f920…4e8d09a1",
    },
    inspector: {
      label: "Artifact",
      title: "delivery-notes.md",
      meta: "Version 3 · text/plain",
      versions: [{ value: "revision-3", label: "Version 3" }],
      version: "revision-3",
      state: "ready",
      labels: {
        paneTitle: "Artifact",
        versionSelect: "Artifact version",
        preview: "Artifact text preview",
        truncated: "Preview truncated",
        unavailable: "Preview unavailable",
        loading: "Loading artifact",
        empty: "No artifact",
        error: "Could not load artifact",
        forbidden: "Artifact unavailable",
        offline: "Offline",
        reconnecting: "Reconnecting",
        download: "Download",
        open: "Open",
      },
      descriptor: {
        artifactId: "00000000-0000-4000-8000-000000000102",
        version: "3",
        digest: "a".repeat(64),
        size: "97 bytes",
        mediaType: "text/plain",
        provenance: "00000000-0000-4000-8000-000000000104",
        labels: {
          artifactId: "ID",
          version: "Version",
          digest: "Digest",
          size: "Size",
          mediaType: "Media type",
          provenance: "Provenance",
          link: "Open",
        },
      },
      previewText:
        "# Delivery notes\n\nArtifact retention and immutable revisions verified.\n18 tests passed, 0 failed.",
      openHref:
        "/tasks/00000000-0000-4000-8000-000000000101/artifacts/00000000-0000-4000-8000-000000000102",
    },
  };
}
