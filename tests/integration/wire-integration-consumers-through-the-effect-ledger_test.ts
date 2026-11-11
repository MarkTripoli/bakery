import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { invokeIntegration } from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  consumerDepsFor,
  effectRegistry,
  fakeGithub,
  GITHUB_ARGS,
  seededEffectRig,
} from "../helpers/external-effects.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

async function codeOf(promise: Promise<unknown>): Promise<StandardError> {
  const error = await assertRejects(() => promise);
  assert(error instanceof StandardError, `unexpected ${String(error)}`);
  return error;
}

/**
 * One consumer invocation against a fake GitHub. Every call inside a test
 * replays or prepares under the door's derived canonical key, so repeated
 * calls stand for the retried sends consumers issue.
 */
async function sendOf(
  fixture: WorkerFixture,
  executorOptions: Parameters<typeof consumerDepsFor>[3] = {},
) {
  const github = fakeGithub();
  const rig = await seededEffectRig(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const deps = consumerDepsFor(
    fixture.pgDatabase,
    rig,
    github,
    executorOptions,
  );
  const input = (args: Record<string, unknown> = GITHUB_ARGS) => ({
    actionId: "github.issue.comment.create",
    actionVersion: 1,
    resourceId: rig.resourceId,
    arguments: { ...args },
  });
  const invoke = (overrides: Record<string, unknown> = {}) =>
    invokeIntegration(deps, {
      organizationId: fixture.organizationId,
      actorRef: fixture.principalId,
      connectionId: rig.connectionId,
      input: input(),
      ...overrides,
    });
  return { github, rig, input, invoke };
}

Deno.test("consumer door: a write send records the effect, dispatches and confirms", () =>
  withWorkerFixture(async (fixture) => {
    const s = await sendOf(fixture);
    const result = await s.invoke();
    assert(result.route === "ledger", "write-classified sends route to ledger");
    assertEquals(result.prepare.replayed, false);
    assertEquals(result.run.outcome, "confirmed");
    assertEquals(result.run.dispatched, true);
    assertEquals(result.output, { remoteId: String(s.github.comments[0]!.id) });
    assertEquals(s.github.posts(), 1);
    const row = result.run.effect;
    assertEquals(row.status, "confirmed");
    assertEquals(row.dispatchGeneration, 1);
    assertEquals(row.leaseExpiresAt, null);
    // The action embedded the ledger effect id as its provider marker.
    assert(
      s.github.comments[0]!.body!.split("\n").includes(
        `<!-- bakery-effect:${result.prepare.effectId} -->`,
      ),
    );
  }));

Deno.test("consumer door: a retried equal send replays one effect and never POSTs again", () =>
  withWorkerFixture(async (fixture) => {
    const s = await sendOf(fixture);
    const first = await s.invoke();
    assert(first.route === "ledger");
    assertEquals(first.run.outcome, "confirmed");
    assertEquals(s.github.posts(), 1);

    const resend = await s.invoke();
    assert(resend.route === "ledger");
    assertEquals(resend.prepare.replayed, true);
    assertEquals(resend.prepare.effectId, first.prepare.effectId);
    assertEquals(resend.run.outcome, "confirmed");
    assertEquals(resend.run.dispatched, false);
    assertEquals(s.github.posts(), 1);
  }));

Deno.test("consumer door: an uncertain outcome reconciles read-only under the same effect", () =>
  withWorkerFixture(async (fixture) => {
    const s = await sendOf(fixture);
    s.github.post = "stored_then_500";
    const first = await s.invoke();
    assert(first.route === "ledger");
    assertEquals(first.run.outcome, "uncertain");
    assertEquals(first.output, null);
    assertEquals(s.github.posts(), 1);

    s.github.post = "ok";
    const resend = await s.invoke();
    assert(resend.route === "ledger");
    assertEquals(resend.prepare.replayed, true);
    assertEquals(resend.run.outcome, "confirmed");
    assertEquals(resend.run.dispatched, false);
    assertEquals(resend.run.effect.remoteId, String(s.github.comments[0]!.id));
    // Only reads ran after the uncertain POST; no second write happened.
    assertEquals(s.github.posts(), 1);
    assert(s.github.lists() >= 1);
  }));

Deno.test("consumer door: revocation leaves an in-flight effect reconcilable and blocks fresh sends", () =>
  withWorkerFixture(async (fixture) => {
    // A dispatch whose POST hangs past the deadline stays submitted/uncertain.
    const s = await sendOf(fixture, { deadlineMs: 150 });
    s.github.post = "hang";
    const first = await s.invoke();
    assert(first.route === "ledger");
    assertEquals(first.run.outcome, "uncertain");
    assertEquals(s.github.posts(), 1);

    // Revocation racing the in-flight effect: the same send replays and stays
    // visibly uncertain, never replaced by a new effect or a second POST.
    (s.rig.snapshot.current.grants[0] as { revokedAt: Date | null }).revokedAt =
      new Date();
    s.github.post = "ok";
    const resend = await s.invoke();
    assert(resend.route === "ledger");
    assertEquals(resend.prepare.replayed, true);
    assertEquals(resend.prepare.effectId, first.prepare.effectId);
    assertEquals(resend.run.outcome, "uncertain");
    assertEquals(s.github.posts(), 1, "no new write past revocation");

    // Fresh sends cannot authorize under the revoked grant at all.
    const fresh = await codeOf(
      s.invoke({ input: s.input({ issueNumber: 8, body: "different" }) }),
    );
    assertEquals(fresh.code, "AUTH_FORBIDDEN");
    assertEquals(s.github.posts(), 1);
  }));

Deno.test("consumer door: an explicit key replaying a different request mismatches", () =>
  withWorkerFixture(async (fixture) => {
    const s = await sendOf(fixture);
    const first = await s.invoke({
      idempotencyKey: "caller-key",
      input: s.input(),
    });
    assert(first.route === "ledger");
    assertEquals(first.run.outcome, "confirmed");
    const second = await codeOf(s.invoke({
      idempotencyKey: "caller-key",
      input: s.input({ issueNumber: 9, body: "changed" }),
    }));
    assertEquals(second.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals(s.github.posts(), 1);
  }));

// Registry sanity for the consumer test world itself.
Deno.test("the deployed registry carries the write-classified comment action", () => {
  const action = effectRegistry.findAction(
    "bakery.github",
    "github.issue.comment.create",
    1,
  );
  assertEquals(
    action && action.effect,
    "write",
  );
});
