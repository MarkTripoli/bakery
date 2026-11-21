import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, FormWithSummary, Heading, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/FormWithSummary",
  parameters: {
    catalogId: "template.formWithSummary",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <FormWithSummary
      aside={
        <>
          <Heading level="section">What this will do</Heading>
          <Text>Work through ready issues, one at a time.</Text>
        </>
      }
      actions={
        <>
          <Button variant="secondary">Cancel</Button>
          <Button variant="primary">Start</Button>
        </>
      }
    >
      <Heading level="section">Limits</Heading>
      <Text>Stop when any of these is reached.</Text>
    </FormWithSummary>
  ),
};
