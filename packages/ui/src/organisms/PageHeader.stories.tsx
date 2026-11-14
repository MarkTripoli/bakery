import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, PageHeader } from "@bakery/ui";
import { PaperPageHeader } from "../examples/shell-example.tsx";

const meta = {
  title: "Bakery/Organisms/PageHeader",
  parameters: { catalogId: "ui.pageHeader", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => (
    <div className="gallery-stack-example">
      <PaperPageHeader variant="titled" />
      <PaperPageHeader variant="tabsOnly" />
      <PageHeader
        actions={<Button>Create application</Button>}
        subtitle={<p>Manage applications, repositories and profiles.</p>}
        title="Projects onboarding"
        variant="list"
      />
    </div>
  ),
};

const SplitStory: StoryObj = {
  render: () => (
    <PageHeader
      variant="split"
      title="Coordination plan"
      subtitle={<span>Shared checkout onboarding · Plan, version 2</span>}
      summary={<span>1 of 5 lanes completed</span>}
    />
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {SplitStory.render?.(args, context)}
    </>
  ),
};
