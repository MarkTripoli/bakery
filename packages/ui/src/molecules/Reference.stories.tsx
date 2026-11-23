import type { Meta, StoryObj } from "@storybook/react-vite";
import { Reference, type ReferenceLabels, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/Reference",
  parameters: { catalogId: "ui.reference", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const labels = (kind: string): ReferenceLabels => ({
  kind,
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Could not copy. Select the id above.",
  close: "Close",
  opensNewTab: "(opens in a new tab)",
  destination: "Opens on GitHub in a new tab.",
});

const SHA = "4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6";

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="spacious">
      <Text>
        A commit links outside Bakery:{" "}
        <Reference
          external
          href="https://github.com/example/repo/commit/4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6"
          kind="commit"
          labels={labels("Commit")}
          value={SHA}
        />.
      </Text>
      <Text>
        A task links inside Bakery:{" "}
        <Reference
          href="#"
          kind="task"
          labels={labels("Task")}
          value="9b81d3f07e6c2a4b5d9f1e3c7a0b2d4f"
        />.
      </Text>
      <Text>
        A release has no page, so it is plain text with its card:{" "}
        <Reference
          kind="release"
          labels={labels("Release")}
          value={SHA}
        />.
      </Text>
      <Text>
        A pull request and a task's own reference show their label:{" "}
        <Reference
          external
          href="https://github.com/example/repo/pull/123"
          kind="pullRequest"
          label="#123"
          labels={labels("Pull request")}
          value="#123"
        />{" "}
        <Reference
          href="#"
          kind="task"
          label="BAK-142"
          labels={labels("Task")}
          value="BAK-142"
        />.
      </Text>
      <Text>
        A machine and a person are names, plain text:{" "}
        <Reference
          kind="machine"
          labels={labels("Machine")}
          value="build-box-2"
        />{" "}
        <Reference kind="person" labels={labels("Person")} value="ana" />.
      </Text>
      <Text>The card, open:</Text>
      <div style={{ minBlockSize: "180px" }}>
        <Reference
          defaultOpen
          external
          href="https://github.com/example/repo/commit/4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6"
          kind="commit"
          labels={labels("Commit")}
          value={SHA}
        />
      </div>
    </Stack>
  ),
};
