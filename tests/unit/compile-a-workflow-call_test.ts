import { assert, assertEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  type WorkflowNode,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";

// #418 (one engine O10): a `call` names a published workflow version and the
// compiler inlines it. The caller reads only the outputs the child declares,
// the child keeps its own agents, nesting stops at two levels, and a call to a
// version that is not on offer is refused.

const CHILD = "11111111-1111-4111-8111-111111111111";
const MIDDLE = "22222222-2222-4222-8222-222222222222";
const LEAF = "33333333-3333-4333-8333-333333333333";
const TOP = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";

const base = {
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
};

const child = {
  ...base,
  inputs: { topic: { type: "string", required: true } },
  outputs: { summary: "$step.write.summary" },
  steps: [{
    id: "write",
    uses: "workflow.noop",
    with: { text: "$input.topic" },
  }],
};

const parent = (steps: unknown[]) => ({
  ...base,
  inputs: { subject: { type: "string", required: true } },
  steps,
});

const callResearch = {
  id: "research",
  call: { workflow: CHILD, with: { topic: "$input.subject" } },
};
const useResult = {
  id: "after",
  uses: "workflow.noop",
  needs: ["research"],
  with: { text: "$step.research.summary" },
};

const compile = (definition: unknown, workflows: Record<string, unknown>) =>
  compileWorkflowDocument(definition, {
    workflows: new Map(Object.entries(workflows)),
  });

const codes = (result: Awaited<ReturnType<typeof compile>>) =>
  result.ok ? [] : result.diagnostics.map((d) => d.code);

Deno.test("a call is inlined under its id, takes the call's inputs, and exposes only the child's outputs", async () => {
  const result = await compile(parent([callResearch, useResult]), {
    [CHILD]: child,
  });
  assert(result.ok, JSON.stringify(codes(result)));
  const [sequence, after] = result.document.steps as [
    Extract<WorkflowNode, { kind: "sequence" }>,
    Extract<WorkflowNode, { kind: "action" }>,
  ];
  assertEquals(sequence.kind, "sequence");
  assertEquals(sequence.id, "research");
  // The child's input is the value the call passed.
  const write = sequence.steps[0] as Extract<WorkflowNode, { kind: "action" }>;
  assertEquals(write.with, {
    kind: "object",
    fields: { text: { kind: "ref", root: "input", path: ["subject"] } },
  });
  // The caller's read of the child's output reaches the step that made it.
  assertEquals(after.with, {
    kind: "object",
    fields: {
      text: {
        kind: "ref",
        root: "step",
        path: ["research", "write", "summary"],
      },
    },
  });
  // No call is left, and the plan holds the child's step.
  assertEquals(JSON.stringify(result.document).includes('"call"'), false);
  assert(result.plan.steps.some((s) => s.qualifiedId === "research.write"));
});

Deno.test("a literal passed to a call stands where the child reads its input", async () => {
  const result = await compile(
    parent([{
      id: "research",
      call: { workflow: CHILD, with: { topic: "tax law" } },
    }]),
    { [CHILD]: child },
  );
  assert(result.ok, JSON.stringify(codes(result)));
  const sequence = result.document.steps[0] as Extract<
    WorkflowNode,
    { kind: "sequence" }
  >;
  const write = sequence.steps[0] as Extract<WorkflowNode, { kind: "action" }>;
  assertEquals(write.with, {
    kind: "literal",
    value: { text: "tax law" },
  });
});

Deno.test("a version the compiler was not offered is refused, whoever owns it", async () => {
  const result = await compile(parent([callResearch]), {});
  assertEquals(codes(result), ["call_version_unavailable"]);
});

Deno.test("the call must bind exactly the child's declared inputs", async () => {
  const missing = await compile(
    parent([{ id: "research", call: { workflow: CHILD } }]),
    { [CHILD]: child },
  );
  assertEquals(codes(missing), ["call_input_missing"]);
  const unknown = await compile(
    parent([{
      id: "research",
      call: {
        workflow: CHILD,
        with: { topic: "x", color: "red" },
      },
    }]),
    { [CHILD]: child },
  );
  assertEquals(codes(unknown), ["call_input_unknown"]);
});

Deno.test("a caller cannot read a child's inner step or its outcome", async () => {
  for (
    const text of [
      "$step.research.write.summary",
      "$step.research.outcome",
      "$step.research.nothing",
    ]
  ) {
    const result = await compile(
      parent([callResearch, { ...useResult, with: { text } }]),
      { [CHILD]: child },
    );
    assertEquals(codes(result), ["call_output_unknown"], text);
  }
});

Deno.test("the child keeps its own agents on its own steps", async () => {
  const withAgents = {
    ...base,
    agents: { "agent.freeform": AGENT },
    outputs: { done: "$step.think.output" },
    steps: [
      { id: "think", uses: "agent.freeform", with: { prompt: "p" } },
      {
        id: "other",
        uses: "agent.freeform",
        agentVersionId: "66666666-6666-4666-8666-666666666666",
        with: { prompt: "q" },
      },
      { id: "plain", uses: "workflow.noop", with: {} },
    ],
  };
  const result = await compile(
    parent([{ id: "research", call: { workflow: CHILD } }]),
    { [CHILD]: withAgents },
  );
  assert(result.ok, JSON.stringify(codes(result)));
  const sequence = result.document.steps[0] as Extract<
    WorkflowNode,
    { kind: "sequence" }
  >;
  const [think, other, plain] = sequence.steps as Extract<
    WorkflowNode,
    { kind: "action" }
  >[];
  assertEquals(think!.agentVersionId, AGENT);
  assertEquals(other!.agentVersionId, "66666666-6666-4666-8666-666666666666");
  assertEquals(plain!.agentVersionId, undefined);
  // The caller's own agent map is not changed by what it calls.
  assertEquals(result.document.agents, {});
});

Deno.test("calls nest two levels and no deeper", async () => {
  const leaf = {
    ...base,
    steps: [{ id: "leafstep", uses: "workflow.noop", with: {} }],
  };
  const middle = {
    ...base,
    steps: [{ id: "mid", call: { workflow: LEAF } }],
  };
  const top = (inner: string) => ({
    ...base,
    steps: [{ id: "top", call: { workflow: inner } }],
  });
  // parent -> middle -> leaf: two levels.
  const ok = await compile(
    parent([{ id: "run", call: { workflow: MIDDLE } }]),
    {
      [MIDDLE]: middle,
      [LEAF]: leaf,
    },
  );
  assert(ok.ok, JSON.stringify(codes(ok)));
  assert(ok.plan.steps.some((s) => s.qualifiedId === "run.mid.leafstep"));
  // parent -> top -> middle -> leaf: three levels.
  const tooDeep = await compile(
    parent([{ id: "run", call: { workflow: TOP } }]),
    { [TOP]: top(MIDDLE), [MIDDLE]: middle, [LEAF]: leaf },
  );
  assertEquals(codes(tooDeep), ["call_depth_exceeded"]);
});

Deno.test("a workflow that calls itself is refused for want of a version to call", async () => {
  // A version is immutable and published before anything can name it, so a
  // definition cannot hold its own id; a loop of versions is cut by depth.
  const loopA = {
    ...base,
    steps: [{ id: "again", call: { workflow: MIDDLE } }],
  };
  const loopB = { ...base, steps: [{ id: "back", call: { workflow: TOP } }] };
  const loopTop = {
    ...base,
    steps: [{ id: "away", call: { workflow: MIDDLE } }],
  };
  const result = await compile(
    parent([{ id: "run", call: { workflow: TOP } }]),
    { [TOP]: loopA, [MIDDLE]: loopB, [LEAF]: loopTop },
  );
  assertEquals(codes(result), ["call_depth_exceeded"]);
});

Deno.test("a child that does not compile makes the call fail, naming the call", async () => {
  const broken = { ...base, steps: [{ id: "oops", uses: "no.such.action" }] };
  const result = await compile(
    parent([{ id: "research", call: { workflow: CHILD } }]),
    {
      [CHILD]: broken,
    },
  );
  assertEquals(codes(result), ["call_child_invalid"]);
});

Deno.test("a call inside a loop gets the loop's qualified ids", async () => {
  const result = await compile(
    {
      ...base,
      steps: [{ id: "prepare", uses: "workflow.noop", with: {} }, {
        id: "each",
        needs: ["prepare"],
        forEach: {
          items: "$step.prepare.cases",
          max: 3,
          as: "item",
          steps: [{
            id: "research",
            call: { workflow: CHILD, with: { topic: "$each.item" } },
          }],
        },
      }],
    },
    { [CHILD]: child },
  );
  assert(result.ok, JSON.stringify(codes(result)));
  assert(
    result.plan.steps.some((s) => s.qualifiedId === "each.research.write"),
    JSON.stringify(result.plan.steps.map((s) => s.qualifiedId)),
  );
});

Deno.test("a child's approvals and waits come with it, and count in the caller's worst case", async () => {
  const waiting = {
    ...base,
    steps: [
      { id: "pause", wait: { duration: "90s" } },
      { id: "work", needs: ["pause"], uses: "workflow.noop", with: {} },
    ],
  };
  const plain = await compile(
    parent([{ id: "go", uses: "workflow.noop", with: {} }]),
    {},
  );
  const called = await compile(
    parent([{ id: "run", call: { workflow: CHILD } }]),
    { [CHILD]: waiting },
  );
  assert(plain.ok && called.ok, JSON.stringify(codes(called)));
  assert(called.plan.steps.some((s) => s.kind === "wait"));
  assert(called.plan.worstCase.timeMs > plain.plan.worstCase.timeMs);
});

Deno.test("declared outputs must name a step that exists", async () => {
  const result = await compile(
    {
      ...base,
      outputs: { summary: "$step.nope.summary" },
      steps: [{ id: "write", uses: "workflow.noop", with: {} }],
    },
    {},
  );
  assertEquals(result.ok, false);
  const none = await compile(
    {
      ...base,
      outputs: { summary: "$input.x" },
      steps: [{ id: "write", uses: "workflow.noop", with: {} }],
    },
    {},
  );
  assertEquals(codes(none), ["workflow_outputs_invalid"]);
});

Deno.test("a document with no calls and no outputs keeps the digest it always had", async () => {
  const plain = {
    ...base,
    inputs: {},
    steps: [{ id: "go", uses: "workflow.noop", with: {} }],
  };
  const withOutputsKey = await compile(plain, {});
  const without = await compileWorkflowDocument(plain);
  assert(withOutputsKey.ok && without.ok);
  assertEquals(withOutputsKey.digest, without.digest);
});
