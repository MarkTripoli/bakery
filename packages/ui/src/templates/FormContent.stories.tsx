import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, FormContent, Heading, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/FormContent",
  parameters: {
    catalogId: "template.formContent",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <FormContent>
      <Heading level="section">Sign out other sessions</Heading>
      <Text>
        This signs out every other browser and device. You stay signed in here.
      </Text>
      <Button variant="destructive">Sign out other sessions</Button>
    </FormContent>
  ),
};
