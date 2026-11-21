import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccessOffer, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/AccessOffer",
  parameters: { catalogId: "ui.accessOffer", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const noop = () => undefined;
const detail =
  "They will be able to read and reply in this conversation. Nothing else in the task is shared. This is the only access a mention can give here.";
const many = [
  "Ana Ruiz",
  "Sam Patel",
  "Lee Wu",
  "Kim Oh",
  "Dana Lee",
  "Omar Haddad",
  "Rui Costa",
]
  .map((name) => ({ id: name, name, removeLabel: `Remove ${name}` }));

/**
 * The offer for one person, for several, for a long list that opens on
 * "Show all", and while the send is under way.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <div>
        <Text>One person</Text>
        <AccessOffer
          decline={{ label: "Don't mention Sam Patel", onDecline: noop }}
          detail={detail}
          question="Sam Patel can't see this conversation. Give them access?"
        />
      </div>
      <div>
        <Text>Three people</Text>
        <AccessOffer
          detail={detail}
          onRemove={noop}
          people={many.slice(0, 3)}
          question="3 people can't see this conversation. Give them access?"
        />
      </div>
      <div>
        <Text>Seven people</Text>
        <AccessOffer
          detail={detail}
          onRemove={noop}
          people={many}
          question="7 people can't see this conversation. Give them access?"
          showAllLabel="Show all 7"
        />
      </div>
      <div>
        <Text>Sending</Text>
        <AccessOffer
          decline={{ label: "Don't mention Sam Patel", onDecline: noop }}
          detail={detail}
          question="Sam Patel can't see this conversation. Give them access?"
          state="busy"
        />
      </div>
    </Stack>
  ),
};
