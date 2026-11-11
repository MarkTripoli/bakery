import type { Meta, StoryObj } from "@storybook/react-vite";
import { CodeBlock, Stack, Text } from "@bakery/ui";

const code =
  'import { Button } from "@bakery/ui";\n<Button>Start task</Button>';
const overflowingCode =
  "const deliberatelyOverflowingIdentifier = 'runtime-overflow-proof-without-wrapping';"
    .repeat(12);

const meta = {
  title: "Bakery/Organisms/CodeBlock",
  parameters: { catalogId: "ui.codeBlock", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <Text variant="caption">
        Plain · syntax · command · copied · overflowing · long-content
      </Text>
      <CodeBlock code="echo bakery" state="default" variant="plain" />
      <CodeBlock
        code="npx @bakery/worker@VERIFIED_VERSION setup"
        variant="command"
      />
      <CodeBlock
        code={overflowingCode}
        language="tsx"
        state="overflowing"
        variant="syntax"
      />
      <CodeBlock code={code} copied state="copied" variant="syntax" />
      <CodeBlock
        code={`${code}\n${
          "// intentionally long content for reflow coverage\n".repeat(8)
        }`}
        language="tsx"
        state="long-content"
        variant="syntax"
      />
    </Stack>
  ),
};
