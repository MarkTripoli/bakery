import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ArtifactLayout,
  ArtifactViewer,
  Button,
  CommentRail,
  ErrorState,
  VersionPicker,
} from "@bakery/ui";
import {
  ArtifactDiscussionExample,
  artifactMarkdown,
} from "../fixtures/artifact.tsx";
const meta = {
  title: "Bakery/Templates/ArtifactLayout",
  parameters: { catalogId: "ui.artifactLayout", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => (
    <>
      <ArtifactLayout
        notices={[{
          id: "stale",
          title: "A newer revision is available",
          description:
            "Your draft remains attached to this immutable revision.",
          tone: "information",
          actions: <Button variant="outline">Open newer revision</Button>,
        }]}
        title="Implementation notes"
        description="Revision 3 · Markdown · 8.4 KB"
        breadcrumb="Work / Artifact delivery / Artifacts"
        versions={
          <VersionPicker
            label="Version"
            value="3"
            versions={[{ id: "3", label: "Revision 3 · latest" }]}
            onChange={() => {}}
          />
        }
        actions={
          <>
            <Button variant="secondary">Download</Button>
            <Button variant="secondary">Pin artifact</Button>
          </>
        }
        comments={
          <CommentRail title="Comments">
            <ArtifactDiscussionExample />
          </CommentRail>
        }
        evidence={
          <>
            <h2>Evidence context</h2>
            <span>Task 130 / Run 42 / Step 3</span>
            <pre>base 8ac02e1 → head 5d138ac&#10;sha256 83b1f920…4e8d09a1</pre>
          </>
        }
      >
        <ArtifactViewer
          label="Preview · Markdown"
          content={{ kind: "markdown", text: artifactMarkdown }}
        />
      </ArtifactLayout>
      <ArtifactLayout
        title="Artifact access"
        description="This artifact is unavailable."
        variant="unavailable"
        unavailableLabel="Access denied"
      >
        <ErrorState
          title="Artifact access denied"
          description="Request access from an organization administrator."
          action={<Button variant="outline">Back to task</Button>}
        />
      </ArtifactLayout>
    </>
  ),
};
