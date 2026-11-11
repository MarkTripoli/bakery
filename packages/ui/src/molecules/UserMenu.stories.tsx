import type { Meta, StoryObj } from "@storybook/react-vite";
import { UserMenu } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/UserMenu",
  parameters: { catalogId: "ui.userMenu", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const items = [
  { id: "organizations", label: "Switch organization" },
  { id: "sign-out", label: "Sign out" },
];

export const Contract: StoryObj = {
  render: () => (
    <div className="gallery-stack-example gallery-user-menu-example">
      <UserMenu items={items} label="Account" name="Mark Tripoli" />
      <UserMenu
        items={items}
        label="Account, compact"
        name="Mark Tripoli"
        variant="compact"
      />
      <UserMenu
        items={items}
        label="Account, open"
        name="Sam Lee"
        state="open"
      />
    </div>
  ),
};
