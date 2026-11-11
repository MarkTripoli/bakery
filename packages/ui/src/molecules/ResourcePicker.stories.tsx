import type { Meta, StoryObj } from "@storybook/react-vite";
import { ResourcePicker, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/ResourcePicker",
  parameters: { catalogId: "ui.resourcePicker", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <ResourcePicker
        label="Repository"
        variant="single"
        state="selected"
        defaultValue="bakery"
        options={[{ value: "bakery", label: "Bakery" }, {
          value: "docs",
          label: "Documentation",
        }]}
      />
      <ResourcePicker
        label="Repositories"
        multiple
        variant="multiple"
        state="searching"
        options={[{ value: "bakery", label: "Bakery" }, {
          value: "docs",
          label: "Documentation",
        }]}
      />
      <ResourcePicker
        label="Empty repository list"
        state="empty"
        options={[]}
      />
      <ResourcePicker
        label="Loading repository list"
        state="loading"
        options={[]}
      />
      <ResourcePicker
        label="Repository error"
        state="error"
        error="Repositories are unavailable."
        options={[]}
      />
      <div data-testid="resource-picker-unavailable">
        <ResourcePicker
          label="Unavailable repository"
          state="unavailable"
          disabled={false}
          options={[{ value: "offline", label: "Offline repository" }]}
        />
      </div>
    </Stack>
  ),
};
