import { assertEquals, assertRejects } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import {
  createDraftIsolation,
  type DraftIsolation,
  DraftIsolationError,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import {
  commitDraftEdit,
  prepareDraftEdit,
} from "../../apps/server/src/modules/knowledge/draft-persistence.ts";
import { openAuthFixture } from "../helpers/auth.ts";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  jsonDraftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";

type Draft = {
  id: string;
  epoch: number;
  checkpointId: string;
  text: string;
  receipts: Receipt[];
};
type Slice = {
  checkpointId: string;
  startCursor: string;
  endCursor: string;
  text: string;
  textDigest: string;
};
type Receipt = {
  mutationId: string;
  serverSequence: string;
  checkpointId: string;
};

async function openAndSlice(fixture: DraftFixture): Promise<{
  draft: Draft;
  slice: Slice;
}> {
  const opened = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(opened.status, 201);
  const draft = await responseJson(opened) as Draft;
  const sliced = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=6&endUtf16=12`,
  ));
  assertEquals(sliced.status, 200);
  return { draft, slice: await responseJson(sliced) as Slice };
}

function input(draft: Draft, slice: Slice, mutationId = crypto.randomUUID()) {
  return {
    epoch: draft.epoch,
    sourceCheckpointId: slice.checkpointId,
    startCursor: slice.startCursor,
    endCursor: slice.endCursor,
    expectedText: slice.text,
    expectedDigest: slice.textDigest,
    replacement: "recovered",
    mutationId,
  };
}

async function edit(
  fixture: DraftFixture,
  draft: Draft,
  body: ReturnType<typeof input>,
): Promise<Response> {
  return await fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/edits`,
    "POST",
    body,
  ));
}

Deno.test("commit-before-response is readable and exactly replayable after app restart", async () => {
  const first = await openDraftFixture();
  const secret = first.config.auth!.secret;
  let resumed: DraftFixture | undefined;
  try {
    const { draft, slice } = await openAndSlice(first);
    const body = input(draft, slice);
    const committed = await edit(first, draft, body);
    assertEquals(committed.status, 201);
    // Simulate losing the response after the server has committed it.
    await first.close();
    const restarted = await openAuthFixture({ secret });
    resumed = {
      ...restarted,
      ids: first.ids,
      email: first.email,
      cookie: first.cookie,
    };
    const read = await resumed.app.fetch(draftRequest(
      resumed,
      `/v1/drafts/${draft.id}`,
    ));
    assertEquals(read.status, 200);
    const recovered = await responseJson(read) as Draft;
    assertEquals(recovered.text, "alpha recovered omega 😀");
    assertEquals(recovered.receipts.length, 1);

    const replay = await edit(resumed, draft, body);
    assertEquals(replay.status, 201);
    assertEquals(
      await responseJson(replay),
      recovered.receipts[0],
    );
    const facts = await resumed.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.artifact_draft_updates
        where draft_id=$1`,
      [draft.id],
    );
    assertEquals(facts.rows[0]?.count, 1);
  } finally {
    if (resumed) {
      await cleanupDraftFixture(resumed);
      await resumed.close();
    } else {
      await first.close().catch(() => undefined);
    }
  }
});

Deno.test("database rollback before commit exposes no receipt or candidate state", async () => {
  const fixture = await openDraftFixture();
  try {
    const { draft, slice } = await openAndSlice(fixture);
    const body = input(draft, slice);
    const prepared = await withPgTransaction(
      fixture.pgDatabase,
      async (transaction) =>
        await prepareDraftEdit(
          transaction,
          fixture.ids.organizationId,
          fixture.ids.principalId,
          draft.id,
          body,
        ),
    );
    if (!("kind" in prepared)) throw new Error("candidate expected");
    const candidate = await createDraftIsolation().edit(
      prepared.currentState,
      prepared.sourceState,
      body,
    );
    await assertRejects(
      () =>
        withPgTransaction(fixture.pgDatabase, async (transaction) => {
          await commitDraftEdit(
            transaction,
            fixture.ids.organizationId,
            fixture.ids.principalId,
            body,
            prepared,
            candidate,
          );
          throw new Error("INJECTED_DATABASE_FAILURE_BEFORE_COMMIT");
        }),
      Error,
      "INJECTED_DATABASE_FAILURE_BEFORE_COMMIT",
    );
    const read = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
    ));
    const current = await responseJson(read) as Draft;
    assertEquals(current.text, "alpha target omega 😀");
    assertEquals(current.receipts, []);
    const facts = await fixture.pgDatabase.query<{ updates: number }>(
      `select count(*)::int as updates from bakery.artifact_draft_updates
        where draft_id=$1`,
      [draft.id],
    );
    assertEquals(facts.rows[0]?.updates, 0);
  } finally {
    await cleanupDraftFixture(fixture);
    await fixture.close();
  }
});

Deno.test("failed isolated worker leaves committed state authoritative for the next request", async () => {
  const real = createDraftIsolation();
  let fail = true;
  const isolation: DraftIsolation = {
    initialize: real.initialize,
    slice: real.slice,
    importUpdate: real.importUpdate,
    async edit(current, source, editInput, signal) {
      if (fail) {
        fail = false;
        throw new DraftIsolationError("unavailable", "INJECTED_WORKER_FAILURE");
      }
      return await real.edit(current, source, editInput, signal);
    },
  };
  const fixture = await openDraftFixture(undefined, {
    draftIsolation: isolation,
  });
  try {
    const { draft, slice } = await openAndSlice(fixture);
    const body = input(draft, slice);
    const failed = await edit(fixture, draft, body);
    assertEquals(failed.status, 503);
    const retry = await edit(fixture, draft, body);
    assertEquals(retry.status, 201);
    const receipt = await responseJson(retry) as Receipt;
    assertEquals(receipt.serverSequence, "1");
    const read = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
    ));
    const recovered = await responseJson(read) as Draft;
    assertEquals(recovered.text, "alpha recovered omega 😀");
    assertEquals(recovered.receipts.length, 1);
  } finally {
    await cleanupDraftFixture(fixture);
    await fixture.close();
  }
});
