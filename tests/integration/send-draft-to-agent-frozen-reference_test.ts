import { assertEquals, assertExists } from "@std/assert";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  jsonDraftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";

// Send draft to agent freezes a bounded revision and the chosen threads into
// an immutable reference (#28, chapter 20 "Send draft to agent" and
// "Send-to-agent captures exact roots/replies/checkpoints under CAS and the
// existing context bounds").

type Draft = {
  id: string;
  epoch: number;
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
type Comment = { id: string; version: number };
type Reference = {
  id: string;
  draftId: string;
  epoch: number;
  checkpointId: string;
  serverSequence: string;
  textDigest: string;
  createdById: string;
  actorKind: string;
  comments: {
    commentId: string;
    parentId?: string;
    version: number;
    body: string;
    quote?: string;
    status?: string;
  }[];
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

async function slice(
  fixture: DraftFixture,
  draft: Draft,
  start: number,
  end: number,
): Promise<Slice> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=${start}&endUtf16=${end}`,
  ));
  assertEquals(response.status, 200, await response.clone().text());
  return await responseJson(response) as Slice;
}

async function comment(
  fixture: DraftFixture,
  draftId: string,
  body: Record<string, unknown>,
): Promise<Comment> {
  const response = await fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draftId}/comments`,
    "POST",
    { mutationId: crypto.randomUUID(), ...body },
  ));
  assertEquals(response.status, 201, await response.clone().text());
  return await responseJson(response) as Comment;
}

async function root(
  fixture: DraftFixture,
  draft: Draft,
  start: number,
  end: number,
  body: string,
): Promise<Comment> {
  const selected = await slice(fixture, draft, start, end);
  return await comment(fixture, draft.id, {
    body,
    epoch: draft.epoch,
    startCursor: selected.startCursor,
    endCursor: selected.endCursor,
    quote: selected.text,
  });
}

async function editRange(
  fixture: DraftFixture,
  draft: Draft,
  start: number,
  end: number,
  replacement: string,
): Promise<void> {
  const current = await readDraft(fixture, draft.id);
  const selected = await slice(fixture, current, start, end);
  const response = await fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/edits`,
    "POST",
    {
      epoch: current.epoch,
      sourceCheckpointId: selected.checkpointId,
      startCursor: selected.startCursor,
      endCursor: selected.endCursor,
      expectedText: selected.text,
      expectedDigest: selected.textDigest,
      replacement,
      mutationId: crypto.randomUUID(),
    },
  ));
  assertEquals(response.status, 201, await response.clone().text());
  await response.body?.cancel();
}

function send(
  fixture: DraftFixture,
  draft: Draft,
  threads: { commentId: string; expectedVersion: number }[],
  mutationId: string = crypto.randomUUID(),
  organizationId?: string,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/references`,
    "POST",
    {
      expectedEpoch: draft.epoch,
      checkpointId: draft.checkpointId,
      textDigest: draft.textDigest,
      threads,
      mutationId,
    },
    organizationId,
  )));
}

async function readReference(
  fixture: DraftFixture,
  id: string,
): Promise<Response> {
  return await fixture.app.fetch(
    draftRequest(fixture, `/v1/draft-references/${id}`),
  );
}

