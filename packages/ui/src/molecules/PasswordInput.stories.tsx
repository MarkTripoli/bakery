import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Field, PasswordInput, Stack, Text } from "@bakery/ui";

const PSEUDO_COPY =
  "[!! Thiiis deterministic pseudo-locale sentence is deliberately expanded so the actual PasswordInput specimen exposes clipping, wrapping, and overflow defects. !!]";

const meta = {
  title: "Bakery/Molecules/PasswordInput",
  parameters: { catalogId: "ui.passwordInput", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const revealLabels = { hide: "Hide password", show: "Show password" };

function RevealedDemo() {
  const id = useId();
  const [value, setValue] = useState("visible-password");
  return (
    <div data-testid="revealed-demo">
      <Field htmlFor={id} label="Revealed password">
        <PasswordInput
          autoComplete="new-password"
          disabled={false}
          id={id}
          invalid={false}
          name="revealed-password"
          onChange={setValue}
          readOnly={false}
          required={false}
          revealLabels={revealLabels}
          value={value}
        />
      </Field>
    </div>
  );
}

export const Contract: StoryObj = {
  render: (_args, context) => {
    const defaultId = useId();
    const invalidId = useId();
    const disabledId = useId();
    const [defaultValue, setDefaultValue] = useState("correct horse battery");
    const [invalidValue, setInvalidValue] = useState("short");
    return (
      <Stack>
        <Text data-testid="text-specimen-copy" variant="caption">
          {context.globals.locale === "pseudo"
            ? PSEUDO_COPY
            : "Default · Invalid · Disabled · Revealed"}
        </Text>
        <Field htmlFor={defaultId} label="Default password">
          <PasswordInput
            autoComplete="current-password"
            disabled={false}
            id={defaultId}
            invalid={false}
            name="default-password"
            onChange={setDefaultValue}
            readOnly={false}
            required
            revealLabels={revealLabels}
            value={defaultValue}
          />
        </Field>
        <Field
          error="Enter at least 8 characters."
          htmlFor={invalidId}
          label="Invalid password"
        >
          <PasswordInput
            autoComplete="current-password"
            disabled={false}
            id={invalidId}
            invalid
            name="invalid-password"
            onChange={setInvalidValue}
            readOnly={false}
            required
            revealLabels={revealLabels}
            value={invalidValue}
          />
        </Field>
        <Field htmlFor={disabledId} label="Disabled password">
          <PasswordInput
            autoComplete="current-password"
            disabled
            id={disabledId}
            invalid={false}
            name="disabled-password"
            onChange={() => {}}
            readOnly={false}
            required={false}
            revealLabels={revealLabels}
            value="unavailable"
          />
        </Field>
        <RevealedDemo />
      </Stack>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const demo = within(canvas.getByTestId("revealed-demo"));
    const toggle = demo.getByRole("button", { name: revealLabels.show });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("data-state", "pressed");
  },
};
