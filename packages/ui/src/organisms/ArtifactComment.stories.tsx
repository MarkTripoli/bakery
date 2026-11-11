import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactComment, Button, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/ArtifactComment",
  parameters: { catalogId: "ui.artifactComment", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [visible, setVisible] = useState(true);
    return (
      <Stack>
        <ArtifactComment
          author="Sam"
          location="Implementation notes"
          resolved={!visible}
          state={visible ? "open" : "resolved"}
          variant="thread"
          actions={
            <Button variant="quiet" onClick={() => setVisible(!visible)}>
              {visible ? "Resolve" : "Reopen"}
            </Button>
          }
        >
          Keep this control usable on narrow screens.
        </ArtifactComment>
        <ArtifactComment author="Riley" state="outdated" variant="reply">
          This reply refers to an older artifact revision.
        </ArtifactComment>
        <ArtifactComment author="Morgan" state="resolved" variant="reply">
          This thread has been resolved.
        </ArtifactComment>
      </Stack>
    );
  },
};
