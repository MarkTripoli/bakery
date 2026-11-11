import type { Meta, StoryObj } from "@storybook/react-vite";
import { Heading, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Heading",
  parameters: { catalogId: "ui.heading", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Heading level="page">Workspace overview</Heading>
      <Heading level="page-plain">Plain page heading</Heading>
      <Heading level="section-plain">Plain section heading</Heading>
      <Heading level="subsection-compact" rank={2}>Object title</Heading>
      <Heading level="section">Your next idea starts here</Heading>
      <div style={{ inlineSize: "10rem", maxInlineSize: "100%" }}>
        <Heading
          data-semantic-interaction="wrapped"
          level="subsection"
        >
          A deliberately long subsection heading demonstrates wrapping behavior.
        </Heading>
      </div>
    </Stack>
  ),
};
