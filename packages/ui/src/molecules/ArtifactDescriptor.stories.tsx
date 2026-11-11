import { createTranslator } from "@bakery/i18n";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactDescriptor, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ArtifactDescriptor",
  parameters: {
    catalogId: "ui.artifactDescriptor",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const translate = createTranslator({ locale: "en", surface: "ui-story" });
    const labels = {
      artifactId: translate("tasks.artifact.id"),
      version: translate("tasks.artifact.version"),
      digest: translate("tasks.artifact.digest"),
      size: translate("tasks.artifact.size"),
      mediaType: translate("tasks.artifact.mediaType"),
      provenance: translate("tasks.artifact.provenance"),
      link: translate("tasks.artifact.open"),
    };
    return (
      <Stack>
        <Text>{translate("tasks.inbox.fixture")}</Text>
        <ArtifactDescriptor
          artifactId="artifact-42"
          version="3"
          digest="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          size="18 KB"
          mediaType="text/plain"
          provenance="Fixed-coding fixture"
          labels={labels}
          href="/artifact-fixture"
        />
        <ArtifactDescriptor
          artifactId="unknown-artifact"
          version={translate("tasks.artifact.unknown")}
          digest={translate("tasks.artifact.unknown")}
          size={translate("tasks.artifact.unknown")}
          mediaType="application/octet-stream"
          provenance={translate("tasks.artifact.unknown")}
          labels={labels}
          href="javascript:alert('unsafe')"
        />
      </Stack>
    );
  },
};
