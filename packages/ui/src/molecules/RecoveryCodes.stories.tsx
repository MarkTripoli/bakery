import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { RecoveryCodes, Stack, Text } from "@bakery/ui";

const PSEUDO_COPY =
  "[!! Thiiis deterministic pseudo-locale sentence is deliberately expanded so the actual RecoveryCodes specimen exposes clipping, wrapping, and overflow defects. !!]";

const meta = {
  title: "Bakery/Molecules/RecoveryCodes",
  parameters: { catalogId: "ui.recoveryCodes", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const labels = {
  acknowledge: "I've saved these codes",
  copied: "Copied",
  copy: "Copy codes",
  download: "Download codes",
};

const codes = [
  "4F2K-9XQZ",
  "7B3M-1LPT",
  "2W8N-5RVC",
  "9D4J-3HYS",
  "6T1F-8GKX",
];

const longCodes = [
  "4f2k9xqz7b3m1lpt2w8n5rvc9d4j3hys",
  "6t1f8gkx0aeu2wmn9plz3rvq7bxs1fhy",
];

function DefaultDemo() {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <RecoveryCodes
      acknowledged={acknowledged}
      codes={codes}
      fileName="bakery-recovery-codes.txt"
      labels={labels}
      onAcknowledge={setAcknowledged}
    />
  );
}

function CopiedDemo() {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div data-testid="copied-demo">
      <RecoveryCodes
        acknowledged={acknowledged}
        codes={codes}
        fileName="bakery-recovery-codes.txt"
        labels={labels}
        onAcknowledge={setAcknowledged}
      />
    </div>
  );
}

function AcknowledgedDemo() {
  const [acknowledged, setAcknowledged] = useState(true);
  return (
    <RecoveryCodes
      acknowledged={acknowledged}
      codes={codes}
      fileName="bakery-recovery-codes.txt"
      labels={labels}
      onAcknowledge={setAcknowledged}
    />
  );
}

function LongCopyDemo() {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <RecoveryCodes
      acknowledged={acknowledged}
      codes={longCodes}
      fileName="bakery-recovery-codes.txt"
      labels={labels}
      onAcknowledge={setAcknowledged}
    />
  );
}

export const Contract: StoryObj = {
  render: (_args, context) => (
    <Stack>
      <Text data-testid="text-specimen-copy" variant="caption">
        {context.globals.locale === "pseudo"
          ? PSEUDO_COPY
          : "Default · Copied · Acknowledged · Long copy"}
      </Text>
      <DefaultDemo />
      <CopiedDemo />
      <AcknowledgedDemo />
      <LongCopyDemo />
    </Stack>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    navigator.clipboard.writeText = () => Promise.resolve();
    const wrapper = canvas.getByTestId("copied-demo");
    const demo = within(wrapper);
    await userEvent.click(demo.getByRole("button", { name: labels.copy }));
    await expect(demo.getByRole("status")).toHaveTextContent(labels.copied);
    await expect(
      wrapper.querySelector('[data-ui-component="recoveryCodes"]') as Element,
    ).toHaveAttribute("data-state", "copied");
  },
};
