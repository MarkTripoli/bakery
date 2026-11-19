import { assertEquals } from "@std/assert";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #400: every run is a compiled plan, and `secret.identity.read` is a worker action
// that only the retired flat executor scheduled. The plan catalog does not
// register it, so a plan that names it is refused at compile and no run can be
// created from it. The full-stack secret-identity journey that used to create
// such a run was retired with it; the worker action itself stays covered by the
// integration test run-fixed-secret-identity-action_test.ts and the recovery
// test run-fixed-secret-identity-after-process-restart_test.ts, which build the
// job directly. Registering the action in the plan catalog is kernel work.

Deno.test("a plan that names secret.identity.read is refused at compile: the action is not a plan action", async () => {
  const compiled = await compileWorkflowDocumentDetailed({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "secret-identity",
    steps: [{
      id: "flow",
      steps: [{
        id: "identity",
        uses: "secret.identity.read",
        with: { secretRef: crypto.randomUUID() },
      }],
    }],
  }, { catalog: defaultWorkflowCompilerCatalog() });
  assertEquals(compiled.result.ok, false);
  if (compiled.result.ok) return;
  assertEquals(
    compiled.result.diagnostics.map(({ code, path }) => [code, path]),
    [["action_unknown", "/steps/0/steps/0/uses"]],
  );
});
