import { assertEquals } from "@std/assert";
import {
  checkView,
  isBlocking,
  missingTools,
  outcomeOf,
} from "../../apps/web/src/pages/projects/check-state.ts";

const check = (
  id: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  template: "node.syntax.v1",
  required: true,
  status: "passed",
  reason: "verified",
  exitCode: null,
  outputDigest: null,
  durationMs: 5,
  ...over,
});
const observation = (
  checks: unknown[],
  readiness = "eligible",
  tools: unknown[] = [],
) =>
  ({
    id: "o",
    repositoryId: "r",
    profileId: "p",
    profileRevision: 1,
    profileDigest: "d",
    observationDigest: "d",
    baseSha: "s",
    payload: {
      checks,
      readiness,
      observedAt: "2026-01-01T00:00:00.000Z",
      host: { workerHostId: "h", os: "linux", architecture: "x64", tools },
    },
  }) as never;
const onboarding = (over: Record<string, unknown>) =>
  ({
    id: "i",
    repositoryId: "r",
    jobId: "j",
    status: "completed",
    profileId: "p",
    observationId: "o",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as never;
const base = {
  known: true,
  onboarding: null,
  readFailed: false,
  observation: null,
  observationFailed: false,
};

Deno.test("no known check is none; a read that failed is unreadable, never a guess", () => {
  assertEquals(checkView({ ...base, known: false }), { kind: "none" });
  assertEquals(checkView({ ...base, readFailed: true }), {
    kind: "unreadable",
  });
  assertEquals(checkView(base), { kind: "loading" });
});

Deno.test("queued and running are in progress; a failed refresh while running is unreadable", () => {
  assertEquals(
    checkView({ ...base, onboarding: onboarding({ status: "queued" }) }),
    { kind: "waiting", startedAt: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(
    checkView({ ...base, onboarding: onboarding({ status: "running" }) }),
    { kind: "running", startedAt: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(
    checkView({
      ...base,
      readFailed: true,
      onboarding: onboarding({ status: "running" }),
    }),
    { kind: "unreadable" },
  );
});

Deno.test("failed, cancelled and a completed check without a result are their own views", () => {
  assertEquals(
    checkView({ ...base, onboarding: onboarding({ status: "failed" }) }),
    { kind: "failed" },
  );
  assertEquals(
    checkView({ ...base, onboarding: onboarding({ status: "canceled" }) }),
    { kind: "canceled" },
  );
  assertEquals(
    checkView({ ...base, onboarding: onboarding({ observationId: null }) }),
    { kind: "unavailable" },
  );
});

Deno.test("a completed check waits for its result, and a result that cannot be read is unreadable", () => {
  assertEquals(checkView({ ...base, onboarding: onboarding({}) }), {
    kind: "loading",
  });
  assertEquals(
    checkView({ ...base, onboarding: onboarding({}), observationFailed: true }),
    { kind: "unreadable" },
  );
});

Deno.test("required checks decide Ready; optional ones never block", () => {
  const ready = outcomeOf(
    observation([
      check("a"),
      check("b", { required: false, status: "failed", reason: "exit_nonzero" }),
    ]),
  );
  assertEquals([ready.ready, ready.required, ready.blocking], [true, 1, 0]);
  const blocked = outcomeOf(
    observation([
      check("a", { status: "failed", reason: "exit_nonzero" }),
      check("b"),
    ], "blocked"),
  );
  assertEquals([blocked.ready, blocked.required, blocked.blocking], [
    false,
    2,
    1,
  ]);
});

Deno.test("the server's word is not trusted over the checks it lists", () => {
  const lying = outcomeOf(
    observation([check("a", { status: "failed", reason: "exit_nonzero" })]),
  );
  assertEquals(lying.ready, false);
  const cautious = outcomeOf(observation([check("a")], "blocked"));
  assertEquals(cautious.ready, false);
});

Deno.test("the tools a machine lacks are named in the order it listed them", () => {
  const host = {
    workerHostId: "h",
    os: "linux",
    architecture: "x64",
    tools: [
      { tool: "git", status: "available" },
      { tool: "deno", status: "missing" },
      { tool: "node", status: "missing" },
    ],
  } as unknown as Parameters<typeof missingTools>[0];
  assertEquals(missingTools(host), ["deno", "node"]);
  assertEquals(isBlocking(check("a", { status: "missing" }) as never), true);
  assertEquals(
    isBlocking(check("a", { required: false, status: "failed" }) as never),
    false,
  );
});
