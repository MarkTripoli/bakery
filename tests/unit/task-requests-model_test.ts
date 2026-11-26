import { assertEquals } from "@std/assert";
import {
  actionOf,
  orderedRequests,
  visibleRequests,
} from "../../apps/web/src/pages/task-requests/model.ts";
import type { RunRequestResponse } from "../../apps/web/src/api/client.ts";

const request = (
  extra: Partial<RunRequestResponse>,
): RunRequestResponse => ({
  id: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  stepKey: null,
  questionId: null,
  artifactVersionId: null,
  intent: "fyi",
  recipient: {
    principalId: "00000000-0000-4000-8000-000000000003",
    displayName: "Alex",
  },
  askedBy: null,
  askedByKind: "workflow",
  note: null,
  neededBy: null,
  status: "open",
  expiresAt: "2026-02-01T00:00:00.000Z",
  ownerFallback: false,
  fallbackForName: null,
  audience: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  ...extra,
});

Deno.test("each open request has the action its target allows", () => {
  const id = "00000000-0000-4000-8000-000000000009";
  assertEquals(
    [
      request({ intent: "approve", questionId: id }),
      request({ intent: "answer", questionId: id }),
      request({ intent: "review", artifactVersionId: id }),
      request({ intent: "take_over", stepKey: "build.implement" }),
      request({ intent: "fyi" }),
      request({ intent: "review" }),
    ].map(actionOf),
    ["approve", "answer", "review", "take_over", "fyi", "fyi"],
  );
});

Deno.test("a closed request offers nothing", () => {
  for (const status of ["answered", "handled", "expired", "withdrawn"]) {
    assertEquals(
      actionOf(request({ status: status as RunRequestResponse["status"] })),
      null,
      status,
    );
  }
});

Deno.test("what needs doing comes first, then news, then closed", () => {
  const ids = orderedRequests([
    request({ id: "news", createdAt: "2026-01-04T00:00:00.000Z" }),
    request({
      id: "old-open",
      intent: "review",
      artifactVersionId: "v",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    request({
      id: "closed",
      status: "expired",
      createdAt: "2026-01-03T00:00:00.000Z",
    }),
    request({
      id: "new-open",
      intent: "take_over",
      stepKey: "build",
      createdAt: "2026-01-02T00:00:00.000Z",
    }),
  ]).map((one) => one.id);
  assertEquals(ids, ["new-open", "old-open", "news", "closed"]);
});

Deno.test("every open request shows and only the latest closed ones", () => {
  const open = Array.from(
    { length: 8 },
    (_, at) => request({ id: `open-${at}` }),
  );
  const closed = Array.from(
    { length: 7 },
    (_, at) => request({ id: `closed-${at}`, status: "expired" }),
  );
  const shown = visibleRequests([...closed, ...open]);
  assertEquals(shown.filter((one) => one.status === "open").length, 8);
  assertEquals(shown.length, 13);
});
