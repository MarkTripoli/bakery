import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, ThemeChoice } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ThemeChoice",
  parameters: { catalogId: "ui.themeChoice", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <fieldset style={{ border: 0, margin: 0, minInlineSize: 0, padding: 0 }}>
        <legend>Color theme</legend>
        <Stack>
          <ThemeChoice
            checked={false}
            name="theme"
            onChange={() => {}}
            theme="light"
            value="light"
          >
            Light
          </ThemeChoice>
          <ThemeChoice
            checked={false}
            name="theme"
            onChange={() => {}}
            theme="dark"
            value="dark"
          >
            Dark
          </ThemeChoice>
          <ThemeChoice
            checked
            name="theme"
            onChange={() => {}}
            theme="system"
            value="system"
          >
            System
          </ThemeChoice>
          <ThemeChoice
            checked={false}
            disabled
            name="theme"
            onChange={() => {}}
            theme="light"
            value="disabled"
          >
            Light (unavailable)
          </ThemeChoice>
        </Stack>
      </fieldset>
    </Stack>
  ),
};
