import { assertEquals } from "@std/assert";
import {
  fallbackLines,
  waitingLines,
} from "../../apps/web/src/pages/task-waiting/waiting-for-model.ts";
import type { RunRequestListItem } from "../../apps/web/src/api/client.ts";

const ask = (
  name: string,
  extra: Partial<RunRequestListItem> = {},
): RunRequestListItem => ({
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
