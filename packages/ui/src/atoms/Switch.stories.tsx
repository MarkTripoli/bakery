import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Stack, Switch } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Switch",
  parameters: { catalogId: "ui.switch", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <form>
      <Stack>
        <Switch defaultChecked>Notifications on</Switch>
        <Switch pending>Saving notification preference</Switch>
        <Switch disabled>Notifications disabled</Switch>
        <Switch
          autoFocus
          data-testid="switch-prevent-default-focus"
          onBlur={(event) => event.preventDefault()}
          onFocus={(event) => event.preventDefault()}
        >
          Focused notification preference
        </Switch>
        <Switch>Notifications off</Switch>
        <Button type="reset" variant="secondary">Reset switch settings</Button>
      </Stack>
    </form>
  ),
};
