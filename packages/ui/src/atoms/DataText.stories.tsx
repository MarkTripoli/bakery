import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataText, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/DataText",
  parameters: { catalogId: "ui.dataText", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => (
    <Stack>
      <DataText variant="identifier">run_01HV8E7K4P</DataText>
      <DataText variant="timestamp">2026-09-12T12:00:00Z</DataText>
      <DataText
        data-semantic-interaction="wrapped"
        variant="metric"
        state="wrapped"
      >
        runtime_metric_with_a_deliberately_long_identifier_that_wraps_across_multiple_lines_when_the_catalog_runs_its_sheet_and_desktop_contracts_without_relying_on_a_declared_state_alone
      </DataText>
      <DataText state="truncated" truncate>
        machine_value_that_deliberately_extends_beyond_the_specimen_width_to_prove_real_truncation_instead_of_accepting_a_state_marker_repeated_repeated_repeated_repeated_repeated_repeated_repeated_repeated
      </DataText>
    </Stack>
  ),
};

const CodeStory: StoryObj = {
  render: () => <DataText variant="code">webhook-schema</DataText>,
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {CodeStory.render?.(args, context)}
    </>
  ),
};
