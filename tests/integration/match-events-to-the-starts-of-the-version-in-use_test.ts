import { assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { seedOrganization } from "../helpers/coordinator-turns.ts";
import {
  currentDraft,
  json,
  PROPOSED,
  publish,
  seedWorkflowDraft,
  send,
  withFixture,
} from "../helpers/definition-authoring.ts";
import {
  type NeutralEvent,
  neutralEventOf,
} from "../../apps/server/src/modules/integrations/neutral-events.ts";
import { GITHUB_PROVIDER } from "../../apps/server/src/modules/integrations/registry.ts";
import { liveStartsFor } from "../../apps/server/src/modules/workflows/start-match.ts";

// #406 slice 2 and the start of slice 3's switch: a start answers an event only
// through the version "Use this version" points at. Publishing a version does
// not switch its starts on, a replaced version stops answering at once, a draft
// never answers, a disabled workflow does not answer, and one organization's
// starts never answer another's events. The starts are authored through the
// real draft route, so this is the path a caller takes.

type Saved = { id: string; version: number; digest: string };

const opened = (repositoryId: number): NeutralEvent => {
  const built = neutralEventOf(GITHUB_PROVIDER, {
    kind: "pull_request",
    action: "opened",
    number: 3,
    headSha: null,
    repositoryId,
  });
  if (built === null) throw new Error("the event has a neutral meaning");
  return built;
};
const closed = (repositoryId: number): NeutralEvent => ({
  kind: "change_request.closed",
  fields: { repositoryId },
});

Deno.test("a start answers an event only through the version in use", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "live-a", { role: "admin" });
    const person = { seed };
    const live = (event: NeutralEvent, organizationId = seed.organizationId) =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) => liveStartsFor(transaction, organizationId, event),
      );
    const { workflowId, draft } = await seedWorkflowDraft(
      fixture,
      person,
      "live-flow",
    );
    const saveStarts = async (target: Saved, starts: unknown[]) =>
      await json<Saved>(
        await send(
          fixture,
          person,
          "PATCH",
          `/v1/workflows/${workflowId}/versions/${target.id}`,
          {
            body: { definition: PROPOSED, starts },
            ifMatch: target.version,
          },
        ),
        200,
      );
    const definition = async () =>
      await json<{ version: number; activeVersionId: string | null }>(
        await send(fixture, person, "GET", `/v1/workflows/${workflowId}`),
        200,
      );
    const activate = async (versionId: string) =>
      await json(
        await send(
          fixture,
          person,
          "POST",
          `/v1/workflows/${workflowId}/activations`,
          { body: { versionId }, ifMatch: (await definition()).version },
        ),
        200,
      );
    const onOpened = {
      id: "on-opened",
      on: {
        kind: "event",
        eventKind: "change_request.opened",
        filter: { repositoryId: 7 },
      },
    };
    const anyOpened = {
      id: "any-opened",
      on: { kind: "event", eventKind: "change_request.opened", filter: {} },
    };
    const onClosed = {
      id: "on-closed",
      on: { kind: "event", eventKind: "change_request.closed", filter: {} },
    };

    // A draft's starts never answer, even though they are stored.
    const saved = await saveStarts(draft, [onOpened, anyOpened, onClosed]);
    assertEquals(await live(opened(7)), []);

    // Publishing does not switch a start on.
    const v1 = await json<Saved>(
      await publish(fixture, person, workflowId, saved),
      200,
    );
    assertEquals(await live(opened(7)), []);

    // "Use this version" does, and only for the events the start names. Two
    // starts of one version that both match are both returned, by start id.
    await activate(v1.id);
    assertEquals(await live(opened(7)), [
      { workflowId, versionId: v1.id, startId: "any-opened" },
      { workflowId, versionId: v1.id, startId: "on-opened" },
    ]);
    assertEquals(await live(opened(8)), [
      { workflowId, versionId: v1.id, startId: "any-opened" },
    ]);
    assertEquals(await live(closed(7)), [
      { workflowId, versionId: v1.id, startId: "on-closed" },
    ]);

    // A newer published version is not in use until it is used: the first
    // version keeps answering, the newer one does not.
    await json(
      await send(
        fixture,
        person,
        "POST",
        `/v1/workflows/${workflowId}/versions`,
        {
          body: { definition: PROPOSED },
        },
      ),
      201,
    );
    const next = await saveStarts(
      await currentDraft(fixture, seed, workflowId),
      [{
        id: "only-v2",
        on: {
          kind: "event",
          eventKind: "change_request.opened",
          filter: { repositoryId: 7 },
        },
      }],
    );
    const v2 = await json<Saved>(
      await publish(fixture, person, workflowId, next),
      200,
    );
    assertEquals(
      (await live(opened(7))).map((start) => start.versionId),
      [v1.id, v1.id],
    );

    // Using the newer version replaces the first: its starts stop answering at
    // once and the newer version's start answers.
    await activate(v2.id);
    assertEquals(await live(opened(7)), [
      { workflowId, versionId: v2.id, startId: "only-v2" },
    ]);
    assertEquals(await live(closed(7)), []);

    // A disabled workflow does not answer, and does again when enabled.
    await fixture.pgDatabase.query(
      `update bakery.workflow_definitions set enabled = false
        where organization_id = $1 and id = $2`,
      [seed.organizationId, workflowId],
    );
    assertEquals(await live(opened(7)), []);
    await fixture.pgDatabase.query(
      `update bakery.workflow_definitions set enabled = true
        where organization_id = $1 and id = $2`,
      [seed.organizationId, workflowId],
    );
    assertEquals((await live(opened(7))).length, 1);

    // Another organization with the same start, in use, never answers this
    // organization's event, and this organization's never answers theirs.
    const otherSeed = await seedOrganization(fixture, "live-b", {
      role: "admin",
    });
    const other = { seed: otherSeed };
    const theirs = await seedWorkflowDraft(fixture, other, "live-flow-b");
    const theirsSaved = await json<Saved>(
      await send(
        fixture,
        other,
        "PATCH",
        `/v1/workflows/${theirs.workflowId}/versions/${theirs.draft.id}`,
        {
          body: { definition: PROPOSED, starts: [anyOpened] },
          ifMatch: theirs.draft.version,
        },
      ),
      200,
    );
    const theirsV1 = await json<Saved>(
      await publish(fixture, other, theirs.workflowId, theirsSaved),
      200,
    );
    const theirsDefinition = await json<{ version: number }>(
      await send(fixture, other, "GET", `/v1/workflows/${theirs.workflowId}`),
      200,
    );
    await json(
      await send(
        fixture,
        other,
        "POST",
        `/v1/workflows/${theirs.workflowId}/activations`,
        {
          body: { versionId: theirsV1.id },
          ifMatch: theirsDefinition.version,
        },
      ),
      200,
    );
    assertEquals(await live(opened(7), otherSeed.organizationId), [
      {
        workflowId: theirs.workflowId,
        versionId: theirsV1.id,
        startId: "any-opened",
      },
    ]);
    assertEquals(await live(opened(7)), [
      { workflowId, versionId: v2.id, startId: "only-v2" },
    ]);
  }));
