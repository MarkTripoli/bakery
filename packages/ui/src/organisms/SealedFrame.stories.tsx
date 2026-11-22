import type { Meta, StoryObj } from "@storybook/react-vite";
import { SealedFrame, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/SealedFrame",
  parameters: { catalogId: "ui.sealedFrame", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/** An inline page of the plugin's own, so the story makes no network request. */
const page = "data:text/html;charset=utf-8," +
  encodeURIComponent(
    "<!doctype html><title>Release checklist</title><body style='font-family:sans-serif;margin:16px'><main><h1>Release checklist</h1><p>This page runs sealed off.</p></main></body>",
  );

/** The frame at the size it fills, with its accessible name. */
export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <Text>A plugin page, sealed</Text>
      <div style={{ blockSize: "70dvh", inlineSize: "100%" }}>
        <SealedFrame
          src={page}
          title="Release checklist, provided by the plugin Release helper"
        />
      </div>
    </Stack>
  ),
};
