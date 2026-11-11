import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Link, RunArtifactSummary, Stack } from "@bakery/ui";
const meta = {
  title: "Bakery/Organisms/RunArtifactSummary",
  parameters: {
    catalogId: "ui.runArtifactSummary",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <RunArtifactSummary
        title="Artifacts"
        name="delivery-notes.md"
        revision="r3"
        size="12.8 KiB"
        detail="Immutable revision · sha256 83b1f920…4e8d09a1"
        actions={
          <>
            <Link variant="button" href="#artifact">Open artifact</Link>
            <Button variant="outline">Download</Button>
          </>
        }
      />
      <RunArtifactSummary
        title="Artifacts"
        name="Unavailable version"
        revision="Unknown"
        size="Unknown"
        detail="Unknown"
        state="unknown"
        actions={<Link variant="button" href="#artifact">Open artifact</Link>}
      />
    </Stack>
  ),
};
