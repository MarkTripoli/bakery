/**
 * #452: a workflow step binds storage connections (chapter 25 section 17.6,
 * O44). The binding is part of the step's files section; the compiler
 * normalizes it, the SDK writes it, the claim mints one scope per bound
 * connection, and the read guard opens /connections only under a bound
 * mount.
 */

import { assert, assertEquals } from "@std/assert";
import {
  boundStepConnections,
  compileWorkflowDocument,
  WorkflowStepFilesSchema,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import { defineWorkflow } from "../../packages/workflow-sdk/mod.ts";
import {
  AgentFileRefusal,
  agentReadAreaRefusal,
  agentRootKeys,
  AgentTreeArea,
  boundConnectionScope,
  boundConnectionsOf,
  connectionMountKey,
  declaredTreeAreas,
  stepFileScopes,
} from "../../apps/server/src/modules/knowledge/agent-file-scope.ts";
import { stepFilesFromSnapshot } from "../../apps/server/src/modules/execution/step-files.ts";
import { mountSystemKey } from "../../apps/server/src/modules/knowledge/storage-connections.ts";

const BOUND = "0195f000-0000-7000-8000-00000000d0a1";
const OTHER = "0195f000-0000-7000-8000-00000000d0a2";

function workflow(steps: Record<string, unknown>[]) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "bound-connections",
    description: "Binds storage connections on a step.",
    inputs: {},
    steps,
  };
}

const compile = (files: unknown) =>
  compileWorkflowDocument(
    workflow([{ id: "aa", uses: "workflow.noop", files }]),
    { catalog: defaultWorkflowCompilerCatalog() },
  );

Deno.test("contract: the bound connections list is described", () => {
  assert(
    (WorkflowStepFilesSchema.shape.connections.description ?? "").length > 40,
  );
});

Deno.test("compiler: a binding is normalized, sorted and lower-cased", async () => {
  const result = await compile({
    read: ["connections", "project"],
    connections: [OTHER.toUpperCase(), BOUND],
  });
  assert(result.ok, JSON.stringify(result));
  const snapshot = { runtime: { pin: {}, document: result.document } };
  assertEquals(stepFilesFromSnapshot(snapshot, "aa"), {
    read: ["project", "connections"],
    write: ["outputs", "workspace"],
    connections: [BOUND, OTHER],
  });
});

Deno.test("compiler: a binding without a connections read, a repeat or a non-id is refused", async () => {
  for (
    const files of [
      { read: ["project"], connections: [BOUND] },
      { read: ["connections"], connections: [BOUND, BOUND] },
      { read: ["connections"], connections: ["drive"] },
      { read: ["connections"], connections: [] },
      { read: ["connections"], connections: BOUND },
    ]
  ) {
    const result = await compile(files);
    assert(!result.ok, JSON.stringify(files));
    assert(
      result.diagnostics.some((d) => d.code === "action_files_invalid"),
      JSON.stringify(result.diagnostics),
    );
  }
  // A sealed step cannot bind: it reads only its inputs.
  const sealed = await compileWorkflowDocument(
    workflow([{
      id: "aa",
      uses: "workflow.noop",
      sealed: true,
      files: { read: ["connections"], connections: [BOUND] },
    }]),
    { catalog: defaultWorkflowCompilerCatalog() },
  );
  assert(!sealed.ok);
});

Deno.test("sdk: an action step carries its files section and binding", async () => {
  const flow = defineWorkflow({ name: "sdk-bound", inputs: {} });
  flow.action("aa", "workflow.noop", {}, {
    files: { read: ["connections"], connections: [BOUND] },
  });
  const built = flow.toJSON();
  assertEquals(built.steps[0], {
    id: "aa",
    uses: "workflow.noop",
    files: { read: ["connections"], connections: [BOUND] },
  });
  const result = await compileWorkflowDocument(built, {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  assert(result.ok, JSON.stringify(result));
});

Deno.test("claim: a bound step mints the connections read and one scope per bound connection", async () => {
  const result = await compile({ read: ["connections"], connections: [BOUND] });
  assert(result.ok);
  const files = stepFilesFromSnapshot(
    { runtime: { pin: {}, document: result.document } },
    "aa",
  );
  const scopes = stepFileScopes(files);
  assert(scopes.includes("files.read:connections"), JSON.stringify(scopes));
  assert(scopes.includes(boundConnectionScope(BOUND)));
  assertEquals(boundConnectionsOf(scopes), [BOUND]);
  // A section that does not read connections mints no binding scope.
  assertEquals(
    boundConnectionsOf(
      stepFileScopes({ read: ["project"], write: [], connections: [BOUND] }),
    ),
    [],
  );
  assertEquals(
    boundStepConnections({ read: ["project"], connections: [BOUND] }),
    [],
  );
  assertEquals(mountSystemKey(BOUND), connectionMountKey(BOUND));
});

Deno.test("guard: /connections opens under a bound mount and nowhere else", () => {
  const declared = declaredTreeAreas(
    stepFileScopes({ read: ["connections"], write: [], connections: [BOUND] }),
    "read",
  );
  const base = {
    area: AgentTreeArea.Connections,
    declared,
    liveGrant: undefined,
    personalOwnerId: null,
  } as const;
  assertEquals(
    agentReadAreaRefusal({ ...base, boundConnection: true }),
    undefined,
  );
  assertEquals(
    agentReadAreaRefusal({ ...base, boundConnection: false }),
    AgentFileRefusal.ConnectionNotBound,
  );
  // A binding without the declared area opens nothing.
  assertEquals(
    agentReadAreaRefusal({ ...base, declared: [], boundConnection: true }),
    AgentFileRefusal.ConnectionNotBound,
  );
  const keys = ["projects", "shared", "library", "connections"];
  assertEquals(agentRootKeys(keys, declared, [BOUND]), ["connections"]);
  assertEquals(agentRootKeys(keys, declared, []), []);
});
