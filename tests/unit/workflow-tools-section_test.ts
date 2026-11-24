import { assert, assertEquals } from "@std/assert";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #436 (25-one-engine.md 15.5): the workflow tools section names MCP
// connections with the exact tools the workflow may use; a step references an
// entry or one tool of it, and a seat listed on an entry gets all of its tools.
// The section and the references are digest-bearing data the compiler checks.

const CONNECTION = "44444444-4444-4444-8444-444444444444";

function workflow(extra: Record<string, unknown>, steps: unknown[]) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "tools-section",
    description: "Exercises the workflow tools section.",
    inputs: {},
    ...extra,
    steps,
  };
}

const compile = (document: unknown) =>
  compileWorkflowDocument(document, {
    catalog: defaultWorkflowCompilerCatalog(),
  });

const codes = (result: Awaited<ReturnType<typeof compile>>) =>
  result.ok ? [] : result.diagnostics.map(({ path, code }) => ({ path, code }));

Deno.test("a tools section and a step's references compile into the semantic document, sorted", async () => {
  const result = await compile(workflow({
    tools: {
      docs: {
        connectionId: CONNECTION.toUpperCase(),
        allow: ["search", "create_note"],
        seats: ["writer", "designer"],
      },
    },
  }, [{
    id: "draft",
    uses: "workflow.noop",
    role: "writer",
    tools: ["docs.search", "docs"],
  }]));
  assert(result.ok, JSON.stringify(codes(result)));
  const document = result.document as unknown as {
    tools: Record<string, unknown>;
    steps: { tools?: string[] }[];
  };
  assertEquals(document.tools, {
    docs: {
      connectionId: CONNECTION,
      allow: ["create_note", "search"],
      seats: ["designer", "writer"],
    },
  });
  assertEquals(document.steps[0]!.tools, ["docs", "docs.search"]);
});

Deno.test("a workflow without a tools section keeps its digest: the section is absent, not empty", async () => {
  const plain = await compile(
    workflow({}, [{ id: "draft", uses: "workflow.noop" }]),
  );
  assert(plain.ok);
  assertEquals("tools" in (plain.document as object), false);
});

Deno.test("a reference to a missing entry or a tool the entry does not allow is refused by name", async () => {
  const section = {
    tools: { docs: { connectionId: CONNECTION, allow: ["search"] } },
  };
  assertEquals(
    codes(
      await compile(workflow(section, [{
        id: "draft",
        uses: "workflow.noop",
        tools: ["docs.delete_everything"],
      }])),
    ),
    [{ path: "/steps/0/tools", code: "action_tools_invalid" }],
  );
  assertEquals(
    codes(
      await compile(workflow(section, [{
        id: "draft",
        uses: "workflow.noop",
        tools: ["mail"],
      }])),
    ),
    [{ path: "/steps/0/tools", code: "action_tools_invalid" }],
  );
});

Deno.test("a malformed tools section is refused: wildcards, repeats, empty lists and unknown keys", async () => {
  const step = [{ id: "draft", uses: "workflow.noop" }];
  for (
    const entry of [
      { connectionId: CONNECTION, allow: ["*"] },
      { connectionId: CONNECTION, allow: ["search", "search"] },
      { connectionId: CONNECTION, allow: [] },
      { connectionId: CONNECTION, allow: ["search"], seats: ["Not A Seat"] },
      { connectionId: CONNECTION, allow: ["search"], extra: true },
    ]
  ) {
    const result = await compile(workflow({ tools: { docs: entry } }, step));
    assert(!result.ok, JSON.stringify(entry));
    assert(
      codes(result).every((item) => item.code === "workflow_tools_invalid"),
      JSON.stringify(codes(result)),
    );
  }
});
