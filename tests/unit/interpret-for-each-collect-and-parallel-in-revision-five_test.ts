import { assertEquals } from "@std/assert";
import {
  CURRENT_INTERPRETER_REVISION,
  INTERPRETER_REVISIONS,
  type JsonValue,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  compiled,
  completed,
  type Dispatch,
  driveMany,
  noop,
  workflow,
} from "../helpers/workflow-interpreter.ts";

const inputOf = (step: Dispatch): JsonValue =>
  step.kind === "action" ? step.input : null;

Deno.test("revision 5 collects parallel forEach results in item order rather than completion order", async () => {
  const document = await compiled([
    noop("prepare"),
    {
      id: "cases",
      forEach: {
        items: "$step.prepare.cases",
        max: 4,
        maxConcurrency: 2,
        as: "case",
        steps: [noop("work", {
          with: { item: "$each.case" },
          files: { read: ["inputs"], write: ["outputs"] },
        })],
        collect: { results: "$step.cases.work.echo" },
      },
    },
    noop("report", { with: { results: "$step.cases.results" } }),
  ]);
  const interpreter = INTERPRETER_REVISIONS["5"]!;
  const run = driveMany(
    document,
    (step) =>
      step.id === "prepare"
        ? completed({ cases: ["a", "b", "c"] })
        : completed({ echo: inputOf(step) }),
    {},
    { interpreter, pick: (running) => running.length - 1 },
  );

  assertEquals(CURRENT_INTERPRETER_REVISION, "5");
  assertEquals(run.maxRunning, 2);
  assertEquals(run.trace, [
    "prepare",
    "cases@1.work",
    "cases@2.work",
    "cases@3.work",
    "report",
  ]);
  assertEquals(inputOf(run.dispatched.at(-1)!), {
    results: [{ item: "a" }, { item: "b" }, { item: "c" }],
  });
  assertEquals(run.next, { kind: "finished" });
});

Deno.test("revision 5 stops fresh forEach iterations after a parallel failure", async () => {
  const document = await compiled([
    noop("prepare"),
    {
      id: "cases",
      forEach: {
        items: "$step.prepare.cases",
        max: 4,
        maxConcurrency: 2,
        as: "case",
        steps: [noop("work", {
          with: { item: "$each.case" },
          files: { read: ["inputs"], write: ["outputs"] },
        })],
      },
    },
    noop("report", {
      with: {
        iterations: "$step.cases.iterations",
        outcome: "$step.cases.outcome",
      },
    }),
  ]);
  const run = driveMany(
    document,
    (step) => {
      if (step.id === "prepare") {
        return completed({ cases: ["a", "b", "c", "d"] });
      }
      if (step.key === "cases@2.work") return { status: "failed" };
      return completed({ echo: inputOf(step) });
    },
    {},
    {
      interpreter: INTERPRETER_REVISIONS["5"]!,
      pick: (running) => running.length - 1,
    },
  );

  assertEquals(run.maxRunning, 2);
  assertEquals(run.trace, [
    "prepare",
    "cases@1.work",
    "cases@2.work",
    "report",
  ]);
  assertEquals(inputOf(run.dispatched.at(-1)!), {
    iterations: 1,
    outcome: "failed",
  });
  assertEquals(run.next, { kind: "finished" });
});

Deno.test("parallel forEach iterations cannot share a writable workspace", async () => {
  const unsafe = await compileWorkflowDocument(workflow([
    noop("prepare"),
    {
      id: "cases",
      forEach: {
        items: "$step.prepare.cases",
        max: 2,
        maxConcurrency: 2,
        as: "case",
        steps: [noop("work")],
      },
    },
  ]));
  assertEquals(
    unsafe.ok
      ? []
      : unsafe.diagnostics.map(({ path, code }) => ({ path, code })),
    [{
      path: "/steps/1/forEach/steps/0/files",
      code: "for_each_parallel_workspace_write",
    }],
  );

  await compiled([
    noop("prepare"),
    {
      id: "cases",
      forEach: {
        items: "$step.prepare.cases",
        max: 2,
        maxConcurrency: 2,
        as: "case",
        steps: [noop("work", {
          files: { read: ["inputs"], write: ["outputs"] },
        })],
      },
    },
  ]);
});
