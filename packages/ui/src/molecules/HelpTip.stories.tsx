import type { Meta, StoryObj } from "@storybook/react-vite";
import { HelpTip, Inline, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/HelpTip",
  parameters: { catalogId: "ui.helpTip", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/** Closed, open (hover) and focused, each after the label it explains. */
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Inline gap="compact">
        <Text>Enforcement</Text>
        <HelpTip label="About enforcement">
          Require blocks delivery until the check passes. Warn reports problems
          without blocking. Guide only gives instructions. Off means the rule is
          not applied.
        </HelpTip>
      </Inline>
      <Inline gap="compact">
        <Text>Source</Text>
        <HelpTip data-semantic-interaction="open" label="About source">
          Who decides this rule's setting. Locked rules cannot be changed for
          this repository. Organization defaults can.
        </HelpTip>
      </Inline>
      <Inline gap="compact">
        <Text>Rules fingerprint</Text>
        <HelpTip
          data-semantic-interaction="focus"
          label="About the rules fingerprint"
        >
          Identifies the exact rules in force. Each run records the same value,
          so you can tell which rules it used.
        </HelpTip>
      </Inline>
    </Stack>
  ),
};
