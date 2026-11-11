import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field, OneTimeCodeInput, Stack, Text } from "@bakery/ui";

const PSEUDO_COPY =
  "[!! Thiiis deterministic pseudo-locale sentence is deliberately expanded so the actual OneTimeCodeInput specimen exposes clipping, wrapping, and overflow defects. !!]";

const meta = {
  title: "Bakery/Molecules/OneTimeCodeInput",
  parameters: {
    catalogId: "ui.oneTimeCodeInput",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: (_args, context) => {
    const defaultId = useId();
    const invalidId = useId();
    const disabledId = useId();
    const completeId = useId();
    const [defaultValue, setDefaultValue] = useState("012");
    const [invalidValue, setInvalidValue] = useState("000000");
    const [completeValue, setCompleteValue] = useState("482913");
    return (
      <Stack>
        <Text data-testid="text-specimen-copy" variant="caption">
          {context.globals.locale === "pseudo"
            ? PSEUDO_COPY
            : "Default · Invalid · Disabled · Complete"}
        </Text>
        <Field htmlFor={defaultId} label="Default authenticator code">
          <OneTimeCodeInput
            disabled={false}
            id={defaultId}
            invalid={false}
            kind="totp"
            name="default-code"
            onChange={setDefaultValue}
            value={defaultValue}
          />
        </Field>
        <Field
          error="Enter the current six-digit code."
          htmlFor={invalidId}
          label="Invalid authenticator code"
        >
          <OneTimeCodeInput
            disabled={false}
            id={invalidId}
            invalid
            kind="totp"
            name="invalid-code"
            onChange={setInvalidValue}
            value={invalidValue}
          />
        </Field>
        <Field htmlFor={disabledId} label="Disabled backup code">
          <OneTimeCodeInput
            disabled
            id={disabledId}
            invalid={false}
            kind="backup"
            name="disabled-code"
            onChange={() => {}}
            value="ABCDEFGH"
          />
        </Field>
        <Field htmlFor={completeId} label="Complete authenticator code">
          <OneTimeCodeInput
            disabled={false}
            id={completeId}
            invalid={false}
            kind="totp"
            name="complete-code"
            onChange={setCompleteValue}
            value={completeValue}
          />
        </Field>
      </Stack>
    );
  },
};
