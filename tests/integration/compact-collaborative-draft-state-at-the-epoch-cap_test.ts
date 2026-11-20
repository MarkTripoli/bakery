import { assertEquals, assertRejects } from "@std/assert";
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

/** Eight edits of the middle word; the checkpoint id after each, index 0 being the opening one. */
async function eightEdits(
  fixture: DraftFixture,
): Promise<{ draft: Draft; checkpoints: string[] }> {
  let draft = await openDraft(fixture);
  const checkpoints = [draft.checkpointId];
  for (const word of WORDS) {
    const step = await editMiddle(fixture, draft, word);
    assertEquals(step.response.status, 201);
    draft = step.draft;
    checkpoints.push(draft.checkpointId);
  }
  return { draft, checkpoints };
}

async function ageReceipts(fixture: DraftFixture, draft: Draft) {
  await fixture.pgDatabase.query(
    `update bakery.artifact_draft_receipts
        set committed_at = clock_timestamp() - interval '2 days'
      where organization_id=$1 and draft_id=$2`,
    [fixture.ids.organizationId, draft.id],
  );
}

async function checkpointIds(
  fixture: DraftFixture,
  draft: Draft,
): Promise<Set<string>> {
  const rows = await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.artifact_draft_checkpoints
      where organization_id=$1 and draft_id=$2`,
    [fixture.ids.organizationId, draft.id],
  );
  return new Set(rows.rows.map((row) => row.id));
}

Deno.test("a checkpoint a publication, comment, reference or comment publication names is never compacted", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    let draft = await openDraft(fixture);
    const checkpoints = [draft.checkpointId];
    for (const [index, word] of WORDS.entries()) {
      const step = await editMiddle(fixture, draft, word);
      assertEquals(step.response.status, 201);
      draft = step.draft;
      checkpoints.push(draft.checkpointId);
      if (index === 0) {
        // Publication: checkpoint 1 is frozen as an artifact version.
        const read = await fixture.app.fetch(
          draftRequest(fixture, `/v1/drafts/${draft.id}`),
        );
        const frozen = await responseJson(read) as Draft & {
          textDigest: string;
        };
        const published = await fixture.app.fetch(jsonDraftRequest(
          fixture,
          `/v1/drafts/${draft.id}/publications`,
          "POST",
          { checkpointId: frozen.checkpointId, textDigest: frozen.textDigest },
        ));
        assertEquals(published.status, 201, await published.clone().text());
      }
    }
    const org = fixture.ids.organizationId;
    const principal = fixture.ids.principalId;
    // Comment: checkpoint 2 is where it was made.
    const comment = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.artifact_draft_comments (
         organization_id,draft_id,epoch,author_id,actor_kind,body,
         creation_checkpoint_id,client_mutation_id,request_digest,request_id,
         trace_id,status
       ) values ($1,$2,1,$3,'person','pinned',$4,$5,'d','r','t','open')
       returning id`,
      [org, draft.id, principal, checkpoints[2], crypto.randomUUID()],
    );
    // Reference: checkpoint 3 is one an agent was pointed at.
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_draft_references (
         organization_id,draft_id,epoch,checkpoint_id,server_sequence,
         content_digest,created_by,actor_kind,client_mutation_id,
         request_digest,request_id,trace_id
       ) values ($1,$2,1,$3,3,'x',$4,'person',$5,'d','r','t')`,
      [org, draft.id, checkpoints[3], principal, crypto.randomUUID()],
    );
    // Comment publication: checkpoint 4 is the cutoff a thread was copied from.
    const artifactComment = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.artifact_comments (
         organization_id,artifact_version_id,author_id,body
       ) values ($1,$2,$3,'copied') returning id`,
      [org, fixture.ids.versionId, principal],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_draft_comment_publications (
         organization_id,draft_id,draft_comment_id,artifact_version_id,
         artifact_comment_id,source_checkpoint_id
       ) values ($1,$2,$3,$4,$5,$6)`,
      [
        org,
        draft.id,
        comment.rows[0].id,
        fixture.ids.versionId,
        artifactComment.rows[0].id,
        checkpoints[4],
      ],
    );
    await ageReceipts(fixture, draft);

    await compactAsApp(fixture, draft);
    const left = await checkpointIds(fixture, draft);
    // Pinned (1 to 4), newest four (5 to 8) and current stay; only the opening one goes.
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
      assertEquals(left.has(checkpoints[index]), true, `checkpoint ${index}`);
    }
    assertEquals(left.has(checkpoints[0]), false);
  } finally {
    // The copied comment sits on the fixture's version, which cleanup removes.
    await fixture.pgDatabase.query(
      "delete from bakery.artifact_comments where organization_id=$1",
      [fixture.ids.organizationId],
    );
    await cleanup(fixture);
  }
});

Deno.test("a decided suggestion no longer pins its checkpoint", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    let draft = await openDraft(fixture);
    const checkpoints = [draft.checkpointId];
    let suggestionId = "";
    for (const [index, word] of WORDS.entries()) {
      const step = await editMiddle(fixture, draft, word);
      assertEquals(step.response.status, 201);
      draft = step.draft;
      checkpoints.push(draft.checkpointId);
      if (index === 1) {
        const selected = await sliceOf(fixture, draft);
        const proposed = await fixture.app.fetch(jsonDraftRequest(
          fixture,
          `/v1/drafts/${draft.id}/suggestions`,
          "POST",
          body(draft, selected, crypto.randomUUID(), "pinned"),
        ));
        assertEquals(proposed.status, 201);
        suggestionId = (await proposed.json() as { id: string }).id;
      }
    }
    const rejected = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions/${suggestionId}/reject`,
      { method: "POST" },
    ));
    assertEquals(rejected.status, 201, await rejected.clone().text());
    await ageReceipts(fixture, draft);

    await compactAsApp(fixture, draft);
    const left = await checkpointIds(fixture, draft);
    assertEquals(left.has(checkpoints[2]), false);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a current checkpoint whose digest does not match its text stops compaction before anything is removed", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const { draft } = await eightEdits(fixture);
    await ageReceipts(fixture, draft);
    await fixture.pgDatabase.query(
      `update bakery.artifact_draft_checkpoints
          set text_digest='0000'
        where organization_id=$1 and id=$2`,
      [fixture.ids.organizationId, draft.checkpointId],
    );
    const before = await counts(fixture, draft);
    await assertRejects(() => compactAsApp(fixture, draft));
    assertEquals(await counts(fixture, draft), before);
  } finally {
    await cleanup(fixture);
  }
});

async function counts(fixture: DraftFixture, draft: Draft) {
  return {
    checkpoints: await count(fixture, "artifact_draft_checkpoints", draft.id),
    updates: await count(fixture, "artifact_draft_updates", draft.id),
    receipts: await count(fixture, "artifact_draft_receipts", draft.id),
  };
}

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
    const before = await counts(fixture, draft);
    const refused = await editMiddle(fixture, fits.draft, "ffffff");
    assertEquals(refused.response.status, 409);
    assertEquals(
      (await refused.response.clone().json() as { code: string }).code,
      "STORAGE_QUOTA_EXCEEDED",
    );
    assertEquals(await counts(fixture, draft), before);
    assertEquals(await count(fixture, "artifact_draft_receipts", draft.id), 5);
  } finally {
    await cleanup(fixture);
  }
});
