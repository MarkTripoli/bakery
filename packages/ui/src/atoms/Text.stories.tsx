import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, Text } from "@bakery/ui";

const PSEUDO_COPY =
  "[!! Thiiis deterministic pseudo-locale sentence is deliberately expanded so the actual Text specimen exposes clipping, wrapping, and overflow defects. !!]";

const meta = {
  title: "Bakery/Atoms/Text",
  parameters: { catalogId: "ui.text", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: (_args, context) => (
    <Stack>
      <Text data-testid="text-specimen-copy" variant="body" state="default">
        {context.globals.locale === "pseudo"
          ? PSEUDO_COPY
          : "Quiet surfaces, clear actions, and room to focus."}
      </Text>
      <Text variant="caption">Caption supporting copy</Text>
      <Text variant="muted">Muted supporting copy</Text>
      <Text variant="hint">Hint copy beneath a field</Text>
      <Text variant="field-preview">Static search placeholder</Text>
      <Text variant="responsive-hint">Responsive capacity summary</Text>
      <Text state="truncated" truncate>
        Truncated content deliberately extends beyond the specimen width so the
        runtime verifies real clipping and an ellipsis instead of accepting the
        semantic state declaration alone repeated repeated repeated repeated
        repeated repeated repeated repeated.
      </Text>
      <Text state="long-content">{PSEUDO_COPY.repeat(8)}</Text>
      <Text
        lines={2}
        title="A clamped text keeps its first two lines and ends in an ellipsis, however long the copy runs, and the whole sentence stays available as the element's title for anyone who needs it."
        variant="muted"
      >
        A clamped text keeps its first two lines and ends in an ellipsis,
        however long the copy runs, and the whole sentence stays available as
        the element's title for anyone who needs it.
      </Text>
    </Stack>
  ),
};

const InkStory: StoryObj = {
  render: () => (
    <Stack>
      <Text variant="strong">northwind/payments</Text>
      <Text variant="hintInk">Waits for: contract</Text>
      <Text variant="captionInk">Plan · Waits for your approval</Text>
      <Text variant="positive">Committed</Text>
      <Text variant="error">Could not copy</Text>
    </Stack>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {InkStory.render?.(args, context)}
    </>
  ),
};
