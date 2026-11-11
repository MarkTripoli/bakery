import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConversationMessage, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/ConversationMessage",
  parameters: {
    catalogId: "ui.conversationMessage",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <ConversationMessage author="Alex" variant="person" state="sent">
        I reviewed the component baseline.
      </ConversationMessage>
      <ConversationMessage
        author="Bakery agent"
        variant="agent"
        state="sending"
      >
        The agent is preparing a response.
      </ConversationMessage>
      <ConversationMessage author="Bakery agent" variant="agent" state="failed">
        The response could not be delivered.
      </ConversationMessage>
      <ConversationMessage author="System" variant="system" state="edited">
        This system notice was edited.
      </ConversationMessage>
    </Stack>
  ),
};
