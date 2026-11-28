import { assertEquals } from "@std/assert";
import {
  nodeIdAt,
  problemSentence,
  problemsOf,
  SKILL_PROBLEM_SENTENCE,
  stepProblemLine,
  stepProblemLines,
  unboundActionsOf,
  type ValidationProblem,
  withoutUnboundAgent,
} from "../../apps/web/src/pages/library/editor-validation.ts";

const problem = (
  path: string,
  message = "That is not right.",
): ValidationProblem => ({ path, code: "rejected", message });

const GROUPED = {
  steps: [
    {
      id: "flow",
      steps: [{ id: "brief" }, { id: "check", with: { items: [{ id: "x" }] } }],
    },
    { id: "repair", repeat: { max: 2, steps: [{ id: "repair_check" }] } },
  ],
};

Deno.test("a pointer names the deepest node it points into", () => {
  assertEquals(nodeIdAt("/steps/0/steps/1/with", GROUPED), "check");
  assertEquals(nodeIdAt("/steps/0/steps/1/with/items/0/id", GROUPED), "check");
  assertEquals(nodeIdAt("/steps/0", GROUPED), "flow");
  assertEquals(
    nodeIdAt("/steps/1/repeat/steps/0/uses", GROUPED),
    "repair_check",
  );
});

Deno.test("a pointer that names no node names none", () => {
  for (
    const path of [
      "",
      "/steps",
      "/name",
      "/steps/uses",
      "/steps/-1",
      "/steps/01",
    ]
  ) assertEquals(nodeIdAt(path, GROUPED), null, path);
});

Deno.test("problems sort into their node, the workflow and the undrawn", () => {
  const sorted = problemsOf([
    problem("/steps/0/steps/1/uses"),
    problem(""),
    problem("/steps/0/steps/1/with", "Two messages on the same step."),
    problem("/name"),
    problem("/steps/9/uses"),
  ], GROUPED);
  assertEquals(sorted.workflow.length, 2);
  assertEquals(sorted.byStep.get("check")?.length, 2);
  assertEquals(sorted.byStep.has("brief"), false);
  assertEquals(sorted.unmapped.length, 1);
});

Deno.test("a step's line is its first sentence, with no count", () => {
  assertEquals(stepProblemLine([]), null);
  // A code with no written sentence falls back to the one sentence we always
  // have, never to the validator's own message (#67 UX ruling 6932934119).
  assertEquals(
    stepProblemLine([problem("/steps/0", "One.")]),
    "This step has a problem. Open View as code to see the detail.",
  );
  // A code the ruling wrote a sentence for shows that sentence.
  assertEquals(
    stepProblemLine([{
      path: "/steps/0",
      code: "action_not_executable",
      message: "validator text",
    }]),
    "This kind of step cannot run yet. Delete it or put another step in its " +
      "place.",
  );
  // The card and the list show one sentence; how many more there are is the
  // problems chip's job, not a "(+1)" glued to the end of a sentence (#67 UX
  // ruling 6932934119 fix 1).
  assertEquals(
    stepProblemLine([
      problem("/steps/0", "One."),
      problem("/steps/0/x", "Two."),
    ]),
    "This step has a problem. Open View as code to see the detail.",
  );
  // A step with several problems still names all of them for the panel, which
  // is why the first-sentence line and the full list are separate functions.
  assertEquals(
    stepProblemLines([
      problem("/steps/0", "One."),
      problem("/steps/0/x", "Two."),
    ]).length,
    2,
  );
});

Deno.test("the three reasons a skill needs a choice read as one sentence, and it is not the fallback", () => {
  for (
    const code of [
      "step_skill_slot_open",
      "step_skill_stopped",
      "step_skill_unavailable",
    ]
  ) {
    assertEquals(problemSentence(code), SKILL_PROBLEM_SENTENCE);
  }
  assertEquals(SKILL_PROBLEM_SENTENCE, "A skill on this step needs a choice.");
  // A step with a skill code and a step setting problem keeps both lines, in report order.
  assertEquals(
    stepProblemLines([
      { path: "/steps/1/skills", code: "step_skill_slot_open", message: "x" },
      { path: "/steps/1/uses", code: "step_skill_stopped", message: "x" },
    ]).length,
    2,
  );
});

Deno.test("an unbound agent is advice: it leaves the problems and names its actions", () => {
  const warning = {
    path: "/steps/1/steps/0/uses",
    code: "model_agent_unbound",
    message: "x",
  };
  const real = problem("/steps/0");
  assertEquals(withoutUnboundAgent([warning, real]), [real]);
  const definition = {
    steps: [{ uses: "task.brief" }, { steps: [{ uses: "agent.freeform" }] }],
  };
  assertEquals([...unboundActionsOf([warning, real], definition)], [
    "agent.freeform",
  ]);
  assertEquals(unboundActionsOf([real], definition).size, 0);
});
