import { useId } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Radio, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Radio",
  parameters: { catalogId: "ui.radio", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const name = useId();
    return (
      <form>
        <Stack>
          <Radio name={`${name}-default`} value="default">
            Default visibility
          </Radio>
          <Radio name={name} value="team" defaultChecked aria-invalid>
            Team visibility
          </Radio>
          <Radio
            autoFocus
            data-testid="radio-prevent-default-focus"
            name={name}
            onBlur={(event) => event.preventDefault()}
            onFocus={(event) => event.preventDefault()}
            value="private"
          >
            Private visibility
          </Radio>
          <Radio disabled name={`${name}-disabled`} value="disabled">
            Disabled visibility
          </Radio>
          <Button type="reset" variant="secondary">Reset radio settings</Button>
        </Stack>
      </form>
    );
  },
};
