import { assert, assertEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  type WorkflowSemanticDocument,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import {
  type ActionDispatch,
  nextStepWithLoops,
  type StepRecord,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  compiled,
  completed,
  drive,
  noop,
  type Step,
  workflow,
} from "../helpers/workflow-interpreter.ts";

const ARTIFACT_VERSION_ID = "00000000-0000-4000-8000-0000000000b1";

const notify = (extra: Record<string, unknown> = {}): Step => ({
  id: "notify",
  uses: "people.tag",
  with: {
    intent: "review",
    recipientRunRole: "starter",
    artifactVersionId: ARTIFACT_VERSION_ID,
    wait: true,
    ...extra,
  },
});

async function withTags(steps: Step[]): Promise<WorkflowSemanticDocument> {
  const result = await compileWorkflowDocument(workflow(steps), {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.document;
}

const needsHuman: StepRecord = { status: "needs_human" };

Deno.test("a waiting step that reports needs_human halts the run needs_human and nothing after it runs", async () => {
  const document = await withTags([notify(), noop("after")]);
  const { trace, next } = drive(
    document,
    (step) => step.id === "notify" ? needsHuman : completed(),
  );
  assertEquals(trace, ["notify"]);
  assertEquals(next, { kind: "halted", outcome: "needs_human", key: "notify" });
});

Deno.test("a waiting step that continues on expiry completes expired, so the next step runs and a condition can branch on it", async () => {
  const document = await withTags([
    notify({ onExpiry: "continue" }),
    {
      id: "decide",
      branch: {
        when: '$step.notify.outcome == "expired"',
        then: [noop("chase")],
        else: [noop("merge")],
      },
    },
    noop("after"),
  ]);
  const { trace, next } = drive(
    document,
    (step) =>
      step.id === "notify"
        ? completed({ outcome: "expired", asked: 1 })
        : completed(),
  );
  assertEquals(trace, ["notify", "decide.chase", "after"]);
  assertEquals(next, { kind: "finished" });
});

Deno.test("needs_human inside a repeat ends the run instead of becoming the repeat's outcome", async () => {
  const document = await compiled([
    {
      id: "loop",
      repeat: {
        max: 3,
        seed: { currentCandidate: { n: 0 } },
        until: "$repeat.currentCandidate.n >= 2",
        steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
        outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
      },
    },
    noop("after"),
  ]);
  const { trace, next } = drive(document, () => needsHuman);
  assertEquals(trace, ["loop@1.bump"]);
  assertEquals(next, {
    kind: "halted",
    outcome: "needs_human",
    key: "loop@1.bump",
  });
});

Deno.test("needs_human inside a forEach ends the run instead of becoming the loop's outcome", async () => {
  const document = await compiled([
    noop("prepare"),
    {
      id: "each",
      forEach: {
        items: "$step.prepare.cases",
        max: 5,
        as: "case",
        steps: [noop("visit", { with: { item: "$each.case" } })],
      },
    },
    noop("after"),
  ]);
  const { trace, next } = drive(
    document,
    (step) =>
      step.id === "prepare" ? completed({ cases: ["a", "b"] }) : needsHuman,
    {},
    nextStepWithLoops,
  );
  assertEquals(trace, ["prepare", "each@1.visit"]);
  assertEquals(next, {
    kind: "halted",
    outcome: "needs_human",
    key: "each@1.visit",
  });
});

Deno.test("a step that fails inside a repeat is still the repeat's outcome, unchanged", async () => {
  const document = await compiled([
    {
      id: "loop",
      repeat: {
        max: 3,
        seed: { currentCandidate: { n: 0 } },
        until: "$repeat.currentCandidate.n >= 2",
        steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
        outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
      },
    },
    noop("after", { with: { o: "$step.loop.outcome" } }),
  ]);
  const { trace, dispatched, next } = drive(
    document,
    (step) => step.id === "bump" ? { status: "failed" } : completed(),
  );
  assertEquals(trace, ["loop@1.bump", "after"]);
  assertEquals((dispatched[1] as ActionDispatch).input, { o: "failed" });
  assertEquals(next, { kind: "finished" });
});

Deno.test("a step that does not wait completes as before and the run goes on", async () => {
  const document = await withTags([
    {
      id: "notify",
      uses: "people.tag",
      with: { intent: "fyi", recipientRunRole: "starter" },
    },
    noop("after"),
  ]);
  const { trace, next } = drive(
    document,
    (step) =>
      step.id === "notify"
        ? completed({ outcome: "sent", asked: 1 })
        : completed(),
  );
  assertEquals(trace, ["notify", "after"]);
  assertEquals(next, { kind: "finished" });
});
