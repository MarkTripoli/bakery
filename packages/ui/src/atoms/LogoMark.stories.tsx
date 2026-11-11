import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inline, LogoMark } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/LogoMark",
  parameters: { catalogId: "ui.logoMark", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Inline>
      <LogoMark variant="compact" />
      <LogoMark variant="rail" />
      <LogoMark variant="wordmark" />
      <LogoMark variant="wordmark" appearance="inverse" />
    </Inline>
  ),
};
