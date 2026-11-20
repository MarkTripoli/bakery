import { assertEquals } from "@std/assert";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #400: every run is a compiled plan, so `secret.identity.read` is a plan
// action: the registry publishes its input and output, and a plan that names it
// compiles with the same step the worker claims.

const document = (identityRef: unknown) => ({
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "secret-identity",
  steps: [{
    id: "flow",
    steps: [{
      id: "identity",
      uses: "secret.identity.read",
      with: { identityRef },
    }],
  }],
});

Deno.test("a plan that names secret.identity.read compiles", async () => {
  const compiled = await compileWorkflowDocumentDetailed(
    document(crypto.randomUUID()),
    { catalog: defaultWorkflowCompilerCatalog() },
  );
  assertEquals(
    compiled.result.ok,
    true,
    JSON.stringify(compiled.result.ok ? [] : compiled.result.diagnostics),
  );
});

Deno.test("a plan whose identityRef is not a uuid is refused at compile", async () => {
  const compiled = await compileWorkflowDocumentDetailed(
    document("not-a-uuid"),
    { catalog: defaultWorkflowCompilerCatalog() },
  );
  assertEquals(compiled.result.ok, false);
});
