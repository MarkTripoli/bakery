import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, CommentSheet, SendToAgentDialog } from "@bakery/ui";
import { ArtifactDiscussionExample } from "../fixtures/artifact.tsx";
const meta = {
  title: "Bakery/Organisms/CommentSheet",
  parameters: { catalogId: "ui.commentSheet", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(false);
    const [agentOpen, setAgentOpen] = useState(false);
    return (
      <>
        <Button
          data-semantic-state-trigger="open"
          onClick={() => setOpen(true)}
        >
          Open comments
        </Button>
        <CommentSheet
          title="Comments"
          open={open}
          onOpenChange={setOpen}
          dismissLabel="Close comments"
        >
          <ArtifactDiscussionExample />
          <Button onClick={() => setAgentOpen(true)}>Send to agent</Button>
          <SendToAgentDialog
            title="Send discussion to agent"
            description="Send the immutable discussion context."
            open={agentOpen}
            onOpenChange={setAgentOpen}
            dismissLabel="Close agent dialog"
            actions={
              <Button
                variant="secondary"
                onClick={() => setAgentOpen(false)}
              >
                Cancel agent request
              </Button>
            }
          >
            <p>Revision 3 / Retention</p>
          </SendToAgentDialog>
        </CommentSheet>
      </>
    );
  },
};
