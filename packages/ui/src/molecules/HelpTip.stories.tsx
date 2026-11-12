import type { Meta, StoryObj } from "@storybook/react-vite";
import { HelpTip, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/HelpTip",
  parameters: { catalogId: "ui.helpTip", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * Closed, open (hover) and focused. Each tip sits at the start of its row with
 * its label above, so its text opens inside the story at every width, the way
 * the Popover stories do.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Text>Enforcement</Text>
      <HelpTip label="About enforcement">
        Require blocks delivery until the check passes. Warn reports problems
        without blocking. Guide only gives instructions. Off means the rule is
        not applied.
      </HelpTip>
      <Text>Source</Text>
      <HelpTip data-semantic-interaction="open" label="About source">
        Who decides this rule's setting. Locked rules cannot be changed for this
        repository. Organization defaults can.
      </HelpTip>
      <Text>Rules fingerprint</Text>
      <HelpTip
        data-semantic-interaction="focus"
        label="About the rules fingerprint"
      >
        Identifies the exact rules in force. Each run records the same value, so
        you can tell which rules it used.
      </HelpTip>
      <Text>Long help</Text>
      <HelpTip label="About a long explanation">
        {"This is a long explanation that does not fit on a small screen in a few lines. It keeps going so that the panel reaches half the height of the screen and has to scroll inside itself. "
          .repeat(
            6,
          )}
      </HelpTip>
    </Stack>
  ),
};
