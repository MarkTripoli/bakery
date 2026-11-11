import type { Meta, StoryObj } from "@storybook/react-vite";
import { PresetOption, Stack, Text } from "@bakery/ui";
import { storyTranslator } from "../fixtures/task-session.ts";

const meta = {
  title: "Bakery/Molecules/PresetOption",
  parameters: { catalogId: "ui.presetOption", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: (_args, context) => {
    const t = storyTranslator(context.globals);
    const title = t("tasks.preset.fixedCoding.title");
    const description = t("tasks.preset.fixedCoding.description");
    return (
      <Stack>
        <Text data-testid="text-specimen-copy" variant="caption">
          {t("tasks.composer.unknown")}
        </Text>
        <div aria-label="Preset states" role="radiogroup">
          <PresetOption
            checked
            description={description}
            name="preset-states"
            onChange={() => {}}
            title={title}
            value="selected"
          />
          <PresetOption
            checked={false}
            description={description}
            name="preset-states"
            onChange={() => {}}
            title={title}
            value="default"
          />
          <PresetOption
            checked={false}
            description={description}
            name="preset-states"
            onChange={() => {}}
            title={title}
            unavailable={t("tasks.composer.setup.coding_agent_unbound")}
            value="unavailable"
          />
          <PresetOption
            checked={false}
            description={description}
            disabled
            name="preset-states"
            onChange={() => {}}
            title={title}
            value="disabled"
          />
        </div>
      </Stack>
    );
  },
};
