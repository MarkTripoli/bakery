import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, Toast } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Toast",
  parameters: { catalogId: "ui.toast", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [visible, setVisible] = useState(true);
    return (
      <Stack>
        <Toast
          onDismiss={() => setVisible(false)}
          state={visible ? "entering" : "dismissed"}
          tone="success"
        >
          Task created.
        </Toast>
        <Toast tone="information">Workspace synchronized.</Toast>
        <Toast tone="warning">The preview uses an older revision.</Toast>
        <Toast tone="error">The task could not be started.</Toast>
      </Stack>
    );
  },
};
