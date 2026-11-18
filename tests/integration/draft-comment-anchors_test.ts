import { assertEquals, assertExists } from "@std/assert";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  jsonDraftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";

// Draft comment threads anchored by relative Loro cursors (#28, chapter 20
// "Comments on a moving document").

type Draft = {
  id: string;
  epoch: number;
  checkpointId: string;
  text: string;
};
type Slice = {
  checkpointId: string;
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};
type Comment = {
  id: string;
  draftId: string;
  rootId: string | null;
  body: string | null;
  quote: string | null;
  anchorState: "current" | "outdated" | null;
  startUtf16: number | null;
  endUtf16: number | null;
  coordinateEncoding: string | null;
  creationCheckpointId: string;
  status: "open" | "resolved" | null;
  resolvedBy: string | null;
  version: number;
  authorId: string;
  actorKind: string;
};
type Page = { items: Comment[]; nextCursor: string | null };

async function openDraft(fixture: DraftFixture): Promise<Draft> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(response.status, 201);
  return await responseJson(response) as Draft;
}

async function readDraft(fixture: DraftFixture, id: string): Promise<Draft> {
  const response = await fixture.app.fetch(
    draftRequest(fixture, `/v1/drafts/${id}`),
  );
  assertEquals(response.status, 200);
  return await responseJson(response) as Draft;
}

async function slice(
  fixture: DraftFixture,
  draft: Draft,
  startUtf16: number,
  endUtf16: number,
): Promise<Slice> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=${startUtf16}&endUtf16=${endUtf16}`,
  ));
  assertEquals(response.status, 200);
  return await responseJson(response) as Slice;
}

/** Replaces one range through the ordinary guarded edit path. */
async function editRange(
  fixture: DraftFixture,
  draftId: string,
  startUtf16: number,
  endUtf16: number,
  replacement: string,
): Promise<void> {
  const draft = await readDraft(fixture, draftId);
  const selected = await slice(fixture, draft, startUtf16, endUtf16);
  const response = await fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/edits`,
    "POST",
    {
      epoch: draft.epoch,
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
}

function rootBody(draft: Draft, selected: Slice, quote = selected.text) {
  return {
    body: "Is this the right word?",
    epoch: draft.epoch,
    startCursor: selected.startCursor,
    endCursor: selected.endCursor,
    quote,
    mutationId: crypto.randomUUID(),
  };
}

async function comment(
  fixture: DraftFixture,
  draftId: string,
  body: unknown,
): Promise<Response> {
  return await fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draftId}/comments`,
    "POST",
    body,
  ));
}

async function list(
  fixture: DraftFixture,
  draftId: string,
  query = "",
): Promise<Page> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draftId}/comments${query}`,
  ));
  assertEquals(response.status, 200, await response.clone().text());
  return await responseJson(response) as Page;
}

async function update(
  fixture: DraftFixture,
  draftId: string,
  commentId: string,
  version: number,
  body: unknown,
): Promise<Response> {
  return await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draftId}/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "if-match": `"${version}"`,
      },
      body: JSON.stringify(body),
    },
  ));
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

/** Opens a draft with one root anchored on "target". */
async function anchoredRoot(
  fixture: DraftFixture,
): Promise<{ draft: Draft; root: Comment }> {
  const draft = await openDraft(fixture);
  const selected = await slice(fixture, draft, 6, 12);
  assertEquals(selected.text, "target");
  const created = await comment(fixture, draft.id, rootBody(draft, selected));
  assertEquals(created.status, 201, await created.clone().text());
  return { draft, root: await responseJson(created) as Comment };
}

