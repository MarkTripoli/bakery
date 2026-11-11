import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  IconGlyph,
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

export const Contract: StoryObj = {
  render: () => (
    <>
      {render("default")}
      {render("sending")}
      {render("disabled")}
    </>
  ),
};
