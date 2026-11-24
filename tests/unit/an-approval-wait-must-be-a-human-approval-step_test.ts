import { assertEquals } from "@std/assert";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

const compile = async (step: Record<string, unknown>) => {
  const compiled = await compileWorkflowDocumentDetailed({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "sign-off",
    steps: [{ id: "flow", steps: [step] }],
  }, { catalog: defaultWorkflowCompilerCatalog() });
  return compiled.result.ok
    ? []
    : compiled.result.diagnostics.map((diagnostic) => diagnostic.code);
};

Deno.test("an explicit human.approval wait is refused and points to the step", async () => {
  for (
    const wait of [
      { event: "human.approval.decided", timeout: "7d" },
      {
        event: "human.approval.decided",
        timeout: "7d",
        approvalId: "00000000-0000-4000-8000-0000000000c1",
      },
    ]
  ) {
    const codes = await compile({ id: "signoff", wait });
    assertEquals(
      codes.includes("approval_wait_use_step") ||
        codes.includes("wait_shape_invalid"),
      true,
      JSON.stringify(codes),
    );
  }
  assertEquals(
    await compile({
      id: "signoff",
      wait: { event: "human.approval.decided", timeout: "7d" },
    }),
    ["approval_wait_use_step"],
  );
});

Deno.test("a human.approval step compiles", async () => {
  assertEquals(
    await compile({
      id: "signoff",
      uses: "human.approval",
      with: { prompt: "Ship it?" },
    }),
    [],
  );
});
