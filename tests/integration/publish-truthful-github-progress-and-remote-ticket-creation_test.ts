import { assert, assertEquals } from "@std/assert";
import { invokeIntegration } from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  consumerDepsFor,
  fakeGithub,
  grantRigAction,
  seededEffectRig,
} from "../helpers/external-effects.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

/**
 * Issue 32 (AC1): creating a remote ticket goes through the effect ledger, and
 * a lost response is settled by reading the repository, never by posting
 * again. One remote identity is confirmed, or the work stays uncertain.
 */

const CREATE = "github.issue.create";
const ARGS = {
  title: "Add the progress comment",
  body: "Details of the work.",
};

async function createSend(fixture: WorkerFixture) {
  const github = fakeGithub();
  const rig = await seededEffectRig(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  grantRigAction(rig, CREATE);
  const deps = consumerDepsFor(fixture.pgDatabase, rig, github);
  const invoke = () =>
    invokeIntegration(deps, {
      organizationId: fixture.organizationId,
      actorRef: fixture.principalId,
      connectionId: rig.connectionId,
      input: {
        actionId: CREATE,
        actionVersion: 1,
        resourceId: rig.resourceId,
        arguments: { ...ARGS },
      },
    });
  return { github, invoke };
}

Deno.test("a created issue is confirmed with its number and immutable id, and carries the effect marker", () =>
  withWorkerFixture(async (fixture) => {
    const s = await createSend(fixture);
    const result = await s.invoke();
    assert(result.route === "ledger");
    assertEquals(result.run.outcome, "confirmed");
    const issue = s.github.issues[0]!;
    assertEquals(result.output, {
      remoteId: String(issue.number),
      issueId: String(issue.id),
    });
    assertEquals(s.github.posts(), 1);
    assert(
      issue.body!.split("\n").includes(
        `<!-- bakery-effect:${result.prepare.effectId} -->`,
      ),
    );
  }));

Deno.test("a lost response to the creation is reconciled to the one issue GitHub stored, with no second POST", () =>
  withWorkerFixture(async (fixture) => {
    const s = await createSend(fixture);
    s.github.post = "stored_then_500";
    const first = await s.invoke();
    assert(first.route === "ledger");
    assertEquals(first.run.outcome, "uncertain");
    assertEquals(first.output, null);
    assertEquals(s.github.posts(), 1);

    // The retry replays the same effect and only reads: the bot's marker on
    // exactly one issue confirms it.
    s.github.post = "ok";
    const retry = await s.invoke();
    assert(retry.route === "ledger");
    assertEquals(retry.prepare.replayed, true);
    assertEquals(retry.prepare.effectId, first.prepare.effectId);
    assertEquals(retry.run.outcome, "confirmed");
    assertEquals(retry.run.dispatched, false);
    assertEquals(s.github.issues.length, 1, "no duplicate issue");
    assertEquals(s.github.posts(), 1, "no second POST");
    assertEquals(retry.run.effect.remoteId, String(s.github.issues[0]!.number));
    assert(s.github.lists() >= 1, "it read the repository's issues");
  }));

Deno.test("a lost creation that left no issue behind stays uncertain and is never posted again", () =>
  withWorkerFixture(async (fixture) => {
    const s = await createSend(fixture);
    // GitHub answers 500 and stored nothing: absence alone cannot authorize
    // another write, because the read cannot prove the POST never landed.
    s.github.post = { status: 500 };
    const first = await s.invoke();
    assert(first.route === "ledger");
    assertEquals(first.run.outcome, "uncertain");

    s.github.post = "ok";
    const retry = await s.invoke();
    assert(retry.route === "ledger");
    assertEquals(retry.prepare.replayed, true);
    assertEquals(retry.run.outcome, "uncertain");
    assertEquals(retry.run.dispatched, false);
    assertEquals(s.github.posts(), 1);
    assertEquals(s.github.issues.length, 0);
  }));
