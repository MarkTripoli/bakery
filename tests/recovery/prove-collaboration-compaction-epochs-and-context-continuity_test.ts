// #38 B12.07: recovery proofs for collaboration compaction, epoch rollover and
// context continuity, through the mounted API and a real database.
//
// AC1: an offline client's edit survives a checkpoint compaction and an epoch
// rollover as an explicit proposal, and the saved data is untouched.
// AC2: a server restart between draft commit, publication and handoff leaves the
// agent exactly the frozen version.
import { assertEquals } from "@std/assert";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { compactDraftEpoch } from "../../apps/server/src/modules/knowledge/draft-compaction.ts";
import { openAuthFixture } from "../helpers/auth.ts";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  jsonDraftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";

type Json = Record<string, unknown>;
type Draft = {
  id: string;
  epoch: number;
  serverSequence: string;
  checkpointId: string;
  textDigest: string;
  text: string;
};
type Slice = {
  checkpointId: string;
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};

async function openDraft(fixture: DraftFixture): Promise<Draft> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(response.status, 201, await response.clone().text());
  return await responseJson(response) as Draft;
}

async function readDraft(fixture: DraftFixture, id: string): Promise<Draft> {
  const response = await fixture.app.fetch(
    draftRequest(fixture, `/v1/drafts/${id}`),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await responseJson(response) as Draft;
}

/** An edit of the middle word (UTF-16 6..12), built against `draft`'s checkpoint. */
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

async function commit(fixture: DraftFixture, draft: Draft, word: string) {
  const response = await post(
    fixture,
    `/v1/drafts/${draft.id}/edits`,
    await editBody(fixture, draft, word),
  );
  assertEquals(response.status, 201, await response.clone().text());
  await response.body?.cancel();
  return await readDraft(fixture, draft.id);
}

function publish(fixture: DraftFixture, draft: Draft) {
  return post(fixture, `/v1/drafts/${draft.id}/publications`, {
    checkpointId: draft.checkpointId,
    textDigest: draft.textDigest,
  });
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

/** The server process stops and a new one serves the same database. */
async function restart(
  fixture: DraftFixture,
  secret: string,
): Promise<DraftFixture> {
  await fixture.close();
  const next = await openAuthFixture({ secret });
  return {
    ...next,
    ids: fixture.ids,
    email: fixture.email,
    cookie: fixture.cookie,
  };
}

Deno.test("an offline edit survives compaction and an epoch rollover as a proposal, and saved data is untouched", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const opened = await openDraft(fixture);
    // What the offline client built before it lost its connection.
    const offline = await editBody(fixture, opened, "mine!!");

    // Meanwhile others save six edits; the opening checkpoint is compacted away.
    let draft = opened;
    for (
      const word of ["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee", "ffffff"]
    ) {
      draft = await commit(fixture, draft, word);
    }
    await fixture.pgDatabase.query(
      `update bakery.artifact_draft_receipts
          set committed_at = clock_timestamp() - interval '2 days'
        where organization_id=$1 and draft_id=$2`,
      [fixture.ids.organizationId, opened.id],
    );
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        compactDraftEpoch(
          transaction,
          fixture.ids.organizationId,
          opened.id,
          draft.epoch,
          { keptCheckpoints: 2 },
        ),
    );
    const source = await fixture.pgDatabase.query(
      "select 1 from bakery.artifact_draft_checkpoints where id=$1",
      [offline.sourceCheckpointId],
    );
    assertEquals(
      source.rows.length,
      0,
      "the offline client's checkpoint is gone",
    );

    // It reconnects: its edit cannot apply (its source is gone), and nothing it
    // sent changes the saved text.
    const refused = await post(
      fixture,
      `/v1/drafts/${opened.id}/edits`,
      offline,
    );
    assertEquals(refused.status, 412);
    await refused.body?.cancel();
    assertEquals(
      (await readDraft(fixture, opened.id)).text,
      "alpha ffffff omega",
    );

    // The draft is published and rolled to a new epoch; the client's words are
    // then kept as a proposal instead of being lost.
    const frozen = await readDraft(fixture, opened.id);
    assertEquals((await publish(fixture, frozen)).status, 201);
    const rolled = await post(fixture, `/v1/drafts/${opened.id}/rollover`, {
      epoch: frozen.epoch,
      checkpointId: frozen.checkpointId,
    });
    assertEquals(rolled.status, 201, await rolled.clone().text());
    const proposed = await post(
      fixture,
      `/v1/drafts/${opened.id}/suggestions`,
      offline,
    );
    assertEquals(proposed.status, 201, await proposed.clone().text());
    const kept = await responseJson(proposed) as Json;
    assertEquals(kept.state, "no_longer_fits");
    assertEquals(kept.replacement, "mine!!");

    // Saved data survives: the new epoch starts from the published text.
    const after = await readDraft(fixture, opened.id);
    assertEquals(after.epoch, 2);
    assertEquals(after.text, "alpha ffffff omega");
    assertEquals(after.textDigest, frozen.textDigest);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a restart between commit, publication and handoff leaves the agent exactly the frozen version", async () => {
  const first = await openDraftFixture("alpha target omega");
  const secret = first.config.auth!.secret;
  let live = first;
  try {
    const opened = await openDraft(live);
    const committed = await commit(live, opened, "frozen");
    assertEquals(committed.text, "alpha frozen omega");

    // Restart 1: between commit and publication.
    live = await restart(live, secret);
    const cutoff = await readDraft(live, opened.id);
    assertEquals(cutoff.text, "alpha frozen omega");
    const published = await publish(live, cutoff);
    assertEquals(published.status, 201, await published.clone().text());
    const version = await responseJson(published) as Json;

    // Restart 2: between publication and the handoff to the agent.
    live = await restart(live, secret);
    const sent = await post(live, `/v1/drafts/${opened.id}/references`, {
      expectedEpoch: cutoff.epoch,
      checkpointId: cutoff.checkpointId,
      textDigest: cutoff.textDigest,
      threads: [],
      mutationId: crypto.randomUUID(),
    });
    assertEquals(sent.status, 201, await sent.clone().text());
    const reference = await responseJson(sent) as Json;

    // Restart 3: the draft moves on while the agent is about to read.
    live = await restart(live, secret);
    await commit(live, await readDraft(live, opened.id), "later!");
    assertEquals((await readDraft(live, opened.id)).text, "alpha later! omega");

    // The agent consumes the frozen revision, never the later text.
    const read = await live.app.fetch(
      draftRequest(live, `/v1/draft-references/${reference.id}`),
    );
    assertEquals(read.status, 200, await read.clone().text());
    const frozen = await responseJson(read) as Json;
    assertEquals(frozen.checkpointId, cutoff.checkpointId);
    assertEquals(frozen.textDigest, cutoff.textDigest);
    const content = await live.pgDatabase.query<{ content: Uint8Array }>(
      "select content from bakery.artifact_versions where id=$1",
      [version.artifactVersionId],
    );
    assertEquals(
      new TextDecoder().decode(content.rows[0].content),
      "alpha frozen omega",
    );
  } finally {
    await cleanupDraftFixture(live);
    await live.close();
  }
});
