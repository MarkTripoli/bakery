import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertBanner, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/AlertBanner",
  parameters: { catalogId: "ui.alertBanner", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [visible, setVisible] = useState(true);
    return (
      <Stack>
        <AlertBanner
          onDismiss={() => setVisible(false)}
          state={visible ? "default" : "dismissed"}
          tone="information"
        >
          A worker is ready.
        </AlertBanner>
        <AlertBanner tone="warning">
          One worker needs your attention.
        </AlertBanner>
        <AlertBanner tone="error">A worker stopped unexpectedly.</AlertBanner>
        <AlertBanner state="recovering">
          Reconnecting to the worker.
        </AlertBanner>
      </Stack>
    );
  },
};
