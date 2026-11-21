import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, FormWithSummary, Heading, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/FormWithSummary",
  parameters: {
    catalogId: "template.formWithSummary",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

/**
 * The template with its buttons, and without: a page with nothing to end draws
 * no buttons row and no rule under the form.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
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
      <FormWithSummary
        aside={
          <>
            <Heading level="section">What the restore did</Heading>
            <Text>Restored from last night's backup.</Text>
          </>
        }
      >
        <Heading level="section">Steps</Heading>
        <Text>Take them in order.</Text>
      </FormWithSummary>
    </Stack>
  ),
};
