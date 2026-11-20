import { assertEquals } from "@std/assert";
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
  serverSequence: string;
  checkpointId: string;
  textDigest: string;
  text: string;
  receipts: unknown[];
};
type Slice = {
  checkpointId: string;
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};

async function readDraft(fixture: DraftFixture, id: string): Promise<Draft> {
  const response = await fixture.app.fetch(
    draftRequest(fixture, `/v1/drafts/${id}`),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await responseJson(response) as Draft;
}

async function openDraft(fixture: DraftFixture): Promise<Draft> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(response.status, 201);
  return await responseJson(response) as Draft;
}

/** The body of one edit of UTF-16 6..12 (the fixture's middle word). */
async function editBody(fixture: DraftFixture, draft: Draft, word: string) {
  const sliced = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=6&endUtf16=12`,
  ));
  assertEquals(sliced.status, 200, await sliced.clone().text());
  const selected = await responseJson(sliced) as Slice;
  return {
    epoch: draft.epoch,
    sourceCheckpointId: selected.checkpointId,
    startCursor: selected.startCursor,
    endCursor: selected.endCursor,
    expectedText: selected.text,
    expectedDigest: selected.textDigest,
    replacement: word,
    mutationId: crypto.randomUUID(),
  };
}

function post(fixture: DraftFixture, path: string, body: unknown) {
  return Promise.resolve(
    fixture.app.fetch(jsonDraftRequest(fixture, path, "POST", body)),
  );
}

/** A command that needs an Idempotency-Key, as drafts.rollover does. */
function postKeyed(fixture: DraftFixture, path: string, body: unknown) {
  const request = jsonDraftRequest(fixture, path, "POST", body);
  request.headers.set("Idempotency-Key", crypto.randomUUID());
  return Promise.resolve(fixture.app.fetch(request));
}

function publish(fixture: DraftFixture, draft: Draft) {
  return post(fixture, `/v1/drafts/${draft.id}/publications`, {
    checkpointId: draft.checkpointId,
    textDigest: draft.textDigest,
  });
}

function rollover(fixture: DraftFixture, draft: Draft, epoch = draft.epoch) {
  return postKeyed(fixture, `/v1/drafts/${draft.id}/rollover`, {
    epoch,
    checkpointId: draft.checkpointId,
  });
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

Deno.test("a draft rolls over to the next epoch from its published checkpoint", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const opened = await openDraft(fixture);
    const edited = await post(
      fixture,
      `/v1/drafts/${opened.id}/edits`,
      await editBody(fixture, opened, "bigger"),
    );
    assertEquals(edited.status, 201, await edited.clone().text());
    const cutoff = await readDraft(fixture, opened.id);
    assertEquals(cutoff.receipts.length, 1);

    // The old epoch's edit body, kept to prove it is refused after the roll.
    const stale = await editBody(fixture, cutoff, "stale");

    // Not published yet: refused, and the draft is untouched.
    const early = await rollover(fixture, cutoff);
    assertEquals(early.status, 412, await early.clone().text());
    assertEquals((await readDraft(fixture, opened.id)).epoch, 1);

    const published = await publish(fixture, cutoff);
    assertEquals(published.status, 201, await published.clone().text());

    const rolled = await rollover(fixture, cutoff);
    assertEquals(rolled.status, 201, await rolled.clone().text());
    const next = await responseJson(rolled) as Draft;
    assertEquals(next.id, opened.id);
    assertEquals(next.epoch, 2);
    assertEquals(next.serverSequence, "0");
    assertEquals(next.text, "alpha bigger omega");
    assertEquals(next.textDigest, cutoff.textDigest);
    assertEquals(next.checkpointId === cutoff.checkpointId, false);
    assertEquals(next.receipts, []);

    // The closed epoch keeps its rows; nothing was deleted by the roll.
    const rows = await fixture.pgDatabase.query<{ epoch: number; n: number }>(
      `select epoch,count(*)::int as n from bakery.artifact_draft_checkpoints
        where organization_id=$1 and draft_id=$2 group by epoch order by epoch`,
      [fixture.ids.organizationId, opened.id],
    );
    assertEquals(rows.rows.map((row) => [row.epoch, row.n]), [[1, 2], [2, 1]]);

    // An edit built for epoch 1 can no longer be applied.
    const refused = await post(fixture, `/v1/drafts/${opened.id}/edits`, stale);
    assertEquals(refused.status, 412, await refused.clone().text());
    await refused.body?.cancel();

    // The new epoch takes edits from sequence 1.
    const fresh = await post(
      fixture,
      `/v1/drafts/${opened.id}/edits`,
      await editBody(fixture, next, "second"),
    );
    assertEquals(fresh.status, 201, await fresh.clone().text());
    const after = await readDraft(fixture, opened.id);
    assertEquals(after.text, "alpha second omega");
    assertEquals(after.serverSequence, "1");
    assertEquals(after.receipts.length, 1);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a repeated or mismatched rollover changes nothing", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const opened = await openDraft(fixture);
    assertEquals((await publish(fixture, opened)).status, 201);

    const wrongEpoch = await rollover(fixture, opened, 7);
    assertEquals(wrongEpoch.status, 412, await wrongEpoch.clone().text());
    await wrongEpoch.body?.cancel();
    const wrongCheckpoint = await postKeyed(
      fixture,
      `/v1/drafts/${opened.id}/rollover`,
      { epoch: 1, checkpointId: crypto.randomUUID() },
    );
    assertEquals(wrongCheckpoint.status, 412);
    await wrongCheckpoint.body?.cancel();
    assertEquals((await readDraft(fixture, opened.id)).epoch, 1);

    assertEquals((await rollover(fixture, opened)).status, 201);
    const repeat = await rollover(fixture, opened);
    assertEquals(repeat.status, 412);
    await repeat.body?.cancel();
    assertEquals((await readDraft(fixture, opened.id)).epoch, 2);
  } finally {
    await cleanup(fixture);
  }
});
