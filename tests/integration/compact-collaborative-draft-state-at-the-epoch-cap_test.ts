import { assertEquals } from "@std/assert";
import { compactDraftEpoch } from "../../apps/server/src/modules/knowledge/draft-compaction.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  jsonDraftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";

type Draft = { id: string; epoch: number; checkpointId: string; text: string };
type Slice = {
  checkpointId: string;
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};
type Receipt = { mutationId: string; checkpointId: string };

async function openDraft(fixture: DraftFixture): Promise<Draft> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(response.status, 201);
  return await responseJson(response) as Draft;
}

async function sliceOf(fixture: DraftFixture, draft: Draft): Promise<Slice> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=6&endUtf16=12`,
  ));
  assertEquals(response.status, 200);
  return await responseJson(response) as Slice;
}

function body(
  draft: Draft,
  selected: Slice,
  mutationId: string,
  replacement: string,
) {
  return {
    epoch: draft.epoch,
    sourceCheckpointId: selected.checkpointId,
    startCursor: selected.startCursor,
    endCursor: selected.endCursor,
    expectedText: selected.text,
    expectedDigest: selected.textDigest,
    replacement,
    mutationId,
  };
}

/** One six-letter edit of the middle word; returns the draft at its new checkpoint. */
async function editMiddle(
  fixture: DraftFixture,
  draft: Draft,
  replacement: string,
  mutationId = crypto.randomUUID(),
): Promise<{ draft: Draft; receipt: Receipt; response: Response }> {
  const selected = await sliceOf(fixture, draft);
  const response = await fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/edits`,
    "POST",
    body(draft, selected, mutationId, replacement),
  ));
  if (response.status !== 201) {
    return { draft, receipt: undefined as unknown as Receipt, response };
  }
  const receipt = await response.clone().json() as Receipt;
  return {
    draft: { ...draft, checkpointId: receipt.checkpointId },
    receipt,
    response,
  };
}

async function count(
  fixture: DraftFixture,
  table: string,
  draftId: string,
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ n: number }>(
    `select count(*)::int as n from bakery.${table}
      where organization_id=$1 and draft_id=$2`,
    [fixture.ids.organizationId, draftId],
  );
  return result.rows[0].n;
}

