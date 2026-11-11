import { assertEquals, assertNotEquals } from "@std/assert";
import {
  classifyFailure,
  clearIntent,
  composerIntentKey,
  type ComposerSubmission,
  type IntentStore,
  loadIntent,
  runIdempotencyKey,
  saveIntent,
  startRunIntentKey,
  taskIdempotencyKey,
} from "../../apps/web/src/pages/task-composer-intent.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const principalId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const repositoryId = "00000000-0000-4000-8000-000000000004";
const profileId = "00000000-0000-4000-8000-000000000005";
const firstIntent = "11111111-1111-4111-8111-111111111111";
const secondIntent = "22222222-2222-4222-8222-222222222222";

class MemoryStore implements IntentStore {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const submission: ComposerSubmission = {
  task: {
    applicationId: taskId,
    repositoryId,
    repositoryProfileId: profileId,
    taskType: "feature",
    title: "Add onboarding",
    description: "Frozen at the first send.",
  },
  run: {
    presetId: "fixed-coding",
    repositoryProfileId: profileId,
    executionMode: "repository",
    budgetLimitUsd: "5.00",
  },
};

Deno.test("composer intent keys are scoped to organization and principal", () => {
  assertEquals(
    composerIntentKey(organizationId, principalId),
    `bakery.taskComposer.intent:${organizationId}:${principalId}`,
  );
  assertNotEquals(
    composerIntentKey(organizationId, principalId),
    composerIntentKey(organizationId, taskId),
  );
  assertNotEquals(
    composerIntentKey(organizationId, principalId),
    composerIntentKey(taskId, principalId),
  );
  assertEquals(
    startRunIntentKey(organizationId, principalId, taskId),
    `bakery.taskStartRun.intent:${organizationId}:${principalId}:${taskId}`,
  );
});

Deno.test("task and run idempotency keys derive from one intent", () => {
  assertEquals(taskIdempotencyKey(firstIntent), `${firstIntent}:task`);
  assertEquals(runIdempotencyKey(firstIntent), `${firstIntent}:run`);
});

Deno.test("an intent is minted once and survives a reload with its frozen bodies", () => {
  const store = new MemoryStore();
  const key = composerIntentKey(organizationId, principalId);
  const first = loadIntent<ComposerSubmission>(store, key, () => firstIntent);
  assertEquals(first, { intent: firstIntent, submission: null });
  assertEquals(store.values.size, 1);

  // A second open of the same draft reuses the stored intent, never remints.
  const reopened = loadIntent<ComposerSubmission>(
    store,
    key,
    () => secondIntent,
  );
  assertEquals(reopened.intent, firstIntent);

  saveIntent(store, key, { intent: firstIntent, submission });
  const reloaded = loadIntent<ComposerSubmission>(
    store,
    key,
    () => secondIntent,
  );
  assertEquals(reloaded, { intent: firstIntent, submission });
});

Deno.test("another principal or organization gets its own intent", () => {
  const store = new MemoryStore();
  const mine = loadIntent(
    store,
    composerIntentKey(organizationId, principalId),
    () => firstIntent,
  );
  const theirs = loadIntent(
    store,
    composerIntentKey(organizationId, taskId),
    () => secondIntent,
  );
  assertEquals(mine.intent, firstIntent);
  assertEquals(theirs.intent, secondIntent);
  assertEquals(store.values.size, 2);
});

Deno.test("clearing on success or discard makes the next draft mint a new intent", () => {
  const store = new MemoryStore();
  const key = composerIntentKey(organizationId, principalId);
  loadIntent(store, key, () => firstIntent);
  saveIntent(store, key, { intent: firstIntent, submission });
  clearIntent(store, key);
  assertEquals(store.getItem(key), null);
  assertEquals(
    loadIntent<ComposerSubmission>(store, key, () => secondIntent).intent,
    secondIntent,
  );
});

Deno.test("a damaged or foreign stored value is replaced, not trusted", () => {
  const store = new MemoryStore();
  const key = composerIntentKey(organizationId, principalId);
  for (
    const stored of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ intent: "../etc/passwd", submission: null }),
      JSON.stringify({ submission: {} }),
    ]
  ) {
    store.setItem(key, stored);
    assertEquals(
      loadIntent<ComposerSubmission>(store, key, () => firstIntent),
      { intent: firstIntent, submission: null },
    );
  }
});

Deno.test("blocked or missing storage degrades to an in-memory intent", () => {
  const blocked: IntentStore = {
    getItem() {
      throw new DOMException("denied", "SecurityError");
    },
    setItem() {
      throw new DOMException("denied", "SecurityError");
    },
    removeItem() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const key = composerIntentKey(organizationId, principalId);
  assertEquals(loadIntent(blocked, key, () => firstIntent).intent, firstIntent);
  assertEquals(
    loadIntent(undefined, key, () => firstIntent).intent,
    firstIntent,
  );
  clearIntent(blocked, key);
  clearIntent(undefined, key);
});

Deno.test("failures that leave the outcome open are replayed; the rest are definitive", () => {
  const problem = (status: number, code: string, retryable = false) => ({
    kind: "problem" as const,
    problem: { status, code, retryable },
  });
  assertEquals(classifyFailure({ kind: "network" }), "unknown");
  assertEquals(
    classifyFailure({ kind: "invalid-response", status: 201 }),
    "unknown",
  );
  assertEquals(
    classifyFailure(problem(409, "IDEMPOTENCY_IN_FLIGHT", true)),
    "unknown",
  );
  assertEquals(
    classifyFailure(problem(503, "DEPENDENCY_UNAVAILABLE")),
    "unknown",
  );
  assertEquals(classifyFailure(problem(408, "TIMEOUT")), "unknown");
  assertEquals(classifyFailure(problem(403, "AUTH_FORBIDDEN")), "forbidden");
  assertEquals(
    classifyFailure(problem(409, "STATE_CONFLICT")),
    "state-conflict",
  );
  assertEquals(
    classifyFailure(problem(412, "PRECONDITION_FAILED")),
    "conflict",
  );
  assertEquals(classifyFailure(problem(422, "UNPROCESSABLE_ENTITY")), "error");
});
