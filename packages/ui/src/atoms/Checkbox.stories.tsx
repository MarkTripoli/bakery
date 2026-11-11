import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Checkbox, type CheckboxProps } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Checkbox",
  parameters: { catalogId: "ui.checkbox", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const forgedOwnerProps = {
  "data-state": "invalid",
  "data-testid": "checkbox-reserved-props",
  "data-ui-component": "checkbox",
  "data-variant": "mixed",
} as unknown as CheckboxProps;

export const Contract: StoryObj = {
  render: () => (
    <form>
      <Checkbox {...forgedOwnerProps}>
        Notify me when the task finishes
      </Checkbox>
      <Checkbox defaultChecked>Notify me when the task starts</Checkbox>
      <Checkbox mixed>Notify me about partial progress</Checkbox>
      <Checkbox
        autoFocus
        data-testid="checkbox-prevent-default-focus"
        onBlur={(event) => event.preventDefault()}
        onFocus={(event) => event.preventDefault()}
      >
        Focused notification setting
      </Checkbox>
      <Checkbox aria-invalid>Invalid notification setting</Checkbox>
      <Checkbox disabled>Disabled notification setting</Checkbox>
      <Button type="reset" variant="secondary">Reset checkbox settings</Button>
    </form>
  ),
};
