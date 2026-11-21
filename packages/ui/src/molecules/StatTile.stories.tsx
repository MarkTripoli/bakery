import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatTile } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StatTile",
  parameters: { catalogId: "ui.statTile", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 32, maxInlineSize: 720 }}
    >
      <StatTile
        detail="Backed by the provider's own receipt."
        help={{
          text: "Only usage a provider's receipt confirms.",
          label: "About confirmed cost",
        }}
        label="Confirmed cost"
        value="$12.40"
      />
      <StatTile
        detail="3 records. A machine reported the cost; no receipt matches yet."
        help={{
          text: "Reported by a worker, not yet confirmed.",
          label: "About reported cost",
        }}
        label="Reported, not confirmed"
        value="$4.10"
      />
      {/* A figure that opens its records: the number is the button. */}
      <StatTile
        action={{
          label: "Pull requests merged, 42",
          onSelect: () => undefined,
          selected: true,
        }}
        detail="Counted by when each was merged."
        label="Pull requests merged"
        value="42"
      />
      {/* The case the molecule exists for: an unknown is a word, never a 0. */}
      <StatTile
        detail="No cost was reported. Unknown is not zero."
        label="Cost unknown"
        value="7 records"
      />
    </div>
  ),
};
