import { assertEquals } from "@std/assert";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/compile.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import {
  approvalInput,
  approvalOfNode,
  approvalProblems,
  askedWho,
  NEW_APPROVAL,
} from "../../apps/web/src/pages/library/approval-step.ts";
import {
  definitionOf,
  editorReducer,
  editorStateOf,
  type EditorStep,
} from "../../apps/web/src/pages/library/editor-state.ts";

const DANA = "11111111-1111-4111-8111-111111111111";
const LEE = "22222222-2222-4222-8222-222222222222";
const PEOPLE = [
  { principalId: DANA, displayName: "Dana Okafor", active: true },
  { principalId: LEE, displayName: "Lee Park", active: false },
];

const ask = (approval = NEW_APPROVAL): EditorStep => ({
  id: "ask",
  uses: "human.approval",
  agentVersionId: null,
  skills: [],
  approval,
});

const compile = (step: unknown) =>
  compileWorkflowDocumentDetailed({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "x",
    description: "d",
    steps: [step],
  }, { catalog: defaultWorkflowCompilerCatalog() });

const savedStep = (definition: Record<string, unknown>) =>
  (definition.steps as Record<string, unknown>[])[0];

Deno.test("an Ask a person step saves only what differs from the defaults", () => {
  assertEquals(approvalInput(NEW_APPROVAL), null);
  assertEquals(
    savedStep(definitionOf({ steps: [] }, [ask()])),
    { id: "ask", uses: "human.approval" },
  );
  const filled = {
    prompt: "Ship the release?",
    audience: [DANA],
    allowRequestChanges: false,
    approveLabel: "Ship",
    rejectLabel: "Hold",
  };
  assertEquals(savedStep(definitionOf({ steps: [] }, [ask(filled)])).with, {
    ...filled,
  });
});

Deno.test("a filled step compiles, and one with no question is refused at the question", async () => {
  const filled = await compile(savedStep(definitionOf({ steps: [] }, [
    ask({ ...NEW_APPROVAL, prompt: "Merge $input.x once \$5 is paid?" }),
  ])));
  assertEquals(filled.result.ok, true);
  const empty = await compile(
    savedStep(definitionOf({ steps: [] }, [ask()])),
  );
  assertEquals(
    empty.result.ok ? [] : empty.result.diagnostics.map((one) => one.path),
    ["/steps/0/with/prompt"],
  );
});

Deno.test("what a person typed reads back as typed", () => {
  const typed = { ...NEW_APPROVAL, prompt: "$input.x is it?" };
  const node = savedStep(definitionOf({ steps: [] }, [ask(typed)]));
  assertEquals(approvalOfNode(node), typed);
});

Deno.test("a question written in code is not editable in the panel", () => {
  for (
    const input of [
      { prompt: "$plan.artifact" },
      { prompt: "Ok?", audience: ["@design-reviewers"] },
      { prompt: "Ok?", audience: "everyone" },
      { prompt: "Ok?", quorum: 2 },
      "$input.x",
    ]
  ) {
    assertEquals(approvalOfNode({ with: input }), null, JSON.stringify(input));
  }
});

Deno.test("an untouched step keeps its authored node, and an edit is one undo step", () => {
  const node = {
    id: "ask",
    uses: "human.approval",
    with: { prompt: "Ok?", allowRequestChanges: true },
  };
  const start = editorStateOf([ask(approvalOfNode(node)!)]);
  assertEquals(
    savedStep(definitionOf({ steps: [node] }, start.steps)),
    node,
  );
  const edited = editorReducer(start, {
    kind: "approval",
    id: "ask",
    approval: { ...start.steps[0].approval!, audience: [DANA] },
  });
  assertEquals(savedStep(definitionOf({ steps: [node] }, edited.steps)).with, {
    prompt: "Ok?",
    audience: [DANA],
  });
  assertEquals(edited.past.length, 1);
  assertEquals(
    editorReducer(edited, {
      kind: "approval",
      id: "ask",
      approval: edited.steps[0].approval!,
    }),
    edited,
  );
});

Deno.test("an empty question and a person who left are the two problems", () => {
  assertEquals(approvalProblems(NEW_APPROVAL, PEOPLE), [
    { field: "prompt", kind: "promptEmpty", name: "" },
  ]);
  assertEquals(
    approvalProblems(
      { ...NEW_APPROVAL, prompt: "Ok?", audience: [DANA, LEE] },
      PEOPLE,
    ),
    [{ field: "audience", kind: "notMember", name: "Lee Park" }],
  );
  assertEquals(
    approvalProblems(
      { ...NEW_APPROVAL, prompt: "Ok?", audience: [LEE] },
      null,
    ),
    [],
  );
});

Deno.test("the card names one person, the first and the rest, or the owner", () => {
  assertEquals(askedWho([], PEOPLE), { kind: "owner" });
  assertEquals(askedWho([DANA], PEOPLE), { kind: "one", name: "Dana Okafor" });
  assertEquals(askedWho([DANA, LEE], PEOPLE), {
    kind: "many",
    first: "Dana Okafor",
    others: 1,
  });
  assertEquals(askedWho([DANA, LEE], null), { kind: "count", count: 2 });
});
