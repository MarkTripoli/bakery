import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, SessionNowLine, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Organisms/SessionNowLine",
  parameters: { catalogId: "ui.sessionNowLine", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * Working with elapsed time, waiting, a failure with a wrapped reason, a lost
 * connection with Try now, and a line about another step.
 */
export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <SessionNowLine tone="active" edge="12s">
        Running run_tests…
      </SessionNowLine>
      <SessionNowLine tone="idle">Waiting to start…</SessionNowLine>
      <SessionNowLine tone="danger" icon="close">
        <strong>Session failed.</strong>{" "}
        The signing key expired on 2026-11-02, so the release build could not be
        signed and the run stopped after three attempts.
      </SessionNowLine>
      <SessionNowLine
        tone="warning"
        icon="warning"
        action={<Button variant="outline">Try now</Button>}
      >
        Connection lost. Reconnecting… Last update 2 min ago.
      </SessionNowLine>
      <SessionNowLine tone="active" onSelect={() => {}}>
        Run tests: Running the full suite…
      </SessionNowLine>
    </Stack>
  ),
};
