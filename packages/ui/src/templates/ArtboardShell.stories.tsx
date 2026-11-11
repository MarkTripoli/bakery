import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtboardShell, Heading, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/ArtboardShell",
  parameters: {
    catalogId: "template.artboardShell",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <ArtboardShell
      applicationRail={<Text>Static rail artwork</Text>}
      header={<Text>Artboard header</Text>}
    >
      <Heading level="page">Synthetic artboard</Heading>
      <Text>Fixture content scored against its Paper frame.</Text>
    </ArtboardShell>
  ),
};
