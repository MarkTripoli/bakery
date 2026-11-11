import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SegmentedControl, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/SegmentedControl",
  parameters: { catalogId: "ui.segmentedControl", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => {
    const name = useId();
    const [value, setValue] = useState("ready");
    const options = [{ value: "ready", label: "Ready" }, {
      value: "running",
      label: "Running",
    }];
    return (
      <Stack>
        <SegmentedControl
          aria-label="Default task status"
          name={`${name}-default`}
          value={value}
          onChange={setValue}
          state="default"
          options={options}
        />
        <SegmentedControl
          aria-label="Selected task status"
          name={`${name}-selected`}
          value="running"
          onChange={setValue}
          state="selected"
          options={options}
        />
        <SegmentedControl
          aria-label="Focused task status"
          name={`${name}-focus`}
          value="ready"
          onChange={setValue}
          state="focus"
          options={options}
        />
        <SegmentedControl
          aria-label="Disabled task status"
          name={`${name}-disabled`}
          value="ready"
          onChange={setValue}
          state="disabled"
          options={[...options, {
            value: "disabled",
            label: "Unavailable",
            disabled: true,
          }]}
        />
      </Stack>
    );
  },
};

const InlineModesStory: StoryObj = {
  render: () => (
    <SegmentedControl
      aria-label="Message type"
      name="inline-modes"
      onChange={() => undefined}
      options={[
        { value: "discuss", label: "Discuss" },
        { value: "ask", label: "Ask agent" },
      ]}
      value="ask"
      variant="inline"
    />
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {InlineModesStory.render?.(args, context)}
    </>
  ),
};
