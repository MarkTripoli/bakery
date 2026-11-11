import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, RunOutputPanel, type RunOutputState, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/RunOutputPanel",
  parameters: { catalogId: "ui.runOutputPanel", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const states: readonly { state: RunOutputState; label: string }[] = [
  { state: "loading", label: "Loading output" },
  { state: "live", label: "Live" },
  { state: "reconnecting", label: "Reconnecting from the saved cursor" },
  { state: "paused", label: "Output paused" },
  { state: "error", label: "Output unavailable" },
  { state: "complete", label: "Process exited · code 0" },
  {
    state: "reset",
    label: "Live replay expired. Open archived output to continue.",
  },
  { state: "truncated", label: "Output truncated at the capture limit." },
  {
    state: "interrupted",
    label: "Capture interrupted. Previously saved output remains available.",
  },
];

export const Contract: StoryObj = {
  render: () => {
    const [captureLimitReached, setCaptureLimitReached] = useState(false);
    return (
      <Stack>
        {states.map(({ state, label }) => (
          <RunOutputPanel
            key={state}
            title={label}
            state={state === "truncated" && !captureLimitReached
              ? "live"
              : state}
            statusLabel={state === "truncated" && !captureLimitReached
              ? "Live"
              : label}
            notice={state === "truncated" && captureLimitReached
              ? label
              : undefined}
            captureLabel="stdout + stderr · cursor 128"
            savedLabel="Saved through sequence 128"
            entries={Array.from({ length: 24 }, (_, index) => ({
              id: `${state}-${index}`,
              message: index === 0
                ? "<img src=x onerror=alert(1)>"
                : `output sequence ${index + 1}: artifact retention passed`,
            }))}
            archiveLinks={[
              {
                id: "segment-1",
                href: "#archive",
                label: "Open archived output",
              },
            ]}
            downloadLink={{ href: "#download", label: "Download output" }}
            archiveActions={state === "truncated"
              ? (
                <Button
                  variant="outline"
                  data-semantic-state-trigger="truncated"
                  disabled={captureLimitReached}
                  onClick={() => setCaptureLimitReached(true)}
                >
                  Simulate capture limit
                </Button>
              )
              : undefined}
            latestLabel="Jump to latest"
          />
        ))}
      </Stack>
    );
  },
};
