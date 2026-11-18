import { assertEquals, assertExists } from "@std/assert";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  jsonDraftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";

// Publishing a frozen cutoff while editing continues, bounded guarded edits,
// and draft threads projected onto the published version (#28, chapter 20
// "Publish a cutoff while editing continues" and "Comments on a moving
// document").

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
type Publication = {
  artifactVersionId: string;
  checkpointId: string;
  versionNumber: number;
};
type DraftComment = {
  id: string;
  rootId: string | null;
  status: "open" | "resolved" | null;
  anchorState: "current" | "outdated" | null;
  publishedAs: {
    artifactVersionId: string;
    artifactCommentId: string;
    sourceCheckpointId: string;
  }[];
};
type ArtifactComment = {
  id: string;
  rootId: string | null;
  body: string | null;
  authorId: string;
  status: string | null;
  anchor: Record<string, unknown> | null;
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
  startUtf16: number,
  endUtf16: number,
): Promise<Slice> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=${startUtf16}&endUtf16=${endUtf16}`,
  ));
  assertEquals(response.status, 200, await response.clone().text());
  return await responseJson(response) as Slice;
}

/** One guarded edit of a range read at `selected`'s checkpoint. */
function edit(
  fixture: DraftFixture,
  draft: Draft,
  selected: Slice,
  replacement: string,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(jsonDraftRequest(
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
  )));
}

async function applied(response: Response): Promise<void> {
  assertEquals(response.status, 201, await response.clone().text());
  await response.body?.cancel();
}

async function refusal(response: Response): Promise<string | undefined> {
  assertEquals(response.status, 412, await response.clone().text());
  return (await response.json() as { reason?: string }).reason;
}

function publish(
  fixture: DraftFixture,
  draft: Pick<Draft, "id" | "checkpointId" | "textDigest">,
  projectThreads?: string[],
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/publications`,
    "POST",
    {
      checkpointId: draft.checkpointId,
      textDigest: draft.textDigest,
      ...(projectThreads ? { projectThreads } : {}),
    },
  )));
}

async function versionText(
  fixture: DraftFixture,
  versionId: string,
): Promise<string> {
  const row = (await fixture.pgDatabase.query<{ content: Uint8Array }>(
    `select content from bakery.artifact_versions where id=$1`,
    [versionId],
  )).rows[0];
  assertExists(row);
  return new TextDecoder().decode(row.content);
}

