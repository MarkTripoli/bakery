import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createDraftIsolation,
  createDraftWorkerLimiter,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import type { DraftIsolation } from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import { DRAFT_LIMITS } from "../../apps/server/src/modules/knowledge/drafts.ts";
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
  text: string;
  receipts: Receipt[];
};
type Slice = {
  checkpointId: string;
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};
type Receipt = {
  mutationId: string;
  draftId: string;
  actorId: string;
  serverSequence: string;
  checkpointId: string;
  mutationDigest: string;
  updateDigest: string;
  textDigest: string;
};

async function openDraft(fixture: DraftFixture): Promise<Draft> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(response.status, 201);
  return await responseJson(response) as Draft;
}

async function slice(
  fixture: DraftFixture,
  draft: Draft,
  startUtf16 = 6,
  endUtf16 = 12,
): Promise<Slice> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=${startUtf16}&endUtf16=${endUtf16}`,
  ));
  assertEquals(response.status, 200);
  return await responseJson(response) as Slice;
}

function editBody(
  draft: Draft,
  selected: Slice,
  mutationId: string,
  replacement = "changed",
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

async function edit(
  fixture: DraftFixture,
  draft: Draft,
  selected: Slice,
  mutationId: string,
  replacement = "changed",
): Promise<Response> {
  return await fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/edits`,
    "POST",
    editBody(draft, selected, mutationId, replacement),
  ));
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

