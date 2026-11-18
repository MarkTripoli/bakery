import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Stack,
  SuggestionCard,
  type SuggestionCardState,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/SuggestionCard",
  parameters: { catalogId: "ui.suggestionCard", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const MESSAGE = {
  default: undefined,
  working: undefined,
  outdated: "This no longer fits the text. Ask the agent again.",
  unknown: "Could not tell whether this was applied.",
} as const;

function Card(
  { selected = false, state }: {
    selected?: boolean;
    state: SuggestionCardState;
  },
) {
  return (
    <SuggestionCard
      acceptLabel="Accept"
      checkAgainLabel="Check again"
      heading="Suggested by the agent"
      message={MESSAGE[state]}
      onAccept={() => {}}
      onCheckAgain={() => {}}
      onReject={() => {}}
      onSelect={() => {}}
      origin="From “shorten the introduction”, asked by Ana Reyes · 5 min ago"
      rejectLabel="Reject"
      selected={selected}
      state={state}
      summary="Replaces the first paragraph with a two-sentence summary."
    />
  );
}

/** Every state: it can be accepted, no longer fits, is unknown, or is in flight; then the chosen card. */
export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      {(["default", "outdated", "unknown", "working"] as const).map((
        state,
      ) => (
        <div key={state}>
          <Text>{state}</Text>
          <Card state={state} />
        </div>
      ))}
      <div>
        <Text>selected: the card whose text is in view</Text>
        <Card selected state="default" />
      </div>
    </Stack>
  ),
};
