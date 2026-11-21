import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AccessOffer,
  Badge,
  Button,
  IconGlyph,
  MentionPicker,
  MessageComposer,
  SegmentedControl,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/MessageComposer",
  parameters: { catalogId: "ui.messageComposer", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const render = (state: "default" | "sending" | "disabled") => (
  <MessageComposer
    key={state}
    state={state}
    aria-label={`Message this task (${state})`}
    field={
      <textarea
        aria-label="Message this task"
        placeholder="Message this task…"
        rows={1}
      />
    }
    modes={
      <SegmentedControl
        aria-label="Message type"
        name={`composer-mode-${state}`}
        onChange={() => undefined}
        options={[
          { value: "discuss", label: "Discuss" },
          { value: "ask", label: "Ask agent" },
        ]}
        value="ask"
        variant="inline"
      />
    }
    hint="Ask agent starts an agent turn that reads this conversation."
    send={
      <Button type="submit">
        <IconGlyph name="arrow" size="small" />
        Send
      </Button>
    }
    footnote="Shared conversation. Messages are visible to this task's participants."
  />
);

/** The mention row between the field and the toolbar, and the picker hung above the box. */
const WithMentions: StoryObj = {
  render: () => (
    <MessageComposer
      aria-label="Message this task (with mentions)"
      field={
        <textarea
          aria-label="Message this task"
          defaultValue="Thanks @Sam Patel, can you check this?"
          rows={1}
        />
      }
      mentions={
        <>
          <span>
            <Badge tone="warning">Sam Patel · no access yet</Badge>
          </span>
          <AccessOffer
            decline={{
              label: "Don't mention Sam Patel",
              onDecline: () => undefined,
            }}
            detail="They will be able to read and reply in this conversation. Nothing else in the task is shared. This is the only access a mention can give here."
            question="Sam Patel can't see this conversation. Give them access?"
          />
        </>
      }
      picker={
        <MentionPicker
          label="People you can mention"
          listId="composer-mention-list"
          onChoose={() => undefined}
          options={[
            { id: "ana", name: "Ana Ruiz", label: "Ana Ruiz", kind: "ready" },
          ]}
        />
      }
      send={
        <Button type="submit">
          <IconGlyph name="arrow" size="small" />
          Send
        </Button>
      }
    />
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {render("default")}
      {render("sending")}
      {render("disabled")}
      {WithMentions.render?.(args, context)}
    </>
  ),
};
