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
const REMOVE_LABEL = "github.issue.label.remove";
const ADD_LABELS = "github.issue.labels.add";
const UPDATE_COMMENT = "github.issue.comment.update";
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

/** One label removal through the ledger and the real broker, against the fake GitHub. */
async function removeLabelSend(fixture: WorkerFixture, label: string) {
  const github = fakeGithub();
  const rig = await seededEffectRig(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  grantRigAction(rig, REMOVE_LABEL);
  const deps = consumerDepsFor(fixture.pgDatabase, rig, github);
  const result = await invokeIntegration(deps, {
    organizationId: fixture.organizationId,
    actorRef: fixture.principalId,
    connectionId: rig.connectionId,
    input: {
      actionId: REMOVE_LABEL,
      actionVersion: 1,
      resourceId: rig.resourceId,
      arguments: { issueNumber: 7, label },
    },
  });
  return { github, result };
}

Deno.test("a label with a colon, a space or a slash is removed as one encoded path segment", () =>
  withWorkerFixture(async (fixture) => {
    for (
      const [label, segment] of [
        ["bakery:owned", "bakery%3Aowned"],
        ["good first issue", "good%20first%20issue"],
        ["area/web", "area%2Fweb"],
        ["100%", "100%25"],
      ]
    ) {
      const { github, result } = await removeLabelSend(fixture, label);
      assert(result.route === "ledger");
      assertEquals(result.run.outcome, "confirmed", label);
      assertEquals(result.output, { labels: ["mine"] });
      const deletes = github.calls.filter((c) => c.method === "DELETE");
      assertEquals(deletes.length, 1, label);
      assertEquals(
        deletes[0].path,
        `/repos/bakery-org/bakery-repo/issues/7/labels/${segment}`,
        "the whole name is one segment of the path",
      );
    }
  }));

Deno.test("a label name that cannot be one honest segment never reaches GitHub", () =>
  withWorkerFixture(async (fixture) => {
    // "..." is a legal label name, so only the broker's dot-only check stops it.
    for (const label of [".", "..", "..."]) {
      const { github, result } = await removeLabelSend(fixture, label);
      assert(result.route === "ledger");
      assertEquals(
        github.calls.filter((c) => c.method === "DELETE").length,
        0,
        `${label} sends no request`,
      );
    }
  }));

/** One send of an action the rig's actor was granted, through the ledger and the real broker. */
async function sendOnce(
  fixture: WorkerFixture,
  actionId: string,
  args: Record<string, unknown>,
  seed: (github: ReturnType<typeof fakeGithub>) => void = () => undefined,
) {
  const github = fakeGithub();
  seed(github);
  const rig = await seededEffectRig(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  grantRigAction(rig, actionId);
  const deps = consumerDepsFor(fixture.pgDatabase, rig, github);
  const result = await invokeIntegration(deps, {
    organizationId: fixture.organizationId,
    actorRef: fixture.principalId,
    connectionId: rig.connectionId,
    input: {
      actionId,
      actionVersion: 1,
      resourceId: rig.resourceId,
      arguments: args,
    },
  });
  return { github, result };
}

const bot = { id: 4242, type: "Bot" };

Deno.test("Bakery's status note is rewritten in place through the ledger", () =>
  withWorkerFixture(async (fixture) => {
    const { github, result } = await sendOnce(
      fixture,
      UPDATE_COMMENT,
      { issueNumber: 7, commentId: "77", body: "Status: done" },
      (g) => g.comments.push({ id: 77, body: "Status: running", user: bot }),
    );
    assert(result.route === "ledger");
    assertEquals(result.run.outcome, "confirmed");
    assertEquals(result.output, { remoteId: "77" });
    assertEquals(github.comments.map((c) => c.body), ["Status: done"]);
  }));

Deno.test("a status note deleted on GitHub is confirmed gone through the ledger", () =>
  withWorkerFixture(async (fixture) => {
    const { github, result } = await sendOnce(
      fixture,
      UPDATE_COMMENT,
      { issueNumber: 7, commentId: "999", body: "Status: done" },
    );
    assert(result.route === "ledger");
    assertEquals(result.run.outcome, "confirmed");
    assertEquals(result.output, { missing: true });
    assertEquals(github.comments.length, 0);
  }));

Deno.test("adding Bakery's label names only that label and answers what the issue carries", () =>
  withWorkerFixture(async (fixture) => {
    const { result } = await sendOnce(fixture, ADD_LABELS, {
      issueNumber: 7,
      labels: ["bakery:owned"],
    });
    assert(result.route === "ledger");
    assertEquals(result.run.outcome, "confirmed");
    assertEquals(result.output, { labels: ["mine", "bakery:owned"] });
  }));
