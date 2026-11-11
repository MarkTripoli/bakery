import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stack, VersionPicker } from "@bakery/ui";
const meta = {
  title: "Bakery/Molecules/VersionPicker",
  parameters: { catalogId: "ui.versionPicker", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => {
    const [value, setValue] = useState("3");
    const versions = [{ id: "3", label: "Revision 3 · latest" }, {
      id: "2",
      label: "Revision 2",
    }, { id: "1", label: "Revision 1 · expired", disabled: true }];
    return (
      <Stack>
        <VersionPicker
          label="Version"
          value={value}
          versions={versions}
          onChange={setValue}
        />
        <output aria-live="polite">Selected revision {value}</output>
        <VersionPicker
          label="Unavailable versions"
          value="3"
          versions={versions}
          onChange={setValue}
          disabled
        />
      </Stack>
    );
  },
};
