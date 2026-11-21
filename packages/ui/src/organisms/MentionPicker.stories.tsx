import type { Meta, StoryObj } from "@storybook/react-vite";
import { MentionPicker, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/MentionPicker",
  parameters: { catalogId: "ui.mentionPicker", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const noop = () => undefined;

/**
 * Every body the list can show: a quiet row, one that wears the access badge,
 * one muted and unchoosable, then loading, no one found, a failed read with its
 * retry, and the limit of twenty.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <div>
        <Text>Rows</Text>
        <MentionPicker
          activeId="ana"
          footer="You can give access when you send."
          label="People you can mention"
          listId="story-mention-rows"
          onChoose={noop}
          options={[
            { id: "ana", name: "Ana Ruiz", label: "Ana Ruiz", kind: "ready" },
            {
              id: "sam",
              name: "Sam Patel",
              label: "Sam Patel, no access yet",
              kind: "gains",
              note: "No access yet",
            },
            {
              id: "samir",
              name: "Samir Okafor",
              label: "Samir Okafor, you can't add them here",
              kind: "blocked",
              note: "You can't add them here",
            },
          ]}
        />
      </div>
      <div>
        <Text>Loading</Text>
        <MentionPicker
          label="People you can mention"
          listId="story-mention-loading"
          onChoose={noop}
          options={[]}
          state="loading"
        />
      </div>
      <div>
        <Text>No one found</Text>
        <MentionPicker
          label="People you can mention"
          listId="story-mention-empty"
          message="No one found in Fixture Org."
          onChoose={noop}
          options={[]}
          state="empty"
        />
      </div>
      <div>
        <Text>Could not be read</Text>
        <MentionPicker
          label="People you can mention"
          listId="story-mention-error"
          message="People could not be loaded."
          onChoose={noop}
          options={[]}
          retry={{ label: "Try again", onRetry: noop }}
          state="error"
        />
      </div>
      <div>
        <Text>Limit reached</Text>
        <MentionPicker
          label="People you can mention"
          listId="story-mention-limit"
          message="You can mention up to 20 people in one message."
          onChoose={noop}
          options={[]}
          state="limit"
        />
      </div>
    </Stack>
  ),
};
