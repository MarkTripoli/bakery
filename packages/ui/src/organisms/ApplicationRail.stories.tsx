import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fireEvent, userEvent, within } from "storybook/test";
import { ApplicationRail } from "@bakery/ui";
import { navigation } from "../examples/story-helpers.tsx";

const meta = {
  title: "Bakery/Organisms/ApplicationRail",
  parameters: { catalogId: "ui.applicationRail", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

function ContractExample() {
  const [currentPath, setCurrentPath] = useState("/");
  const [handoff, setHandoff] = useState("idle");
  const onNavigate: NonNullable<
    ComponentProps<typeof ApplicationRail>["onNavigate"]
  > = (event, item) => {
    if (
      event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey
    ) {
      setHandoff("native");
      return;
    }
    event.preventDefault();
    event.currentTarget.ownerDocument.defaultView?.history.pushState(
      null,
      "",
      item.href,
    );
    setCurrentPath(item.href);
    setHandoff("router");
  };
  return (
    <>
      <ApplicationRail
        currentPath={currentPath}
        items={[
          { id: "status", label: "Status", href: "/" },
          {
            id: "settings",
            label: "Settings",
            href: "/settings/appearance",
          },
        ]}
        label="Labelled application"
        onNavigate={onNavigate}
        state="selected"
        variant="labelled"
      />
      <span role="status">{handoff}</span>
      <ApplicationRail
        currentPath="#components"
        items={navigation}
        label="Compact application"
        state="expanded"
        variant="compact"
      />
      <ApplicationRail
        currentPath="#components"
        items={navigation}
        label="Drawer application"
        variant="drawer"
      />
    </>
  );
}

export const Contract: StoryObj = {
  render: () => <ContractExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("link", { name: "Settings" }));
    await expect(
      canvas.getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(canvas.getByRole("status")).toHaveTextContent("router");
    await expect(canvasElement.ownerDocument.defaultView?.location.pathname)
      .toBe("/settings/appearance");
    fireEvent.click(canvas.getByRole("link", { name: "Status" }), {
      ctrlKey: true,
    });
    await expect(canvas.getByRole("status")).toHaveTextContent("native");
    await expect(
      canvas.getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("aria-current", "page");
  },
};
