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
/**
 * The offer for one person, for several people (one caption says how to
 * leave someone out), and while the send is under way.
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
          caption="To leave someone out, remove their name above."
          detail={detail}
          question="3 people can't see this conversation. Give them access?"
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
