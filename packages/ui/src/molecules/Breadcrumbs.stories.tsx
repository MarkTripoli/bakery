import type { Meta, StoryObj } from "@storybook/react-vite";
import { Breadcrumbs, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Breadcrumbs",
  parameters: { catalogId: "ui.breadcrumbs", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Breadcrumbs
        aria-label="Full breadcrumb"
        state="default"
        variant="full"
        items={[{ label: "Work", href: "#page.workQueue" }, {
          label: "Review navigation",
          href: "#ui.sectionNavigation",
        }, { label: "Current page" }]}
      />
      <Breadcrumbs
        aria-label="Collapsed breadcrumb"
        state="focus"
        variant="collapsed"
        items={[{ label: "Work", href: "#page.workQueue" }, {
          label: "Review navigation",
          href: "#ui.sectionNavigation",
        }, { label: "Current page" }]}
      />
    </Stack>
  ),
};
