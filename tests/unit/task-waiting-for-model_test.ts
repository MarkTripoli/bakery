import { assertEquals } from "@std/assert";
import {
  expiryOutcome,
  fallbackLines,
  waitingLines,
} from "../../apps/web/src/pages/task-waiting/waiting-for-model.ts";
import type { RunRequestResponse } from "../../apps/web/src/api/client.ts";

const ask = (
  name: string,
  extra: Partial<RunRequestResponse> = {},
): RunRequestResponse => ({
  id: crypto.randomUUID(),
  runId: "00000000-0000-4000-8000-000000000002",
  stepKey: "build.ask",
  questionId: null,
  artifactVersionId: null,
  intent: "review",
  recipient: { principalId: crypto.randomUUID(), displayName: name },
  askedBy: null,
  askedByKind: "workflow",
  note: null,
  neededBy: null,
  status: "open",
  expiresAt: "2026-02-08T00:00:00.000Z",
  ownerFallback: false,
  fallbackForName: null,
  audience: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  version: 1,
  nextAsk: null,
  passedOn: false,
  ...extra,
});

const due = "2026-02-02T00:00:00.000Z";

Deno.test("a waiting step says who, and who is asked next", () => {
  assertEquals(waitingLines([ask("Dana"), ask("Lee")]).map((l) => l.kind), [
    "waiting",
  ]);
  const [line] = waitingLines([
    ask("Dana", { nextAsk: { dueAt: due, askedAt: null, who: null } }),
  ]);
  assertEquals(line.kind === "next" && [line.next, line.dueAt], [null, due]);
});

Deno.test("a passed on step names both rounds and when", () => {
  const asked = "2026-02-02T00:05:00.000Z";
  const [line] = waitingLines([
    ask("Dana", { nextAsk: { dueAt: due, askedAt: asked, who: "Lee" } }),
    ask("Lee", { passedOn: true, createdAt: asked }),
  ]);
  assertEquals(
    line.kind === "passedOn" && [line.first, line.next, line.askedAt],
    [["Dana"], ["Lee"], asked],
  );
});

Deno.test("expiry is said only when nobody answered", () => {
  assertEquals(
    waitingLines([ask("Dana", { status: "expired" })]).map((l) => l.kind),
    ["expired"],
  );
  assertEquals(
    waitingLines([
      ask("Dana", { status: "expired" }),
      ask("Lee", { status: "handled" }),
    ]),
    [],
  );
  assertEquals(waitingLines([ask("Dana", { intent: "fyi" })]), []);
});

Deno.test("a name that was not found names the owner asked instead", () => {
  assertEquals(
    fallbackLines([ask("Sam", { fallbackForName: "Design reviewers" })]),
    [{ name: "Design reviewers", owner: "Sam" }],
  );
});

Deno.test("an earlier round of the same step does not speak for the latest", () => {
  const later = "2026-02-09T00:00:00.000Z";
  assertEquals(
    waitingLines([
      ask("Dana", { status: "handled" }),
      ask("Dana", { status: "expired", createdAt: later }),
    ]).map((l) => l.kind),
    ["expired"],
  );
  assertEquals(
    waitingLines([
      ask("Lee", { passedOn: true, status: "handled" }),
      ask("Dana", { createdAt: later }),
    ]).map((l) => l.kind),
    ["waiting"],
  );
});

Deno.test("expiry says whether the workflow went on", () => {
  const step = (status: "completed" | "waiting", iteration = 0) => ({
    stepKey: "build.ask",
    iteration,
    status,
  });
  assertEquals(expiryOutcome([], "build.ask"), "expired");
  assertEquals(expiryOutcome([step("waiting")], "build.ask"), "expiredStuck");
  assertEquals(
    expiryOutcome([step("waiting"), step("completed", 1)], "build.ask"),
    "expiredContinued",
  );
});

Deno.test("did not answer names only the round the next ask followed", () => {
  const first = "2026-02-02T00:05:00.000Z";
  const second = "2026-02-04T00:05:00.000Z";
  const [line] = waitingLines([
    ask("Lee", { passedOn: true, createdAt: second }),
    ask("Vic", {
      createdAt: "2026-02-03T00:00:00.000Z",
      nextAsk: { dueAt: due, askedAt: second, who: "Lee" },
    }),
    ask("Sam", { passedOn: true, createdAt: first, status: "handled" }),
    ask("Dana", {
      status: "handled",
      nextAsk: { dueAt: due, askedAt: first, who: "Sam" },
    }),
  ]);
  assertEquals(
    line.kind === "passedOn" && [line.first, line.next, line.askedAt],
    [["Vic"], ["Lee"], second],
  );
});

Deno.test("one missing name is said once", () => {
  const missing = { fallbackForName: "Design reviewers" };
  assertEquals(
    fallbackLines([
      ask("Sam", missing),
      ask("Sam", { ...missing, stepKey: "build.other" }),
    ]).length,
    1,
  );
});