async function referenceCounts(fixture: DraftFixture, draftId: string) {
  return (await fixture.pgDatabase.query<{
    references: number;
    comments: number;
  }>(
    `select
       (select count(*)::int from bakery.artifact_draft_references
         where draft_id=$1) as references,
       (select count(*)::int from bakery.artifact_draft_reference_comments rc
         join bakery.artifact_draft_references r on r.id=rc.reference_id
         where r.draft_id=$1) as comments`,
    [draftId],
  )).rows[0];
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

Deno.test("a reference keeps its revision and threads after the draft and comments change", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const thread = await root(fixture, draft, 6, 12, "tighten this");
    const reply = await comment(fixture, draft.id, {
      body: "agreed",
      rootId: thread.id,
    });
    // The reply moved the root's version on.
    const sent = await send(fixture, draft, [{
      commentId: thread.id,
      expectedVersion: thread.version + 1,
    }]);
    assertEquals(sent.status, 201, await sent.clone().text());
    const reference = await responseJson(sent) as Reference;
    assertEquals(reference.draftId, draft.id);
    assertEquals(reference.epoch, draft.epoch);
    assertEquals(reference.checkpointId, draft.checkpointId);
    assertEquals(reference.textDigest, draft.textDigest);
    assertEquals(reference.createdById, fixture.ids.principalId);
    assertEquals(reference.actorKind, "person");
    assertEquals(
      reference.comments.map((item) => [item.commentId, item.parentId]),
      [[thread.id, undefined], [reply.id, thread.id]],
    );
    assertEquals(reference.comments[0].quote, "target");
    assertEquals(reference.comments[0].status, "open");
    assertEquals(reference.comments[1].body, "agreed");

    // Move the text, edit the reply and resolve the thread.
    await editRange(fixture, draft, 0, 5, "a much longer alpha");
    const edited = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/comments/${reply.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": `"${reply.version}"`,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ body: "changed my mind" }),
      },
    ));
    assertEquals(edited.status, 200, await edited.clone().text());
    await edited.body?.cancel();
    const roots = await fixture.app.fetch(
      draftRequest(fixture, `/v1/drafts/${draft.id}/comments`),
    );
    const current = (await responseJson(roots) as { items: Comment[] })
      .items[0];
    const resolved = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/comments/${thread.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": `"${current.version}"`,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ resolved: true }),
      },
    ));
    assertEquals(resolved.status, 200, await resolved.clone().text());
    await resolved.body?.cancel();

    const read = await readReference(fixture, reference.id);
    assertEquals(read.status, 200, await read.clone().text());
    assertEquals(await responseJson(read), reference);
    // The live draft did move on.
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "a much longer alpha target omega",
    );
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a stale thread version is refused by name with nothing written", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const first = await root(fixture, draft, 0, 5, "first");
    const second = await root(fixture, draft, 6, 12, "second");
    await comment(fixture, draft.id, { body: "later", rootId: second.id });
    const stale = await send(fixture, draft, [
      { commentId: first.id, expectedVersion: first.version },
      { commentId: second.id, expectedVersion: second.version },
    ]);
    assertEquals(stale.status, 412, await stale.clone().text());
    assertEquals((await stale.json()).reason, "thread_version_changed");
    assertEquals(await referenceCounts(fixture, draft.id), {
      references: 0,
      comments: 0,
    });
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a thread over the comment-context bound is refused", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const long = "x".repeat(10_000);
    const thread = await root(fixture, draft, 6, 12, long);
    for (let index = 0; index < 3; index += 1) {
      await comment(fixture, draft.id, { body: long, rootId: thread.id });
    }
    const refused = await send(fixture, draft, [{
      commentId: thread.id,
      expectedVersion: thread.version + 3,
    }]);
    assertEquals(refused.status, 413, await refused.clone().text());
    assertEquals((await refused.json()).code, "BODY_TOO_LARGE");
    // More roots than the bound fails the contract.
    const many = await send(
      fixture,
      draft,
      Array.from({ length: 101 }, () => ({
        commentId: crypto.randomUUID(),
        expectedVersion: 1,
      })),
    );
    assertEquals(many.status, 400, await many.clone().text());
    await many.body?.cancel();
    assertEquals(await referenceCounts(fixture, draft.id), {
      references: 0,
      comments: 0,
    });
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("another organization cannot send or read a draft reference", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  const other = await openDraftFixture("other organization text");
  try {
    const draft = await openDraft(fixture);
    const sent = await send(fixture, draft, []);
    assertEquals(sent.status, 201, await sent.clone().text());
    const reference = await responseJson(sent) as Reference;
    assertEquals(reference.comments, []);
    const read = await readReference(other, reference.id);
    assertEquals(read.status, 404);
    assertEquals((await read.json()).code, "RESOURCE_NOT_FOUND");
    const foreign = await send(other, draft, []);
    assertEquals(foreign.status, 404);
    await foreign.body?.cancel();
  } finally {
    await cleanup(other);
    await cleanup(fixture);
  }
});

Deno.test("a replayed mutationId answers with the same reference", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const thread = await root(fixture, draft, 6, 12, "look here");
    const mutationId = crypto.randomUUID();
    const threads = [{ commentId: thread.id, expectedVersion: thread.version }];
    const first = await send(fixture, draft, threads, mutationId);
    assertEquals(first.status, 201, await first.clone().text());
    const original = await responseJson(first) as Reference;
    const again = await send(fixture, draft, threads, mutationId);
    assertEquals(again.status < 300, true, await again.clone().text());
    assertEquals(await responseJson(again), original);
    const changed = await send(fixture, draft, [], mutationId);
    assertEquals(changed.status, 422, await changed.clone().text());
    assertEquals((await changed.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    const counts = await referenceCounts(fixture, draft.id);
    assertExists(counts);
    assertEquals(counts, { references: 1, comments: 1 });
  } finally {
    await cleanup(fixture);
  }
});
