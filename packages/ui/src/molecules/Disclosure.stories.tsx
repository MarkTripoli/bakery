import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataText, Disclosure, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Disclosure",
  parameters: { catalogId: "ui.disclosure", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/** Closed (the default) and open, with the facts it holds under the control. */
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Text>Closed by default</Text>
      <Disclosure summary="Details">
        <DataText>00000000-0000-4000-8000-000000000020</DataText>
      </Disclosure>
      <Text>Row</Text>
      <Disclosure summary="SKILL.md" variant="row">
        <Text>Changed</Text>
      </Disclosure>
      <Text>Open</Text>
      <Disclosure defaultOpen summary="Details">
        <Stack gap="compact">
          <Text variant="caption">Run ID</Text>
          <DataText>00000000-0000-4000-8000-000000000020</DataText>
        </Stack>
      </Disclosure>
    </Stack>
  ),
};