/** One compaction pass. The cap test below drives it through the app role, which proves the grants of migration 0297. */
function compactAsApp(
  fixture: DraftFixture,
  draft: Draft,
  options: Parameters<typeof compactDraftEpoch>[4] = {},
) {
  return withPgTransaction(fixture.pgDatabase, async (transaction) => {
    return await compactDraftEpoch(
      transaction,
      fixture.ids.organizationId,
      draft.id,
      draft.epoch,
      options,
    );
  });
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

const WORDS = [
  "aaaaaa",
  "bbbbbb",
  "cccccc",
  "dddddd",
  "eeeeee",
  "ffffff",
  "gggggg",
  "hhhhhh",
];

Deno.test("compaction removes superseded state and expired receipts, and keeps the newest and the pinned", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    let draft = await openDraft(fixture);
    let pinned = "";
    for (const [index, word] of WORDS.entries()) {
      const step = await editMiddle(fixture, draft, word);
      assertEquals(step.response.status, 201);
      draft = step.draft;
      if (index === 1) {
        // A waiting suggestion names this checkpoint, so compaction keeps it.
        pinned = draft.checkpointId;
        const selected = await sliceOf(fixture, draft);
        const proposed = await fixture.app.fetch(jsonDraftRequest(
          fixture,
          `/v1/drafts/${draft.id}/suggestions`,
          "POST",
          body(draft, selected, crypto.randomUUID(), "pinned"),
        ));
        assertEquals(proposed.status, 201);
      }
    }
    assertEquals(
      await count(fixture, "artifact_draft_checkpoints", draft.id),
      9,
    );
    assertEquals(await count(fixture, "artifact_draft_updates", draft.id), 8);
    assertEquals(await count(fixture, "artifact_draft_receipts", draft.id), 8);

    // Inside the retry window no receipt goes; every receipt is young.
    const young = await compactAsApp(fixture, draft);
    assertEquals(young.receipts, 0);
    await fixture.pgDatabase.query(
      `update bakery.artifact_draft_receipts
          set committed_at = clock_timestamp() - interval '2 days'
        where organization_id=$1 and draft_id=$2`,
      [fixture.ids.organizationId, draft.id],
    );
    const pass = await compactAsApp(fixture, draft);
    assertEquals(pass.receipts, 8);
    assertEquals(pass.updates >= 0, true);
    // The newest four, the current one and the pinned one remain.
    const kept = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.artifact_draft_checkpoints
        where organization_id=$1 and draft_id=$2`,
      [fixture.ids.organizationId, draft.id],
    );
    assertEquals(kept.rows.length, 5);
    assertEquals(kept.rows.some((row) => row.id === pinned), true);
    assertEquals(
      kept.rows.some((row) => row.id === draft.checkpointId),
      true,
    );
    assertEquals(await count(fixture, "artifact_draft_updates", draft.id), 1);

    // The draft still reads and takes the next edit.
    const read = await fixture.app.fetch(
      draftRequest(fixture, `/v1/drafts/${draft.id}`),
    );
    assertEquals(
      (await responseJson(read) as Draft).text,
      "alpha hhhhhh omega",
    );
    const next = await editMiddle(fixture, draft, "iiiiii");
    assertEquals(next.response.status, 201);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a retry inside the window replays its receipt after the checkpoint it names is compacted", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    let draft = await openDraft(fixture);
    const mutationId = crypto.randomUUID();
    // The exact request a client retries: same source checkpoint, same bytes.
    const original = body(
      draft,
      await sliceOf(fixture, draft),
      mutationId,
      "aaaaaa",
    );
    const first = await editMiddle(fixture, draft, "aaaaaa", mutationId);
    assertEquals(first.response.status, 201);
    draft = first.draft;
    for (const word of ["bbbbbb", "cccccc"]) {
      draft = (await editMiddle(fixture, draft, word)).draft;
    }
    const pass = await compactAsApp(fixture, draft, { keptCheckpoints: 1 });
    assertEquals(pass.checkpoints >= 1, true);
    const gone = await fixture.pgDatabase.query(
      `select 1 from bakery.artifact_draft_checkpoints
        where organization_id=$1 and id=$2`,
      [fixture.ids.organizationId, first.receipt.checkpointId],
    );
    assertEquals(gone.rows.length, 0);

    const retry = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/edits`,
      "POST",
      original,
    ));
    assertEquals(retry.status, 201);
    assertEquals(await retry.json(), first.receipt);
  } finally {
    await cleanup(fixture);
  }
});

async function seedState(
  fixture: DraftFixture,
  draft: Draft,
  sequence: number,
  megabytes: number,
): Promise<void> {
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_draft_checkpoints (
       organization_id,draft_id,epoch,server_sequence,state,frontiers,
       text_content,text_digest
     ) values ($1,$2,$3,$4,convert_to(repeat('a',$5::int),'UTF8'),'\\x00'::bytea,'','x')`,
    [
      fixture.ids.organizationId,
      draft.id,
      draft.epoch,
      sequence,
      megabytes * 1_048_576,
    ],
  );
}

Deno.test("an edit that would pass the epoch cap compacts once, and is refused when nothing can go", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    let draft = await openDraft(fixture);
    for (const word of ["aaaaaa", "bbbbbb", "cccccc", "dddddd"]) {
      draft = (await editMiddle(fixture, draft, word)).draft;
    }
    // 9 MiB of old state is over the compaction threshold: the next commit
    // removes it (it is outside the newest four) and the edit goes through.
    await seedState(fixture, draft, -1, 9);
    const fits = await editMiddle(fixture, draft, "eeeeee");
    assertEquals(fits.response.status, 201);
    const old = await fixture.pgDatabase.query(
      `select 1 from bakery.artifact_draft_checkpoints
        where organization_id=$1 and draft_id=$2 and server_sequence=-1`,
      [fixture.ids.organizationId, draft.id],
    );
    assertEquals(old.rows.length, 0);

    // Three newest checkpoints of 6 MiB each cannot be compacted away, so the
    // next edit would pass 16 MiB: refused, and nothing is committed.
    for (const sequence of [100, 101, 102]) {
      await seedState(fixture, fits.draft, sequence, 6);
    }
    const refused = await editMiddle(fixture, fits.draft, "ffffff");
    assertEquals(refused.response.status, 409);
    assertEquals(await count(fixture, "artifact_draft_receipts", draft.id), 5);
  } finally {
    await cleanup(fixture);
  }
});
