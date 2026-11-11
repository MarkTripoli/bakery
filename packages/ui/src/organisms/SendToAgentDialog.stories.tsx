import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, SendToAgentDialog, Stack } from "@bakery/ui";
const meta = {
  title: "Bakery/Organisms/SendToAgentDialog",
  parameters: {
    catalogId: "ui.sendToAgentDialog",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<"open" | "submitting" | "error">("open");
    return (
      <Stack>
        <Button
          data-semantic-state-trigger="open"
          onClick={() => {
            setState("open");
            setOpen(true);
          }}
        >
          Send to agent
        </Button>
        {(["submitting", "error"] as const).map((nextState) => (
          <Button
            key={nextState}
            data-semantic-state-trigger={nextState}
            onClick={() => {
              setState(nextState);
              setOpen(true);
            }}
          >
            Show {nextState} dialog
          </Button>
        ))}
        <SendToAgentDialog
          title="Send to agent"
          open={open}
          onOpenChange={setOpen}
          dismissLabel="Close send to agent"
          state={state}
          description="Send this discussion and immutable revision to the task agent."
          actions={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => setState("submitting")}
                disabled={state === "submitting"}
              >
                Send instruction
              </Button>
            </>
          }
        >
          <textarea
            aria-label="Instruction"
            defaultValue="Keep this revision pinned for the audit."
          />
          {state === "error"
            ? <p role="alert">Instruction could not be sent.</p>
            : null}
          <Button variant="quiet" onClick={() => setState("error")}>
            Show failed submission
          </Button>
        </SendToAgentDialog>
      </Stack>
    );
  },
};
