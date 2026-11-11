import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactTombstone, Stack } from "@bakery/ui";
const meta = {
  title: "Bakery/Molecules/ArtifactTombstone",
  parameters: {
    catalogId: "ui.artifactTombstone",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <ArtifactTombstone
        title="Content expired"
        description="The retention period ended. Provenance and comments remain available."
        metadata="Revision 3 · sha256 83b1f920"
        state="expired"
      />
      <ArtifactTombstone
        title="Content deleted"
        description="This content was deleted. Provenance and comments remain available."
        metadata="Revision 2 · Run 42"
        state="deleted"
      />
      <ArtifactTombstone
        title="Content expired"
        description="Provenance remains available inside the preview."
        state="expired"
        variant="embedded"
      />
    </Stack>
  ),
};
