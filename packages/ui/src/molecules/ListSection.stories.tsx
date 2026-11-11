import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, ListSection, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ListSection",
  parameters: { catalogId: "ui.listSection", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <>
      <ListSection
        actions={<Button variant="outline">Register repository</Button>}
        description="Register repositories and review their profiles."
        title="Repositories"
      >
        <Text>northwind/payments</Text>
      </ListSection>
      <ListSection title="Applications" variant="list">
        <Text>Northwind storefront</Text>
      </ListSection>
    </>
  ),
};
