import { assertEquals } from "@std/assert";
import {
  problemSentence,
  problemsOf,
  SKILL_PROBLEM_SENTENCE,
  stepIndexOf,
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

Deno.test("a pointer names the step it points into", () => {
  assertEquals(stepIndexOf("/steps/2/uses"), 2);
  assertEquals(stepIndexOf("/steps/0"), 0);
  assertEquals(stepIndexOf("/steps/12/agentVersionId"), 12);
});

Deno.test("a pointer that names no single step names the workflow", () => {
  assertEquals(stepIndexOf(""), null);
  assertEquals(stepIndexOf("/steps"), null);
  assertEquals(stepIndexOf("/name"), null);
  assertEquals(stepIndexOf("/steps/uses"), null);
  assertEquals(stepIndexOf("/steps/-1"), null);
  assertEquals(stepIndexOf("/steps/01"), null);
  assertEquals(stepIndexOf("/steps/1/uses/2"), 1);
});

Deno.test("problems sort into their step and into the workflow", () => {
  const sorted = problemsOf([
    problem("/steps/1/uses"),
    problem(""),
    problem("/steps/1/agentVersionId", "Two messages or the same step."),
    problem("/name"),
  ]);
  assertEquals(sorted.workflow.length, 2);
  assertEquals(sorted.byStep.get(1)?.length, 2);
  assertEquals(sorted.byStep.has(0), false);
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
