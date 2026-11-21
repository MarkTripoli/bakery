/**
 * Slice 1 of #406: a workflow version's starts are data, validated, and stored
 * beside the specification so the digest a version was published under does not
 * move when a start is added.
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  NO_STARTS,
  WORKFLOW_START_FILTER_MAX_FIELDS,
  WORKFLOW_START_MAX,
  WorkflowStartSchema,
  WorkflowStartsSchema,
} from "@bakery/contracts/workflow-starts";

Deno.test("a version that names no start starts nothing", () => {
  assertEquals(WorkflowStartsSchema.parse(NO_STARTS), []);
  assertEquals(NO_STARTS.length, 0);
});

Deno.test("an event start matches a neutral kind and an equality filter", () => {
  const start = WorkflowStartSchema.parse({
    id: "on-ready",
    on: {
      kind: "event",
      eventKind: "work_item.ready",
      filter: { container: "acme/web", priority: 3, urgent: true },
    },
  });
  assertEquals(start.on.kind, "event");
  assertEquals(start.id, "on-ready");
});

Deno.test("an empty filter matches every event of its kind", () => {
  const parsed = WorkflowStartSchema.safeParse({
    id: "all-ready",
    on: { kind: "event", eventKind: "work_item.ready", filter: {} },
  });
  assert(parsed.success);
});

Deno.test("a schedule start carries a cron expression and a zone", () => {
  const parsed = WorkflowStartSchema.safeParse({
    id: "nightly",
    on: { kind: "schedule", cron: "0 3 * * *", timezone: "Europe/Berlin" },
  });
  assert(parsed.success);
});

Deno.test("a start is data, never an expression", () => {
  // A filter value that is itself an object or an array is refused: a start can
  // compare a field to a scalar and nothing else, so no predicate can be hidden
  // in one.
  for (const filter of [{ a: { b: 1 } }, { a: [1, 2] }, { a: null }]) {
    const parsed = WorkflowStartSchema.safeParse({
      id: "smuggled",
      on: { kind: "event", eventKind: "work_item.ready", filter },
    });
    assertFalse(parsed.success, JSON.stringify(filter));
  }
});

Deno.test("a start refuses fields it does not know", () => {
  const parsed = WorkflowStartSchema.safeParse({
    id: "extra",
    on: {
      kind: "event",
      eventKind: "work_item.ready",
      filter: {},
      then: "anything",
    },
  });
  assertFalse(parsed.success);
});

Deno.test("a start identifier is lowercase letters, digits and hyphens", () => {
  for (const id of ["Nightly", "on ready", "", "-lead", "a".repeat(65)]) {
    const parsed = WorkflowStartSchema.safeParse({
      id,
      on: { kind: "event", eventKind: "work_item.ready", filter: {} },
    });
    assertFalse(parsed.success, id);
  }
  for (const id of ["a", "on-ready", "v2-start", "9lives"]) {
    const parsed = WorkflowStartSchema.safeParse({
      id,
      on: { kind: "event", eventKind: "work_item.ready", filter: {} },
    });
    assert(parsed.success, id);
  }
});

Deno.test("starts are unique by identifier within a version", () => {
  const start = {
    id: "on-ready",
    on: { kind: "event" as const, eventKind: "work_item.ready", filter: {} },
  };
  assertFalse(WorkflowStartsSchema.safeParse([start, start]).success);
  assert(
    WorkflowStartsSchema.safeParse([start, { ...start, id: "other" }]).success,
  );
});

Deno.test("a version carries at most the documented number of starts", () => {
  const start = (index: number) => ({
    id: `s-${index}`,
    on: { kind: "event" as const, eventKind: "work_item.ready", filter: {} },
  });
  assert(
    WorkflowStartsSchema.safeParse(
      Array.from({ length: WORKFLOW_START_MAX }, (_, index) => start(index)),
    ).success,
  );
  assertFalse(
    WorkflowStartsSchema.safeParse(
      Array.from(
        { length: WORKFLOW_START_MAX + 1 },
        (_, index) => start(index),
      ),
    ).success,
  );
});

Deno.test("a filter carries at most the documented number of fields", () => {
  const filter = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`f${index}`, index]),
    );
  assert(
    WorkflowStartSchema.safeParse({
      id: "wide",
      on: {
        kind: "event",
        eventKind: "work_item.ready",
        filter: filter(WORKFLOW_START_FILTER_MAX_FIELDS),
      },
    }).success,
  );
  assertFalse(
    WorkflowStartSchema.safeParse({
      id: "wider",
      on: {
        kind: "event",
        eventKind: "work_item.ready",
        filter: filter(WORKFLOW_START_FILTER_MAX_FIELDS + 1),
      },
    }).success,
  );
});