async function counts(fixture: DraftFixture, draftId: string) {
  return (await fixture.pgDatabase.query<{
    versions: number;
    comments: number;
    mappings: number;
    publications: number;
  }>(
    `select
       (select count(*)::int from bakery.artifact_versions
         where artifact_id=$1) as versions,
       (select count(*)::int from bakery.artifact_comments c
         join bakery.artifact_versions v on v.id=c.artifact_version_id
         where v.artifact_id=$1) as comments,
       (select count(*)::int from bakery.artifact_draft_comment_publications
         where draft_id=$2) as mappings,
       (select count(*)::int from bakery.artifact_draft_publications
         where draft_id=$2) as publications`,
    [fixture.ids.artifactId, draftId],
  )).rows[0];
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    // Projected comments hang off versions; drop them before the fixture.
    await fixture.pgDatabase.query(
      `delete from bakery.artifact_comments where organization_id=$1`,
      [fixture.ids.organizationId],
    );
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

Deno.test("disjoint edits from one source checkpoint both apply; a changed target is refused by name", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    // All three ranges are read at the same source checkpoint.
    const head = await slice(fixture, draft, 0, 5);
    const target = await slice(fixture, draft, 6, 12);
    const tail = await slice(fixture, draft, 13, 18);
    assertEquals([head.text, target.text, tail.text], [
      "alpha",
      "target",
      "omega",
    ]);
    await applied(await edit(fixture, draft, head, "ALPHA"));
    // The text changed elsewhere since the source checkpoint: still applies.
    await applied(await edit(fixture, draft, tail, "OMEGA"));
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "ALPHA target OMEGA",
    );

    // Someone rewrites the target; an edit still aimed at the old text fails.
    const current = await readDraft(fixture, draft.id);
    await applied(
      await edit(
        fixture,
        current,
        await slice(fixture, current, 6, 12),
        "goal",
      ),
    );
    assertEquals(
      await refusal(await edit(fixture, draft, target, "aim")),
      "text_changed",
    );
    assertEquals((await readDraft(fixture, draft.id)).text, "ALPHA goal OMEGA");
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("an edit whose cursors were relocated onto matching text is refused as ambiguous", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const target = await slice(fixture, draft, 6, 12);
    // The character after the range is deleted: the range still reads
    // "target", but the end cursor's own character is gone and Loro moved
    // the cursor onto a neighbour, so the range is no longer the one read.
    await applied(
      await edit(fixture, draft, await slice(fixture, draft, 12, 13), ""),
    );
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "alpha targetomega",
    );
    assertEquals(
      await refusal(await edit(fixture, draft, target, "aim")),
      "target_ambiguous",
    );
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "alpha targetomega",
    );
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("edits after the cutoff stay in the live draft; a changed artifact base is a conflict", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    await applied(
      await edit(fixture, draft, await slice(fixture, draft, 6, 12), "first"),
    );
    const cutoff = await readDraft(fixture, draft.id);
    await applied(
      await edit(fixture, cutoff, await slice(fixture, cutoff, 6, 11), "later"),
    );
    const published = await publish(fixture, cutoff);
    assertEquals(published.status, 201, await published.clone().text());
    const publication = await responseJson(published) as Publication;
    assertEquals(
      await versionText(fixture, publication.artifactVersionId),
      "alpha first omega",
    );
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "alpha later omega",
    );

    // Another version is published to the artifact meanwhile.
    const content = new TextEncoder().encode("written elsewhere");
    const elsewhere = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_versions (
         id,organization_id,artifact_id,task_id,author_id,revision,metadata,
         content,sha256,size_bytes,media_type
       ) values ($1,$2,$3,$4,$5,3,'{}'::jsonb,$6,$7,$8,'text/markdown')`,
      [
        elsewhere,
        fixture.ids.organizationId,
        fixture.ids.artifactId,
        fixture.ids.taskId,
        fixture.ids.principalId,
        content,
        Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join(""),
        content.byteLength,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.artifacts set current_version_id=$2 where id=$1`,
      [fixture.ids.artifactId, elsewhere],
    );
    const live = await readDraft(fixture, draft.id);
    const before = await counts(fixture, draft.id);
    const conflict = await publish(fixture, live);
    assertEquals(conflict.status, 409, await conflict.clone().text());
    assertEquals(
      (await conflict.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "alpha later omega",
    );
    assertEquals(await counts(fixture, draft.id), before);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a projected thread lands on the version with its mapping, once, and an outdated one refuses the publish", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    const created = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/comments`,
      "POST",
      {
        body: "Is this the right word?",
        epoch: draft.epoch,
        startCursor: selected.startCursor,
        endCursor: selected.endCursor,
        quote: selected.text,
        mutationId: crypto.randomUUID(),
      },
    ));
    assertEquals(created.status, 201, await created.clone().text());
    const root = await responseJson(created) as DraftComment;
    for (const body of ["Agreed.", "Withdrawn."]) {
      const replied = await fixture.app.fetch(jsonDraftRequest(
        fixture,
        `/v1/drafts/${draft.id}/comments`,
        "POST",
        { body, rootId: root.id, mutationId: crypto.randomUUID() },
      ));
      assertEquals(replied.status, 201, await replied.clone().text());
      const reply = await responseJson(replied) as DraftComment & {
        version: number;
      };
      if (body === "Withdrawn.") {
        const deleted = await fixture.app.fetch(draftRequest(
          fixture,
          `/v1/drafts/${draft.id}/comments/${reply.id}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
              "if-match": `"${reply.version}"`,
            },
            body: JSON.stringify({ deleted: true }),
          },
        ));
        assertEquals(deleted.status, 200, await deleted.clone().text());
        await deleted.body?.cancel();
      }
    }
    const cutoff = await readDraft(fixture, draft.id);
    // After the cutoff the anchored text is deleted: the live thread is
    // outdated, but the frozen cutoff still holds "target".
    await applied(
      await edit(fixture, cutoff, await slice(fixture, cutoff, 5, 12), ""),
    );
    assertEquals((await readDraft(fixture, draft.id)).text, "alpha omega");

    const published = await publish(fixture, cutoff, [root.id]);
    assertEquals(published.status, 201, await published.clone().text());
    const publication = await responseJson(published) as Publication;
    assertEquals(
      await versionText(fixture, publication.artifactVersionId),
      "alpha target omega",
    );
    const listed = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/artifact-versions/${publication.artifactVersionId}/comments`,
    ));
    assertEquals(listed.status, 200, await listed.clone().text());
    const pinned = (await responseJson(listed) as { items: ArtifactComment[] })
      .items;
    assertEquals(pinned.length, 1);
    assertEquals(pinned[0].body, "Is this the right word?");
    assertEquals(pinned[0].status, "open");
    assertEquals(pinned[0].authorId, fixture.ids.principalId);
    assertEquals(pinned[0].anchor, {
      kind: "markdown",
      blockIndex: 0,
      blockText: "alpha target omega",
      start: 6,
      end: 12,
      selectedText: "target",
      previousBlock: null,
      nextBlock: null,
    });
    const replies = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/artifact-versions/${publication.artifactVersionId}/comments?rootId=${
        pinned[0].id
      }`,
    ));
    assertEquals(replies.status, 200, await replies.clone().text());
    // The deleted draft reply is not copied.
    assertEquals(
      (await responseJson(replies) as { items: ArtifactComment[] }).items.map((
        item,
      ) => item.body),
      ["Agreed."],
    );

    // The draft thread is unchanged and open, and names what it became.
    const threads = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/comments`,
    ));
    assertEquals(threads.status, 200, await threads.clone().text());
    const thread = (await responseJson(threads) as { items: DraftComment[] })
      .items[0];
    assertEquals(thread.id, root.id);
    assertEquals(thread.status, "open");
    assertEquals(thread.anchorState, "outdated");
    assertEquals(thread.publishedAs, [{
      artifactVersionId: publication.artifactVersionId,
      artifactCommentId: pinned[0].id,
      sourceCheckpointId: cutoff.checkpointId,
    }]);
    const projected = await counts(fixture, draft.id);
    assertEquals(projected.mappings, 2);
    assertEquals(projected.comments, 2);

    // A replay answers with the publication and copies nothing again.
    const replay = await publish(fixture, cutoff, [root.id]);
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(await responseJson(replay), publication);
    assertEquals(await counts(fixture, draft.id), projected);

    // At the next cutoff the anchored text is gone: projecting the thread
    // refuses the whole publish and writes nothing.
    const next = await readDraft(fixture, draft.id);
    assertEquals(
      await refusal(await publish(fixture, next, [root.id])),
      "projected_thread_outdated",
    );
    assertEquals(await counts(fixture, draft.id), projected);
    const plain = await publish(fixture, next);
    assertEquals(plain.status, 201, await plain.clone().text());
    await plain.body?.cancel();
  } finally {
    await cleanup(fixture);
  }
});