Deno.test("a root anchored by cursors is created and listed with its offsets", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const { draft, root } = await anchoredRoot(fixture);
    assertEquals(root.rootId, null);
    assertEquals(root.status, "open");
    assertEquals(root.quote, "target");
    assertEquals(root.anchorState, "current");
    assertEquals([root.startUtf16, root.endUtf16], [6, 12]);
    assertEquals(root.creationCheckpointId, draft.checkpointId);
    assertEquals(root.actorKind, "person");
    assertEquals(root.authorId, fixture.ids.principalId);
    assertExists(root.coordinateEncoding);
    assertEquals(root.version, 1);

    const listed = await list(fixture, draft.id);
    assertEquals(listed.items.length, 1);
    assertEquals(listed.nextCursor, null);
    assertEquals(listed.items[0].id, root.id);
    assertEquals(listed.items[0].anchorState, "current");
    assertEquals(
      [listed.items[0].startUtf16, listed.items[0].endUtf16],
      [6, 12],
    );
    // The body lives only in Postgres: the draft text is unchanged.
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "alpha target omega",
    );
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("an edit elsewhere keeps the anchor and shifts its offsets", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const { draft, root } = await anchoredRoot(fixture);
    await editRange(fixture, draft.id, 0, 5, "a much longer alpha");
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "a much longer alpha target omega",
    );
    const listed = await list(fixture, draft.id);
    assertEquals(listed.items[0].id, root.id);
    assertEquals(listed.items[0].anchorState, "current");
    assertEquals(
      [listed.items[0].startUtf16, listed.items[0].endUtf16],
      [20, 26],
    );
    // Moving text never resolves the thread.
    assertEquals(listed.items[0].status, "open");
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("deleting the anchored text makes the thread outdated but still listed", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const { draft, root } = await anchoredRoot(fixture);
    await editRange(fixture, draft.id, 5, 12, "");
    assertEquals((await readDraft(fixture, draft.id)).text, "alpha omega");
    const listed = await list(fixture, draft.id);
    assertEquals(listed.items.length, 1);
    assertEquals(listed.items[0].id, root.id);
    assertEquals(listed.items[0].anchorState, "outdated");
    assertEquals(listed.items[0].startUtf16, null);
    assertEquals(listed.items[0].endUtf16, null);
    assertEquals(listed.items[0].quote, "target");
    assertEquals(listed.items[0].status, "open");
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a quote that does not match the text between the cursors is refused", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    const refused = await comment(
      fixture,
      draft.id,
      rootBody(draft, selected, "targex"),
    );
    assertEquals(refused.status, 412);
    assertEquals((await refused.json()).reason, "comment_quote_mismatch");
    assertEquals((await list(fixture, draft.id)).items.length, 0);

    // A cursor pair whose range was later deleted is stale, not recorded.
    await editRange(fixture, draft.id, 5, 12, "");
    const moved = await readDraft(fixture, draft.id);
    const stale = await comment(fixture, draft.id, rootBody(moved, selected));
    assertEquals(stale.status, 412);
    assertEquals((await stale.json()).reason, "comment_anchor_stale");
    assertEquals((await list(fixture, draft.id)).items.length, 0);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a quote that splits a surrogate pair is refused", async () => {
  const fixture = await openDraftFixture("alpha \u{1F600} omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 8);
    assertEquals(selected.text, "\u{1F600}");
    // Loro places a cursor only on a character boundary, so the split can
    // only arrive as a quote holding half of the pair.
    const refused = await comment(
      fixture,
      draft.id,
      rootBody(draft, selected, "\uD83D"),
    );
    assertEquals(refused.status, 412);
    assertEquals(
      (await refused.json()).reason,
      "comment_anchor_splits_character",
    );
    assertEquals((await list(fixture, draft.id)).items.length, 0);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("resolving with a stale version is a precondition failure", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const { draft, root } = await anchoredRoot(fixture);
    const resolved = await update(fixture, draft.id, root.id, root.version, {
      resolved: true,
    });
    assertEquals(resolved.status, 200, await resolved.clone().text());
    const after = await responseJson(resolved) as Comment;
    assertEquals(after.status, "resolved");
    assertEquals(after.resolvedBy, fixture.ids.principalId);
    assertEquals(after.version, root.version + 1);

    const stale = await update(fixture, draft.id, root.id, root.version, {
      resolved: false,
    });
    assertEquals(stale.status, 412);
    assertEquals((await stale.json()).code, "PRECONDITION_FAILED");
    const listed = await list(fixture, draft.id, "?status=resolved");
    assertEquals(listed.items.map((item) => item.id), [root.id]);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("replies are flat: a reply to a reply is refused", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const { draft, root } = await anchoredRoot(fixture);
    const replied = await comment(fixture, draft.id, {
      body: "Agreed.",
      rootId: root.id,
      mutationId: crypto.randomUUID(),
    });
    assertEquals(replied.status, 201, await replied.clone().text());
    const reply = await responseJson(replied) as Comment;
    assertEquals(reply.rootId, root.id);
    assertEquals(reply.status, null);
    assertEquals(reply.anchorState, null);

    const nested = await comment(fixture, draft.id, {
      body: "And a reply to the reply.",
      rootId: reply.id,
      mutationId: crypto.randomUUID(),
    });
    assertEquals(nested.status, 409);
    assertEquals((await nested.json()).reason, "comment_replies_are_flat");

    // A reply carries no anchor of its own.
    const anchoredReply = await comment(fixture, draft.id, {
      ...rootBody(draft, await slice(fixture, draft, 6, 12)),
      rootId: root.id,
    });
    assertEquals(anchoredReply.status, 422);

    const replies = await list(fixture, draft.id, `?rootId=${root.id}`);
    assertEquals(replies.items.map((item) => item.id), [reply.id]);
    // Adding the reply moved the root's version on.
    const roots = await list(fixture, draft.id);
    assertEquals(roots.items[0].version, root.version + 1);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("another organization reads a draft's comments as not found", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  const other = await openDraftFixture("other organization text");
  try {
    const { draft } = await anchoredRoot(fixture);
    const response = await other.app.fetch(draftRequest(
      other,
      `/v1/drafts/${draft.id}/comments`,
    ));
    assertEquals(response.status, 404);
    assertEquals((await response.json()).code, "RESOURCE_NOT_FOUND");
  } finally {
    await cleanup(other);
    await cleanup(fixture);
  }
});
