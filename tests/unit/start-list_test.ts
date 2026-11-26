import { assertEquals } from "@std/assert";
import {
  WORKFLOW_START_EVENT_KINDS,
  WorkflowStartsSchema,
} from "../../packages/contracts/src/workflow-starts.ts";
import { neutralFieldsOf } from "../../apps/server/src/modules/integrations/neutral-events.ts";
import {
  chosenRepository,
  eventRepositoryId,
  inputLabel,
  newStart,
  otherFilters,
  savedStart,
  startNeeds,
  startProblems,
  startsOfVersion,
  toEvent,
  toSchedule,
  withBriefInput,
  withBudget,
  withRepository,
  withTextInput,
} from "../../apps/web/src/pages/library/start-list.ts";
import {
  editorReducer,
  editorStateOf,
} from "../../apps/web/src/pages/library/editor-state.ts";

const REPOSITORY = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "acme/api",
  eventRepositoryId: 42,
};
const BY_NAME = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "acme/web",
  eventRepositoryId: null,
};
const NEEDS = startNeeds({
  inputs: {
    repositoryId: { type: "uuid", required: true },
    brief: { type: "TaskBrief", required: true },
    note: { type: "string", required: false },
    count: { type: "integer", required: true },
  },
});

Deno.test("only required inputs become fields, each with the field it needs", () => {
  assertEquals(NEEDS.map((need) => [need.name, need.kind]), [
    ["repositoryId", "repository"],
    ["brief", "brief"],
    ["count", "unsupported"],
  ]);
});

Deno.test("a new start is valid for the contract and takes a free id", () => {
  const first = newStart([]);
  const second = newStart([first]);
  assertEquals([first.id, second.id], ["start-1", "start-2"]);
  assertEquals(WorkflowStartsSchema.safeParse([first, second]).success, true);
  assertEquals(newStart([second]).id, "start-1");
});

Deno.test("every event kind the editor offers is one the server can fire", () => {
  for (const kind of WORKFLOW_START_EVENT_KINDS) {
    assertEquals(neutralFieldsOf(kind)?.repositoryId, "number", kind);
  }
});

Deno.test("a start lists each missing input until it is filled", () => {
  const empty = newStart([]);
  assertEquals(
    startProblems([empty], NEEDS).map((problem) => problem.kind),
    ["repository", "title", "unsupported"],
  );
  const filled = withBriefInput(
    withRepository(empty, NEEDS[0], REPOSITORY),
    "brief",
    { title: "Triage it", description: "" },
  );
  assertEquals(
    startProblems([filled], NEEDS).map((problem) => problem.kind),
    ["unsupported"],
  );
  assertEquals(filled.inputs, {
    repositoryId: REPOSITORY.id,
    brief: { title: "Triage it", description: "", taskType: "feature" },
  });
});

const NIGHTLY = {
  id: "nightly",
  on: { kind: "schedule", cron: "0 2 * * *", timezone: "Europe/London" },
} as const;

Deno.test("a schedule start needs a repository even when no input asks for one", () => {
  assertEquals(
    startProblems([NIGHTLY], []).map((one) => [one.kind, one.name]),
    [["repository", "repositoryId"]],
  );
  assertEquals(
    startProblems([NIGHTLY], NEEDS).map((one) => one.kind).includes("title"),
    true,
  );
  assertEquals(
    startProblems([toSchedule(NIGHTLY, NIGHTLY.on, REPOSITORY)], []),
    [],
  );
});

Deno.test("switching between a schedule and an event keeps the chosen repository", () => {
  const scheduled = toSchedule(newStart([]), NIGHTLY.on, REPOSITORY);
  assertEquals(scheduled.inputs?.repositoryId, REPOSITORY.id);
  const event = toEvent(
    scheduled,
    "work_item.opened",
    undefined,
    [REPOSITORY],
  );
  assertEquals(
    [event.inputs, event.on.kind === "event" && event.on.filter],
    [undefined, { repositoryId: 42 }],
  );
});