Deno.test("mounted API opens, reads, slices, and edits an empty draft idempotently", async () => {
  const fixture = await openDraftFixture("");
  try {
    const draft = await openDraft(fixture);
    assertEquals(draft.text, "");
    assertEquals(draft.serverSequence, "0");

    const read = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
    ));
    assertEquals(read.status, 200);
    assertEquals((await responseJson(read) as Draft).text, "");

    const selected = await slice(fixture, draft, 0, 0);
    assertEquals(selected.text, "");

    const mutationId = crypto.randomUUID();
    const first = await edit(
      fixture,
      draft,
      selected,
      mutationId,
      "first edit",
    );
    assertEquals(first.status, 201);
    const receipt = await responseJson(first) as Receipt;
    assertEquals(receipt.actorId, fixture.ids.principalId);
    assertEquals(receipt.serverSequence, "1");

    const retry = await edit(
      fixture,
      draft,
      selected,
      mutationId,
      "first edit",
    );
    assertEquals(retry.status, 201);
    assertEquals(await responseJson(retry), receipt);

    const committed = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
    ));
    assertEquals(committed.status, 200);
    const committedDraft = await responseJson(committed) as Draft;
    assertEquals(committedDraft.text, "first edit");
    assertEquals(committedDraft.receipts, [receipt]);

    const facts = await fixture.pgDatabase.query<{
      updates: number;
      receipts: number;
    }>(
      `select
         (select count(*)::int from bakery.artifact_draft_updates
           where organization_id=$1 and draft_id=$2) as updates,
         (select count(*)::int from bakery.artifact_draft_receipts
           where organization_id=$1 and draft_id=$2) as receipts`,
      [fixture.ids.organizationId, draft.id],
    );
    assertEquals(facts.rows[0]?.updates, 1);
    assertEquals(facts.rows[0]?.receipts, 1);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("mounted API commits authenticated Loro state and exact receipts atomically", async () => {
  const fixture = await openDraftFixture();
  try {
    const draft = await openDraft(fixture);
    assertEquals(draft.text, "alpha target omega 😀");
    assertEquals(draft.serverSequence, "0");
    const selected = await slice(fixture, draft);
    assertEquals(selected.text, "target");

    const malformed = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/edits`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    ));
    assert(
      malformed.status === 400 || malformed.status === 422,
      `malformed JSON returned ${malformed.status}`,
    );
    const oversized = await edit(
      fixture,
      draft,
      selected,
      crypto.randomUUID(),
      "x".repeat(65_537),
    );
    assert(
      oversized.status === 400 || oversized.status === 422,
      `oversized replacement returned ${oversized.status}`,
    );
    const beforeCommit = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.artifact_draft_receipts
        where draft_id=$1`,
      [draft.id],
    );
    assertEquals(beforeCommit.rows[0]?.count, 0);

    const mutationId = crypto.randomUUID();
    const first = await edit(fixture, draft, selected, mutationId);
    assertEquals(first.status, 201);
    const receipt = await responseJson(first) as Receipt;
    assertEquals(receipt.actorId, fixture.ids.principalId);
    assertEquals(receipt.serverSequence, "1");

    const duplicate = await edit(fixture, draft, selected, mutationId);
    assertEquals(duplicate.status, 201);
    assertEquals(await responseJson(duplicate), receipt);

    const conflict = await edit(
      fixture,
      draft,
      selected,
      mutationId,
      "different",
    );
    assertEquals(conflict.status, 422);
    assertEquals(
      (await conflict.json() as { code: string }).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );

    const read = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
    ));
    assertEquals(read.status, 200);
    const committed = await responseJson(read) as Draft;
    assertEquals(committed.text, "alpha changed omega 😀");
    assertEquals(committed.serverSequence, "1");
    assertEquals(committed.receipts, [receipt]);

    const checkpoint = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/checkpoints/${receipt.checkpointId}`,
    ));
    assertEquals(checkpoint.status, 200);
    assertEquals(
      (await responseJson(checkpoint) as { text: string }).text,
      committed.text,
    );
    const facts = await fixture.pgDatabase.query<{
      updates: number;
      checkpoints: number;
      receipts: number;
      actor_id: string;
      server_sequence: string;
      update_digest: string;
    }>(
      `select
         (select count(*)::int from bakery.artifact_draft_updates
           where organization_id=$1 and draft_id=$2) as updates,
         (select count(*)::int from bakery.artifact_draft_checkpoints
           where organization_id=$1 and draft_id=$2) as checkpoints,
         (select count(*)::int from bakery.artifact_draft_receipts
           where organization_id=$1 and draft_id=$2) as receipts,
         actor_id,server_sequence::text,update_digest
       from bakery.artifact_draft_updates
      where organization_id=$1 and draft_id=$2`,
      [fixture.ids.organizationId, draft.id],
    );
    assertEquals(facts.rows[0]?.updates, 1);
    assertEquals(facts.rows[0]?.checkpoints, 2);
    assertEquals(facts.rows[0]?.receipts, 1);
    assertEquals(facts.rows[0]?.actor_id, fixture.ids.principalId);
    assertEquals(facts.rows[0]?.server_sequence, "1");
    assertEquals(facts.rows[0]?.update_digest, receipt.updateDigest);
  } finally {
    await cleanup(fixture);
  }
});

function racingIsolation(
  races: number,
  database: () => DraftFixture["pgDatabase"],
): DraftIsolation {
  const real = createDraftIsolation();
  let edits = 0;
  return {
    initialize: real.initialize,
    slice: real.slice,
    importUpdate: real.importUpdate,
    async edit(current, source, input, signal) {
      const candidate = await real.edit(current, source, input, signal);
      if (edits++ < races) {
        await database().query(
          `update bakery.artifact_drafts
              set server_sequence=server_sequence+1
            where id=(select draft_id from bakery.artifact_draft_checkpoints
                       where state=$1 limit 1)`,
          [current],
        );
      }
      return candidate;
    },
  };
}

Deno.test("one and two stale highwaters reload, while three discard exactly three candidates", async () => {
  for (const races of [1, 2, 3]) {
    const isolation = racingIsolation(races, () => fixture.pgDatabase);
    const fixture = await openDraftFixture("alpha target omega", {
      draftIsolation: isolation,
    });
    try {
      const draft = await openDraft(fixture);
      const selected = await slice(fixture, draft);
      const response = await edit(
        fixture,
        draft,
        selected,
        crypto.randomUUID(),
      );
      if (races < 3) {
        assertEquals(response.status, 201);
        const receipt = await responseJson(response) as Receipt;
        assertEquals(receipt.serverSequence, String(races + 1));
      } else {
        assertEquals(response.status, 412);
        assertEquals(
          (await response.json() as { code: string }).code,
          "PRECONDITION_FAILED",
        );
      }
      const facts = await fixture.pgDatabase.query<{
        updates: number;
        receipts: number;
        text_content: string;
      }>(
        `select
           (select count(*)::int from bakery.artifact_draft_updates
             where draft_id=$1) as updates,
           (select count(*)::int from bakery.artifact_draft_receipts
             where draft_id=$1) as receipts,
           c.text_content
         from bakery.artifact_drafts d
         join bakery.artifact_draft_checkpoints c on c.id=d.current_checkpoint_id
        where d.id=$1`,
        [draft.id],
      );
      assertExists(facts.rows[0]);
      assertEquals(facts.rows[0].updates, races < 3 ? 1 : 0);
      assertEquals(facts.rows[0].receipts, races < 3 ? 1 : 0);
      assertEquals(
        facts.rows[0].text_content,
        races < 3 ? "alpha changed omega" : "alpha target omega",
      );
    } finally {
      await cleanup(fixture);
    }
  }
});

Deno.test("concurrent, duplicated and reordered edits from one checkpoint converge with exact receipts", async () => {
  // Three edits from one organization run at once. The default pool's
  // per-organization share (#297) is 2, so this test, which is about
  // convergence and receipts rather than capacity, uses a pool of 6.
  const fixture = await openDraftFixture(undefined, {
    draftIsolation: createDraftIsolation({
      workerLimiter: createDraftWorkerLimiter(6),
    }),
  });
  try {
    const draft = await openDraft(fixture);
    const left = await slice(fixture, draft, 0, 5);
    const right = await slice(fixture, draft, 13, 18);
    assertEquals([left.text, right.text], ["alpha", "omega"]);
    const leftId = crypto.randomUUID();
    const rightId = crypto.randomUUID();

    // Two clients edit disjoint ranges of the same checkpoint at once, and the
    // left client's request is duplicated in flight.
    const responses = await Promise.all([
      edit(fixture, draft, left, leftId, "ALPHA"),
      edit(fixture, draft, right, rightId, "OMEGA"),
      edit(fixture, draft, left, leftId, "ALPHA"),
    ]);
    for (const response of responses) {
      assertEquals(response.status, 201, await response.clone().text());
    }
    const [leftReceipt, rightReceipt, leftDuplicate] = await Promise.all(
      responses.map((response) => responseJson(response)),
    ) as Receipt[];
    assertEquals(leftDuplicate, leftReceipt);
    assertEquals(
      new Set([leftReceipt!.serverSequence, rightReceipt!.serverSequence]),
      new Set(["1", "2"]),
    );

    const read = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}`,
    ));
    assertEquals(read.status, 200);
    const committed = await responseJson(read) as Draft;
    assertEquals(committed.text, "ALPHA target OMEGA 😀");
    assertEquals(committed.serverSequence, "2");

    // A reconnecting client resends both edits in the other order: each
    // replays its exact receipt and nothing new is committed.
    assertEquals(
      await responseJson(await edit(fixture, draft, right, rightId, "OMEGA")),
      rightReceipt,
    );
    assertEquals(
      await responseJson(await edit(fixture, draft, left, leftId, "ALPHA")),
      leftReceipt,
    );
    // The same mutation id with a changed payload conflicts.
    const changed = await edit(fixture, draft, right, rightId, "other");
    assertEquals(changed.status, 422);
    assertEquals(
      (await changed.json() as { code: string }).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const receipts = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.artifact_draft_receipts
        where draft_id=$1`,
      [draft.id],
    );
    assertEquals(receipts.rows[0]?.count, 2);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("open, slice and edit each count toward the caller's organization share (#297)", async () => {
  const real = createDraftIsolation();
  const seen: [string, string | undefined][] = [];
  const isolation: DraftIsolation = {
    importUpdate: real.importUpdate,
    initialize(text, signal, organizationId) {
      seen.push(["initialize", organizationId]);
      return real.initialize(text, signal, organizationId);
    },
    slice(state, start, end, signal, organizationId) {
      seen.push(["slice", organizationId]);
      return real.slice(state, start, end, signal, organizationId);
    },
    edit(current, source, input, signal, organizationId) {
      seen.push(["edit", organizationId]);
      return real.edit(current, source, input, signal, organizationId);
    },
  };
  const fixture = await openDraftFixture("alpha target omega", {
    draftIsolation: isolation,
  });
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft);
    const response = await edit(fixture, draft, selected, crypto.randomUUID());
    assertEquals(response.status, 201, await response.clone().text());
    const organizationId = fixture.ids.organizationId;
    assertEquals(seen, [
      ["initialize", organizationId],
      ["slice", organizationId],
      ["edit", organizationId],
    ]);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a duplicate whose original commits during its last stale attempt replays the exact receipt", async () => {
  // The duplicate is made stale on every attempt. On its last attempt, after
  // its final preparation, the original request commits. Only the commit-time
  // receipt lookup can then answer, because the stale budget is exhausted.
  const real = createDraftIsolation();
  let duplicateEdits = 0;
  let nested = false;
  let original: (() => Promise<Response>) | undefined;
  let originalResponse: Response | undefined;
  const isolation: DraftIsolation = {
    initialize: real.initialize,
    slice: real.slice,
    importUpdate: real.importUpdate,
    async edit(current, source, input, signal) {
      const candidate = await real.edit(current, source, input, signal);
      if (nested || !original) return candidate;
      duplicateEdits += 1;
      if (duplicateEdits < DRAFT_LIMITS.staleAttempts) {
        await fixture.pgDatabase.query(
          `update bakery.artifact_drafts
              set server_sequence=server_sequence+1
            where id=(select draft_id from bakery.artifact_draft_checkpoints
                       where state=$1 limit 1)`,
          [current],
        );
      } else {
        nested = true;
        try {
          originalResponse = await original();
        } finally {
          nested = false;
        }
      }
      return candidate;
    },
  };
  const fixture = await openDraftFixture("alpha target omega", {
    draftIsolation: isolation,
  });
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft);
    const mutationId = crypto.randomUUID();
    original = () => edit(fixture, draft, selected, mutationId);
    const duplicate = await edit(fixture, draft, selected, mutationId);

    assertEquals(duplicateEdits, DRAFT_LIMITS.staleAttempts);
    assertExists(originalResponse);
    assertEquals(originalResponse.status, 201);
    const receipt = await responseJson(originalResponse) as Receipt;
    assertEquals(duplicate.status, 201, await duplicate.clone().text());
    assertEquals(await responseJson(duplicate), receipt);
    const receipts = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.artifact_draft_receipts
        where draft_id=$1`,
      [draft.id],
    );
    assertEquals(receipts.rows[0]?.count, 1);
  } finally {
    await cleanup(fixture);
  }
});
