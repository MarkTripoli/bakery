import { type ReactNode, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactPane, type ArtifactPaneState, Stack, Text } from "@bakery/ui";
import {
  artifactDescriptor,
  artifactPaneLabels,
  briefText,
  storyTranslator,
} from "../fixtures/task-session.ts";

const meta = {
  title: "Bakery/Organisms/ArtifactPane",
  parameters: { catalogId: "ui.artifactPane", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

function Pane(
  { caseName, state, mediaType, text, globals, missing }: {
    caseName: string;
    state: ArtifactPaneState;
    mediaType?: string;
    text?: string;
    globals: Record<string, unknown>;
    missing?: boolean;
  },
) {
  const t = storyTranslator(globals);
  const [version, setVersion] = useState("2");
  return (
    <ArtifactPane
      descriptor={missing ? undefined : artifactDescriptor(t, mediaType)}
      downloadHref="/artifact-fixture/download"
      label={`${t("tasks.artifactPane.label")} (${caseName})`}
      labels={{
        ...artifactPaneLabels(t),
        preview: `${t("tasks.artifactPane.preview")} (${caseName})`,
      }}
      meta={t("tasks.artifactPane.meta", {
        version,
        mediaType: mediaType ?? "text/markdown",
      })}
      onVersionChange={setVersion}
      openHref="/artifact-fixture"
      previewText={text}
      state={state}
      title={t("tasks.artifactPane.title")}
      version={version}
      versions={[
        { value: "2", label: t("tasks.artifactPane.version", { version: 2 }) },
        { value: "1", label: t("tasks.artifactPane.version", { version: 1 }) },
      ]}
    />
  );
}

export const Contract: StoryObj = {
  render: (_args, context) => {
    const globals = context.globals as Record<string, unknown>;
    const pane = (
      caseName: string,
      state: ArtifactPaneState,
      options: { mediaType?: string; text?: string; missing?: boolean } = {},
    ): ReactNode => (
      <Pane
        caseName={caseName}
        globals={globals}
        key={caseName}
        state={state}
        {...options}
      />
    );
    return (
      <Stack>
        <Text data-testid="text-specimen-copy" variant="caption">
          {storyTranslator(globals)("tasks.artifactPane.truncated")}
          {storyTranslator(globals)("tasks.artifactPane.unavailable")}
        </Text>
        {pane("ready", "ready", { text: briefText })}
        {pane("partial", "partial", { text: briefText })}
        {pane("unavailable", "unavailable", {
          mediaType: "application/octet-stream",
        })}
        {pane("loading", "loading", { missing: true })}
        {pane("empty", "empty", { missing: true })}
        {pane("error", "error", { missing: true })}
        {pane("forbidden", "forbidden", { missing: true })}
        {pane("offline", "offline", { text: briefText })}
        {pane("reconnecting", "reconnecting", { text: briefText })}
        {pane("worst case", "ready", {
          text: Array.from({ length: 80 }, (_, line) =>
            `line ${line}: ${"unbroken".repeat(12)}`).join("\n"),
        })}
      </Stack>
    );
  },
};
