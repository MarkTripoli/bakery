import { assertEquals, assertThrows } from "@std/assert";
import {
  AsyncFormSchema,
  asyncStatusOf,
  handleOf,
  readAsyncForm,
  valueAtPath,
} from "../../apps/server/src/modules/mcp/async-form.ts";

// #439: the declaration an Admin makes for an asynchronous tool, and how a
// job's answers are read against it.

const form = AsyncFormSchema.parse({
  handlePath: "job.id",
  handleArgument: "jobId",
  statusPath: "job.status",
  doneValues: ["succeeded"],
  failedValues: ["failed"],
});

Deno.test("a declaration takes its defaults and refuses anything it does not name", () => {
  assertEquals(form.pollEveryMs, 15_000);
  assertEquals(
    AsyncFormSchema.parse({ ...form, failedValues: undefined }).failedValues,
    [],
  );
  for (
    const bad of [
      { ...form, extra: true },
      { ...form, handlePath: "" },
      { ...form, handlePath: "job..id" },
      { ...form, handlePath: "job[0].id" },
      { ...form, statusPath: "$.status" },
      { ...form, handleArgument: "job id" },
      { ...form, doneValues: [] },
      { ...form, doneValues: Array.from({ length: 9 }, (_, i) => `s${i}`) },
      { ...form, pollEveryMs: 999 },
      { ...form, pollEveryMs: 600_001 },
      { ...form, pollEveryMs: 1500.5 },
      { ...form, failedValues: ["succeeded"] },
    ]
  ) {
    assertEquals(AsyncFormSchema.safeParse(bad).success, false);
  }
});

Deno.test("a stored declaration is read back, and one that is not valid is refused rather than guessed", () => {
  assertEquals(readAsyncForm(null), null);
  assertEquals(readAsyncForm(undefined), null);
  assertEquals(readAsyncForm(form), form);
  assertThrows(() => readAsyncForm({ handlePath: "job.id" }));
});

Deno.test("a path reads fields only, and a missing step is undefined", () => {
  const answer = { job: { id: "j", status: "running", list: [1] } };
  assertEquals(valueAtPath(answer, "job.id"), "j");
  assertEquals(valueAtPath(answer, "job.nope"), undefined);
  assertEquals(valueAtPath(answer, "job.id.deeper"), undefined);
  // Arrays are not walked, and inherited names are not fields.
  assertEquals(valueAtPath(answer, "job.list.0"), undefined);
  assertEquals(valueAtPath(answer, "job.constructor"), undefined);
  assertEquals(valueAtPath(null, "job"), undefined);
});

Deno.test("a handle is a short string or a whole number and nothing else", () => {
  assertEquals(handleOf({ job: { id: "j-1" } }, "job.id"), "j-1");
  assertEquals(handleOf({ job: { id: 42 } }, "job.id"), 42);
  for (
    const answer of [
      { job: { id: "" } },
      { job: { id: 1.5 } },
      { job: { id: true } },
      { job: { id: { nested: 1 } } },
      { job: { id: "x".repeat(513) } },
      { job: {} },
      {},
    ]
  ) {
    assertEquals(handleOf(answer, "job.id"), null);
  }
});

Deno.test("a status is done or failed only when the Admin listed it; anything else is still running", () => {
  const at = (status: unknown) => asyncStatusOf({ job: { status } }, form);
  assertEquals(at("succeeded"), "done");
  assertEquals(at("failed"), "failed");
  for (const other of ["running", "SUCCEEDED", "", null, undefined, {}, []]) {
    assertEquals(at(other), "running");
  }
  assertEquals(asyncStatusOf({}, form), "running");
  assertEquals(asyncStatusOf(null, form), "running");
  // A number or a boolean status is compared as text.
  const numeric = AsyncFormSchema.parse({
    ...form,
    doneValues: ["1"],
    failedValues: ["0"],
  });
  assertEquals(asyncStatusOf({ job: { status: 1 } }, numeric), "done");
  assertEquals(asyncStatusOf({ job: { status: 0 } }, numeric), "failed");
});
