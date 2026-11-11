import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactDiscussion, Stack } from "@bakery/ui";
import { ArtifactDiscussionExample } from "../fixtures/artifact.tsx";
const meta = {
  title: "Bakery/Organisms/ArtifactDiscussion",
  parameters: {
    catalogId: "ui.artifactDiscussion",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <ArtifactDiscussionExample />
      {(["resolved", "outdated", "deleted"] as const).map((state) => (
        <ArtifactDiscussion
          key={state}
          title="Discussion"
          location="Revision 2 / Retention"
          author="Alex Lee"
          initials="AL"
          timestamp="Yesterday"
          body={state === "deleted"
            ? "This comment was deleted."
            : "Keep the audit evidence."}
          notice={state}
          state={state}
        />
      ))}
    </Stack>
  ),
};
