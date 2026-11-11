import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommentRail, Stack } from "@bakery/ui";
import { ArtifactDiscussionExample } from "../fixtures/artifact.tsx";
const meta = {
  title: "Bakery/Organisms/CommentRail",
  parameters: { catalogId: "ui.commentRail", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <CommentRail title="Comments">
        <ArtifactDiscussionExample />
      </CommentRail>
      <CommentRail title="Empty comments" state="empty">
        No comments yet.
      </CommentRail>
      <CommentRail title="Loading comments" state="loading">
        Loading comments…
      </CommentRail>
      <CommentRail title="Unavailable comments" state="error">
        Comments unavailable.
      </CommentRail>
    </Stack>
  ),
};
