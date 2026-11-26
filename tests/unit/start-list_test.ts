import { assertEquals } from "@std/assert";
import {
  WORKFLOW_START_EVENT_KINDS,
  WorkflowStartsSchema,
} from "../../packages/contracts/src/workflow-starts.ts";
import { neutralFieldsOf } from "../../apps/server/src/modules/integrations/neutral-events.ts";
import {
  chosenRepository,
  eventRepositoryId,
  newStart,
  otherFilters,
  startNeeds,
  startProblems,
  startsOfVersion,
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

Deno.test("a schedule start is never reported as needing inputs", () => {
  assertEquals(
    startProblems([{
      id: "nightly",
      on: { kind: "schedule", cron: "0 2 * * *", timezone: "Europe/London" },
    }], NEEDS),
    [],
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
  assertEquals(withBudget(filled, "").budgetUsd, undefined);
  assertEquals(withBudget(filled, "12.5").budgetUsd, 12.5);
  assertEquals(withBudget(filled, "-1").budgetUsd, undefined);
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
