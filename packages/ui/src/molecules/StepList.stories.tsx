import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  DataText,
  HelpTip,
  Stack,
  StepItem,
  StepList,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/StepList",
  parameters: { catalogId: "ui.stepList", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * A list of steps as the delivery section uses it: a done step with a text
 * action, a failed step with a help tip after its name, an older-commit badge
 * and its open detail, a running step, and a step whose name and result are long
 * enough to wrap.
 */
export const Contract: StoryObj = {
  render: () => (
    <StepList label="Delivery steps">
      <StepItem
        action={<Button variant="text">View changes</Button>}
        status="done"
        statusLabel="Done"
        summary={
          <>
            Commit <DataText variant="identifier">4be19c2</DataText> on top of
            {" "}
            <DataText variant="identifier">a7254e7</DataText>
          </>
        }
        title="Changes"
      />
      <StepItem
        action={<Button variant="text">View output</Button>}
        status="failed"
        statusLabel="Failed"
        summary={
          <>
            1 of 5 failed <Badge>Older commit 4be19c2</Badge>
          </>
        }
        title={
          <>
            Checks
            <HelpTip label="About checks">
              Automatic tests and rules that must pass before the change can go
              on.
            </HelpTip>
          </>
        }
      >
        <Stack>
          <Text>Tests pnpm test:unit · exit 1 · 2m 03s</Text>
          <Badge tone="danger">Failed</Badge>
          <Text>4 passed</Text>
        </Stack>
      </StepItem>
      <StepItem
        status="running"
        statusLabel="Running"
        summary="The reviewing agent is reading the changes."
        title="Review"
      />
      <StepItem
        status="unknown"
        statusLabel="Unknown"
        summary="Bakery has not been able to confirm this yet. It will keep checking, and nothing here is shown as passed or failed until it does."
        title="A step with a name that is long enough to need more than one line on a phone"
      />
    </StepList>
  ),
};
