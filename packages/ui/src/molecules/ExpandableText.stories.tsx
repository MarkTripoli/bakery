import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExpandableText, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ExpandableText",
  parameters: { catalogId: "ui.expandableText", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const SHORT = "Purpose, Risk";
const CUT =
  "Purpose, Risk, Special things to note, Change outline, Decisions, Evidence, Verification, Rollback plan, Owner, Reviewer, Release note, Follow-up";
const UNBROKEN = "x".repeat(220);

function Specimen({ children }: { children: string }) {
  return (
    <ExpandableText
      hideControlLabel="Show less of this summary"
      hideLabel="Show less"
      showControlLabel="Show all of this summary"
      showLabel="Show all"
    >
      {children}
    </ExpandableText>
  );
}

/**
 * A short summary (no control), a cut one with its "Show all" control, and an
 * unbroken long value that wraps instead of widening its container.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Text>Short: it fits, so there is no control</Text>
      <Specimen>{SHORT}</Specimen>
      <Text>Cut: two lines, then Show all</Text>
      <Specimen>{CUT}</Specimen>
      <Text>One long unbroken value</Text>
      <Specimen>{UNBROKEN}</Specimen>
    </Stack>
  ),
};
