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

const COMMIT_URL =
  "https://github.com/example/repo/commit/4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6";
const TASK_ID = "9b81d3f07e6c2a4b5d9f1e3c7a0b2d4f";

const kinds = [
  ["Commit, outside Bakery", "Commit", "commit", SHA, COMMIT_URL, true],
  ["Release, no page", "Release", "release", SHA, undefined, false],
  [
    "Pull request, outside Bakery",
    "Pull request",
    "pullRequest",
    "#123",
    "https://github.com/example/repo/pull/123",
    true,
  ],
  ["Issue, inside Bakery", "Issue", "issue", "#88", "#", false],
  ["Task, inside Bakery", "Task", "task", TASK_ID, "#", false],
  [
    "Run, inside Bakery",
    "Run",
    "run",
    "c41d7e20a9b34f6d8e1a5c7b9d2f4a60",
    "#",
    false,
  ],
  [
    "Machine, plain name",
    "Machine",
    "machine",
    "build-box-2",
    undefined,
    false,
  ],
  ["Person, plain name", "Person", "person", "ana", undefined, false],
] as const;

export const Contract: StoryObj = {
  render: () => (
    <Stack gap="spacious">
      {kinds.map(([row, name, kind, value, href, external]) => (
        <Text key={row}>
          {row}:{" "}
          <Reference
            external={external}
            href={href}
            kind={kind}
            label={kind === "issue" ? "BAK-88" : undefined}
            labels={labels(name)}
            value={value}
          />.
        </Text>
      ))}
      <Text>
        A task shows its own reference:{" "}
        <Reference
          href="#"
          kind="task"
          label="BAK-142"
          labels={labels("Task")}
          value="BAK-142"
        />.
      </Text>
      <Text>
        The open card, after Copy worked, and when the clipboard refuses:
      </Text>
      <div
        style={{
          display: "grid",
          gap: "var(--space-4)",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(20rem, 100%), 1fr))",
        }}
      >
        <div style={{ minBlockSize: "18rem", transform: "translateZ(0)" }}>
          <Reference
            defaultOpen
            external
            href={COMMIT_URL}
            kind="commit"
            labels={labels("Commit")}
            value={SHA}
          />
        </div>
        <div style={{ minBlockSize: "18rem", transform: "translateZ(0)" }}>
          <Reference
            defaultCopy="copied"
            defaultOpen
            kind="release"
            labels={labels("Release")}
            value={SHA}
          />
        </div>
        <div style={{ minBlockSize: "18rem", transform: "translateZ(0)" }}>
          <Reference
            defaultCopy="failed"
            defaultOpen
            kind="release"
            labels={labels("Release")}
            value={SHA}
          />
        </div>
      </div>
      <Text>
        A full stop stays with the reference, here at the end of a sentence
        about{" "}
        <Reference
          external
          href={COMMIT_URL}
          kind="commit"
          labels={labels("Commit")}
          trailing="."
          value={SHA}
        />
      </Text>
      <div dir="rtl">
        <Text>
          מזהה:{" "}
          <Reference
            external
            href={COMMIT_URL}
            kind="commit"
            labels={labels("Commit")}
            value={SHA}
          />.
        </Text>
      </div>
    </Stack>
  ),
};
