import { assertEquals } from "@std/assert";
import {
  nameFromFile,
  problemsOf,
  readImport,
  whereOf,
} from "../../apps/web/src/pages/library/import-workflow.ts";

Deno.test("a pointer becomes a place a person can find", () => {
  assertEquals(whereOf(""), { kind: "whole" });
  assertEquals(whereOf("/steps/2/uses"), {
    kind: "step",
    number: 3,
    field: "uses",
  });
  assertEquals(whereOf("/steps/0"), { kind: "step", number: 1, field: null });
  assertEquals(whereOf("/agents/harness.implement"), {
    kind: "path",
    path: "agents.harness.implement",
  });
  assertEquals(
    problemsOf([{ path: "/steps/1/id", message: "A step id repeats." }]),
    [{
      where: { kind: "step", number: 2, field: "id" },
      code: "",
      message: "A step id repeats.",
    }],
  );
});

Deno.test("a file name becomes a name for the workflow", () => {
  assertEquals(nameFromFile("release-train-v3.yaml"), "Release train");
  assertEquals(nameFromFile("C:\\files\\our_flow.YML"), "Our flow");
  assertEquals(nameFromFile(".yaml"), "");
});

Deno.test("YAML and JSON definitions are read to plain data", async () => {
  const yaml = await readImport(
    "name: Release train\nsteps:\n  - id: brief\n    uses: task.brief\n  - id: review\n    uses: agent.review\n",
  );
  assertEquals(yaml.ok, true);
  if (yaml.ok) {
    assertEquals(yaml.steps, 2);
    assertEquals(yaml.name, "Release train");
  }
  const json = await readImport('{"steps":[{"id":"a","uses":"task.brief"}]}');
  assertEquals(json.ok && json.steps, 1);
  assertEquals(json.ok && json.name, null);
});

Deno.test("text the runtime would refuse is refused with where and why", async () => {
  const broken = await readImport("steps: [");
  assertEquals(broken.ok, false);
  if (!broken.ok) {
    assertEquals(broken.problems[0]?.where, { kind: "whole" });
    assertEquals(
      broken.problems[0]?.message,
      "The definition is not valid YAML 1.2.",
    );
  }
  const anchor = await readImport("a: &x 1\nb: *x\n");
  assertEquals(anchor.ok, false);
  const list = await readImport("- 1\n- 2\n");
  assertEquals(list.ok, false);
  const empty = await readImport("");
  assertEquals(empty.ok, false);
});

Deno.test("the action a step uses is read from the definition, since the checker never repeats it", () => {
  const definition = {
    steps: [{ id: "a", uses: "task.brief" }, { id: "b", uses: "nope.action" }],
  };
  const [problem, other] = problemsOf([
    {
      path: "/steps/1/uses",
      code: "action_unknown",
      message: "The action is not registered.",
    },
    {
      path: "/steps/0/id",
      code: "step_id_invalid",
      message: "A step id is invalid.",
    },
  ], definition);
  assertEquals(problem?.detail, "nope.action");
  assertEquals(problem?.code, "action_unknown");
  assertEquals(other?.detail, undefined);
  assertEquals(
    problemsOf([{ path: "/steps/9/uses", message: "x" }], definition)[0]
      ?.detail,
    undefined,
  );
  assertEquals(
    problemsOf([{ path: "/steps/0/uses", message: "x" }])[0]?.detail,
    undefined,
  );
});

Deno.test("a missing field is named by the last part of the pointer the checker reports it at", () => {
  const [inStep, top, whole, other] = problemsOf([
    {
      path: "/steps/0/id",
      code: "field_missing",
      message: "A required field is missing.",
    },
    {
      path: "/steps",
      code: "field_missing",
      message: "A required field is missing.",
    },
    {
      path: "",
      code: "field_missing",
      message: "A required field is missing.",
    },
    {
      path: "/steps/0/id",
      code: "step_id_invalid",
      message: "A step id is invalid.",
    },
  ]);
  assertEquals(inStep?.field, "id");
  assertEquals(inStep?.where, { kind: "step", number: 1, field: "id" });
  assertEquals(top?.field, "steps");
  assertEquals(whole?.field, undefined);
  assertEquals(other?.field, undefined);
});

Deno.test("a name the definition gives itself is cut without splitting an emoji", async () => {
  const name = "a".repeat(199) + "\u{1F35E}" + "tail";
  const read = await readImport(
    `name: "${name}"\nsteps:\n  - id: a\n    uses: task.brief\n`,
  );
  assertEquals(read.ok, true);
  if (read.ok) {
    assertEquals(read.name, "a".repeat(199));
    assertEquals((read.name ?? "").length <= 200, true);
  }
});
