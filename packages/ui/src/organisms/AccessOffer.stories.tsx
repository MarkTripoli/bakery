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
 * leave someone out), while the send is under way, for a writer who may not
 * share (who can be asked), and after the send (with its Undo).
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
        <Text>Writer may not share</Text>
        <AccessOffer
          actions={[
            { label: "Ask Dana Lee", onClick: noop },
            { label: "Ask Omar Haddad", onClick: noop },
          ]}
          detail="Dana Lee or Omar Haddad can. Ask one of them here, or send without the mention."
          question="Sam Patel can't see this conversation, and you can't give access to it."
        />
      </div>
      <div>
        <Text>After the send</Text>
        <AccessOffer
          actions={[{ label: "Undo access", onClick: noop }]}
          question="Sent. Sam Patel can now read and reply in this conversation."
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
