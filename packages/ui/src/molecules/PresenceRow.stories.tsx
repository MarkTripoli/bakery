import type { Meta, StoryObj } from "@storybook/react-vite";
import { PresenceRow, type PresenceSaveState, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/PresenceRow",
  parameters: { catalogId: "ui.presenceRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const PEOPLE = [
  { id: "a", name: "Ana Reyes", kind: "person", color: 1 },
  { id: "b", name: "Ben Okafor", kind: "person", color: 2 },
  { id: "c", name: "Coding agent", kind: "agent", color: 3 },
] as const;
const MANY = [
  ...PEOPLE,
  { id: "d", name: "Dee Park", kind: "person", color: 4 },
  { id: "e", name: "Eli Stone", kind: "person", color: 5 },
  { id: "f", name: "Fay Lund", kind: "person", color: 6 },
  { id: "g", name: "Gus Held", kind: "person", color: 1 },
] as const;

const SAVE: Record<PresenceSaveState, string> = {
  saved: "All changes saved",
  sending: "Saving…",
  offline: "Not saved. Reconnecting…",
  "catching-up": "Catching up…",
  refused: "Some changes not saved",
};

/** Every save state, then a crowd that is counted, then one unbroken long name. */
export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      {(Object.keys(SAVE) as PresenceSaveState[]).map((state) => (
        <div key={state}>
          <Text>{state}</Text>
          <PresenceRow
            aria-label="People here"
            overflowLabel="2 more people"
            people={PEOPLE}
            saveLabel={SAVE[state]}
            saveState={state}
            status="Ana Reyes is typing · Ben Okafor is viewing"
          />
        </div>
      ))}
      <div>
        <Text>Typing, viewing and away</Text>
        <PresenceRow
          aria-label="People here"
          overflowLabel="2 more people"
          people={PEOPLE}
          saveLabel={SAVE.saved}
          saveState="saved"
          status="Ana Reyes is typing · Ben Okafor is viewing · Dana Park is away"
        />
      </div>
      <div>
        <Text>More people than avatars: the rest are counted</Text>
        <PresenceRow
          aria-label="People here"
          overflowLabel="2 more people"
          people={MANY}
          saveLabel={SAVE.saved}
          saveState="saved"
          status="Ana Reyes is typing · 6 others are viewing"
        />
      </div>
      <div>
        <Text>A long name</Text>
        <PresenceRow
          aria-label="People here"
          overflowLabel="1 more person"
          people={PEOPLE}
          saveLabel={SAVE.saved}
          saveState="saved"
          status={"Alexandria-Wilhelmina-Featherstonehaugh-Ravenscroft".repeat(
            2,
          ) + " is typing"}
        />
      </div>
    </Stack>
  ),
};
