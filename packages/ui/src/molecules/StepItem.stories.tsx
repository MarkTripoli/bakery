import type { Meta, StoryObj } from "@storybook/react-vite";
import { StepItem, StepList } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StepItem",
  parameters: { catalogId: "ui.stepItem", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/** Every status of a step: its mark, its words, and how an upcoming step is muted. */
export const Contract: StoryObj = {
  render: () => (
    <StepList label="Step statuses">
      <StepItem
        status="done"
        statusLabel="Done"
        summary="Finished and passed."
        title="Done"
      />
      <StepItem
        status="failed"
        statusLabel="Failed"
        summary="Finished and did not pass."
        title="Failed"
      />
      <StepItem
        status="running"
        statusLabel="Running"
        summary="In progress."
        title="Running"
      />
      <StepItem
        status="waiting"
        statusLabel="Waiting for you"
        summary="Needs a person to act."
        title="Waiting"
      />
      <StepItem
        status="upcoming"
        statusLabel="Not started"
        summary="Starts after the steps above."
        title="Upcoming"
      />
      <StepItem
        status="unknown"
        statusLabel="Unknown"
        summary="Not reported, so never shown as passed or failed."
        title="Unknown"
      />
    </StepList>
  ),
};

/** A definition's steps: nothing is running, so each mark holds the step's number (opt-in). */
export const Numbered: StoryObj = {
  render: () => (
    <StepList label="Workflow steps">
      <StepItem
        number={1}
        status="upcoming"
        statusLabel="Step 1"
        title="Write the task brief"
      />
      <StepItem
        number={2}
        status="upcoming"
        statusLabel="Step 2"
        summary="Agent: Code writer, version 2"
        title="Run the coding agent"
      />
      <StepItem
        number={3}
        status="upcoming"
        statusLabel="Step 3"
        title="Review the changes"
      />
    </StepList>
  ),
};
