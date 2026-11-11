import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field, Stack, Text, TextInput } from "@bakery/ui";

const PSEUDO_COPY =
  "[!! Thiiis deterministic pseudo-locale sentence is deliberately expanded so the actual TextInput specimen exposes clipping, wrapping, and overflow defects. !!]";

const meta = {
  title: "Bakery/Atoms/TextInput",
  parameters: { catalogId: "ui.textInput", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const longCopyValue =
  "a-deliberately-long-value-demonstrating-overflow-handling-in-the-text-input-control";

export const Contract: StoryObj = {
  render: (_args, context) => {
    const numberId = useId();
    const [numberValue, setNumberValue] = useState("1");
    const defaultId = useId();
    const invalidId = useId();
    const disabledId = useId();
    const readonlyId = useId();
    const longCopyId = useId();
    const [defaultValue, setDefaultValue] = useState("you@example.com");
    const [invalidValue, setInvalidValue] = useState("not-an-email");
    return (
      <Stack>
        <Text data-testid="text-specimen-copy" variant="caption">
          {context.globals.locale === "pseudo"
            ? PSEUDO_COPY
            : "Default · Invalid · Disabled · Readonly · Long copy"}
        </Text>
        <Field htmlFor={numberId} label="Source line">
          <TextInput
            autoComplete="off"
            id={numberId}
            name="source-line"
            type="number"
            min={1}
            max={100}
            step={1}
            value={numberValue}
            onChange={setNumberValue}
          />
        </Field>
        <Field htmlFor={defaultId} label="Default email">
          <TextInput
            autoComplete="email"
            disabled={false}
            id={defaultId}
            invalid={false}
            name="default-email"
            onChange={setDefaultValue}
            readOnly={false}
            required
            type="email"
            value={defaultValue}
          />
        </Field>
        <Field
          error="Enter a valid value."
          htmlFor={invalidId}
          label="Invalid text"
        >
          <TextInput
            autoComplete="off"
            disabled={false}
            id={invalidId}
            invalid
            name="invalid-text"
            onChange={setInvalidValue}
            readOnly={false}
            required
            type="text"
            value={invalidValue}
          />
        </Field>
        <Field htmlFor={disabledId} label="Disabled text">
          <TextInput
            autoComplete="off"
            disabled
            id={disabledId}
            invalid={false}
            name="disabled-text"
            onChange={() => {}}
            readOnly={false}
            required={false}
            type="text"
            value="Unavailable"
          />
        </Field>
        <Field htmlFor={readonlyId} label="Readonly email">
          <TextInput
            autoComplete="email"
            disabled={false}
            id={readonlyId}
            invalid={false}
            name="readonly-email"
            onChange={() => {}}
            readOnly
            required={false}
            type="email"
            value="reference@example.com"
          />
        </Field>
        <Field htmlFor={longCopyId} label="Long copy text">
          <TextInput
            autoComplete="off"
            disabled={false}
            id={longCopyId}
            invalid={false}
            name="long-copy-text"
            onChange={() => {}}
            readOnly={false}
            required={false}
            type="text"
            value={longCopyValue}
          />
        </Field>
      </Stack>
    );
  },
};
