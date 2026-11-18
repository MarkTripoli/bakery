import { useState } from "react";
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

/**
 * Two cards that can be chosen and one that cannot, with counts of what was
 * called; packages/ui/tests/suggestion-card-selection.spec.ts drives it.
 */
function SelectionDemo() {
  const [selected, setSelected] = useState<string | null>(null);
  const [selects, setSelects] = useState(0);
  const [accepts, setAccepts] = useState(0);
  const card = (id: string, choosable: boolean) => (
    <SuggestionCard
      acceptLabel={`Accept ${id}`}
      checkAgainLabel="Check again"
      heading={`Suggestion ${id}`}
      message={undefined}
      onAccept={() => setAccepts((count) => count + 1)}
      onReject={() => {}}
      onSelect={choosable
        ? () => {
          setSelected(id);
          setSelects((count) => count + 1);
        }
        : undefined}
      origin="From “shorten the introduction”, asked by Ana Reyes · 5 min ago"
      rejectLabel={`Reject ${id}`}
      selected={selected === id}
      summary={`What ${id} does.`}
    />
  );
  return (
    <Stack data-testid="selection-demo" gap="standard">
      {card("one", true)}
      {card("two", true)}
      {card("fixed", false)}
      <Text data-testid="selection-counts">
        {`selects ${selects}, accepts ${accepts}`}
      </Text>
    </Stack>
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
      <SelectionDemo />
    </Stack>
  ),
};
