import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Identity,
  ObjectRow,
  Stack,
  StatusBadge,
  Text,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ObjectRow",
  parameters: { catalogId: "ui.objectRow", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [count, setCount] = useState(0);
    const row = (
      state: "default" | "selected" | "loading" | "disabled" | "stale",
      variant: "compact" | "standard" | "comfortable",
    ) => (
      <ObjectRow
        identity={<Identity type="person" name={`Alex Chen · ${variant}`} />}
        metadata={state === "stale" ? "Updated yesterday" : "Updated just now"}
        state={state}
        status={
          <StatusBadge status={state === "stale" ? "degraded" : "active"}>
            {state}
          </StatusBadge>
        }
        variant={variant}
        actions={state === "disabled"
          ? undefined
          : (
            <Button variant="quiet" onClick={() => setCount(count + 1)}>
              Inspect ({count})
            </Button>
          )}
      />
    );
    return (
      <Stack>
        <Text variant="caption">All density variants and lifecycle states</Text>
        {row("default", "compact")}
        {row("selected", "standard")}
        {row("loading", "comfortable")}
        {row("disabled", "standard")}
        {row("stale", "compact")}
      </Stack>
    );
  },
};
