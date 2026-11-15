import { assertEquals } from "@std/assert";
import {
  problemsOf,
  stepIndexOf,
  stepProblemLine,
  type ValidationProblem,
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

Deno.test("a step's line is its first message and how many more there are", () => {
  assertEquals(stepProblemLine([]), null);
  assertEquals(stepProblemLine([problem("/steps/0", "One.")]), "One.");
  assertEquals(
    stepProblemLine([
      problem("/steps/0", "One."),
      problem("/steps/0/x", "Two."),
    ]),
    "One. (+1)",
  );
});