Deno.test("choosing a repository filters the events to it", () => {
  const chosen = withRepository(newStart([]), undefined, REPOSITORY);
  assertEquals(chosen.on.kind === "event" && chosen.on.filter, {
    repositoryId: 42,
  });
  assertEquals(
    chosenRepository(chosen, undefined, [REPOSITORY]),
    REPOSITORY.id,
  );
  assertEquals(otherFilters(chosen, [REPOSITORY]), []);
  assertEquals(otherFilters(chosen, []), ["repositoryId = 42"]);
  const any = withRepository(chosen, undefined, undefined);
  assertEquals(any.on.kind === "event" && any.on.filter, {});
});

Deno.test("a repository known only by name sets the input and no filter", () => {
  const chosen = withRepository(newStart([]), NEEDS[0], BY_NAME);
  assertEquals(chosen.on.kind === "event" && chosen.on.filter, {});
  assertEquals(chosenRepository(chosen, NEEDS[0], [BY_NAME]), BY_NAME.id);
  assertEquals(eventRepositoryId("acme/web"), null);
  assertEquals(eventRepositoryId("918273"), 918273);
});

Deno.test("clearing a field removes the input rather than saving an empty one", () => {
  const filled = withTextInput(newStart([]), "note", "hello");
  assertEquals(withTextInput(filled, "note", "  ").inputs, undefined);
  assertEquals(withBudget(filled, "", filled.budgetUsd).budgetUsd, undefined);
  assertEquals(withBudget(filled, "12.5", filled.budgetUsd).budgetUsd, 12.5);
  assertEquals(withBudget(filled, "-1", filled.budgetUsd).budgetTyped, "-1");
});

Deno.test("starts that cannot be read are listed as none", () => {
  assertEquals(startsOfVersion([{ id: "x" }]), []);
  assertEquals(startsOfVersion(undefined), []);
});

Deno.test("removing a start can be undone with the steps left alone", () => {
  const start = newStart([]);
  const held = editorStateOf([], [start]);
  const removed = editorReducer(held, { kind: "starts", starts: [] });
  assertEquals(removed.starts, []);
  assertEquals(editorReducer(removed, { kind: "undo" }).starts, [start]);
  assertEquals(
    editorReducer(held, { kind: "starts", starts: [start] }),
    held,
  );
});

Deno.test("a spend limit that is not an amount is kept as typed, not saved", () => {
  const start = newStart([]);
  for (const typed of ["$25", "5,00", "-1", "abc", "20000", "1e3"]) {
    const next = withBudget(start, typed, start.budgetUsd);
    assertEquals([next.budgetUsd, next.budgetTyped], [5, typed], typed);
    assertEquals(savedStart(next), start);
    assertEquals(startProblems([next], []).map((one) => one.kind), ["budget"]);
  }
  assertEquals(withBudget(withBudget(start, "$", 5), "2.50", 5).budgetUsd, 2.5);
  assertEquals(
    "budgetTyped" in withBudget(withBudget(start, "$", 5), "", 5),
    false,
  );
});

Deno.test("a refused amount restores the limit the field started with", () => {
  const typing = withBudget(newStart([]), "2000", 5);
  assertEquals(withBudget(typing, "20000", 5).budgetUsd, 5);
  const none = withBudget(typing, "", 5);
  assertEquals(withBudget(none, "20000", none.budgetUsd).budgetUsd, undefined);
});

Deno.test("a refused amount typed into an empty field leaves it empty", () => {
  const empty = withBudget(newStart([]), "", 5);
  const halfTyped = withBudget(empty, "2000", undefined);
  assertEquals(halfTyped.budgetUsd, 2000);
  const refused = withBudget(halfTyped, "20000", undefined);
  assertEquals(
    [refused.budgetUsd, refused.budgetTyped],
    [undefined, "20000"],
  );
});

Deno.test("an input is labelled with words, not its raw name", () => {
  assertEquals(
    ["instructions", "release_notes", "targetBranch"].map(inputLabel),
    ["Instructions", "Release notes", "Target branch"],
  );
});
