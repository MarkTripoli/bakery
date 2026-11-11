import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inline, Link } from "@bakery/ui";

const meta = {
  title: "Bakery/Atoms/Link",
  parameters: { catalogId: "ui.link", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => {
    const [visited, setVisited] = useState(false);
    return (
      <Inline>
        <Link href="#page.workQueue">Internal work queue</Link>
        <Link href="https://example.com" variant="external">
          External documentation
        </Link>
        <Link autoFocus href="#ui.text" variant="quiet">
          Quiet catalog link
        </Link>
        <Link data-semantic-interaction="hover" href="#hover">Hover link</Link>
        <Link data-semantic-interaction="focus" href="#focus">Focus link</Link>
        <Link
          data-semantic-interaction="visited"
          href="#visited"
          state={visited ? "visited" : "default"}
          onClick={() => setVisited(true)}
        >
          Visited link
        </Link>
      </Inline>
    );
  },
};

const BackAndIconStory: StoryObj = {
  render: () => (
    <Inline>
      <Link href="#back" variant="back">Back to task</Link>
      <Link href="#back" variant="icon" aria-label="Back">‹</Link>
    </Inline>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {BackAndIconStory.render?.(args, context)}
    </>
  ),
};
