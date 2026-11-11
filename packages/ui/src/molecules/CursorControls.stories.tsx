import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CursorControls, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/CursorControls",
  parameters: { catalogId: "ui.cursorControls", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => {
    const [count, setCount] = useState(0);
    return (
      <>
        <CursorControls
          variant="previousNext"
          state="ready"
          hasNext
          hasPrevious={count > 0}
          onNext={() => setCount(count + 1)}
          onPrevious={() => setCount(Math.max(0, count - 1))}
        />
        <CursorControls variant="loadMore" state="loading" hasNext />
        <CursorControls variant="loadMore" state="end" />
        <CursorControls
          variant="previousNext"
          state="error"
          onRetry={() => undefined}
        />
        <CursorControls variant="loadMore" state="ready" hasNext />
        <Text role="status">Page {count + 1}</Text>
      </>
    );
  },
};
