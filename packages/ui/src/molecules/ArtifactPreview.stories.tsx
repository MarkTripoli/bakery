import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactPreview, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ArtifactPreview",
  parameters: { catalogId: "ui.artifactPreview", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <ArtifactPreview
        href="#plan"
        meta="Revision 3 · 2 comments · Updated just now"
        title="Repository onboarding · Plan"
      />
      <ArtifactPreview href="#log" title="build-output.log" />
    </Stack>
  ),
};
