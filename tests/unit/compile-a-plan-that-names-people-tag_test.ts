import { assertEquals } from "@std/assert";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

const document = (input: Record<string, unknown>) => ({
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "notify",
  steps: [{
    id: "flow",
    steps: [{ id: "notify", uses: "people.tag", with: input }],
  }],
});

const compiles = async (input: Record<string, unknown>) => {
  const compiled = await compileWorkflowDocumentDetailed(document(input), {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  return compiled.result.ok
    ? "ok"
    : JSON.stringify(compiled.result.diagnostics);
};

Deno.test("a plan with a Notify step that uses people.tag compiles", async () => {
  assertEquals(
    await compiles({ intent: "fyi", recipientRunRole: "starter" }),
    "ok",
  );
  assertEquals(
    await compiles({
      intent: "review",
      recipientRoleKey: "developer",
      artifactVersionId: crypto.randomUUID(),
      note: "Please review the design",
      wait: true,
    }),
    "ok",
  );
});

Deno.test("a Notify step with an intent people.tag does not offer is refused at compile", async () => {
  assertEquals(
    (await compiles({ intent: "approve", recipientRunRole: "starter" })) ===
      "ok",
    false,
  );
});

Deno.test("a waiting Notify step may say whether the run stops or continues when nobody answers in time", async () => {
  const waiting = {
    intent: "review",
    recipientRunRole: "starter",
    artifactVersionId: crypto.randomUUID(),
    wait: true,
  };
  assertEquals(await compiles({ ...waiting, onExpiry: "stop" }), "ok");
  assertEquals(await compiles({ ...waiting, onExpiry: "continue" }), "ok");
  assertEquals(
    (await compiles({ ...waiting, onExpiry: "approve" })) === "ok",
    false,
  );
});
