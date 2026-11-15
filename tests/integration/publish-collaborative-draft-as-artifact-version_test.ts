import { assert, assertEquals, assertExists } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import {
  createCollaborationRegistry,
  type DraftPublicationNotice,
} from "../../apps/server/src/modules/knowledge/collaboration-socket.ts";
import { authTestOrigin, signSessionCookie } from "../helpers/auth.ts";
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
  canPublish: boolean;
};
type Slice = {
  checkpointId: string;
  text: string;
  textDigest: string;
  startCursor: string;
  endCursor: string;
};
type Publication = {
  draftId: string;
  epoch: number;
  checkpointId: string;
  serverSequence: string;
  textDigest: string;
  artifactId: string;
  artifactVersionId: string;
  versionNumber: number;
  sha256: string;
  publishedById: string;
  publishedByName: string;
  actorKind: "person" | "agent";
  publishedAt: string;
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

async function readDraft(
  fixture: Pick<DraftFixture, "cookie" | "ids" | "app">,
  id: string,
): Promise<Draft> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${id}`,
  ));
  assertEquals(response.status, 200, await response.clone().text());
  return await responseJson(response) as Draft;
}

/** Replaces UTF-16 6..end (the fixture's `target`) through drafts.edit. */
async function editTarget(
  fixture: DraftFixture,
  draft: Draft,
  replacement: string,
  end = 12,
): Promise<void> {
  const sliced = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=6&endUtf16=${end}`,
  ));
  assertEquals(sliced.status, 200, await sliced.clone().text());
  const selected = await responseJson(sliced) as Slice;
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

function publish(
  fixture: Pick<DraftFixture, "cookie" | "ids" | "app">,
  draft: Pick<Draft, "id" | "checkpointId" | "textDigest">,
  idempotencyKey?: string,
): Promise<Response> {
  const request = jsonDraftRequest(
    fixture,
    `/v1/drafts/${draft.id}/publications`,
    "POST",
    { checkpointId: draft.checkpointId, textDigest: draft.textDigest },
  );
  if (idempotencyKey) request.headers.set("Idempotency-Key", idempotencyKey);
  return Promise.resolve(fixture.app.fetch(request));
}

async function versionContent(
  fixture: DraftFixture,
  versionId: string,
): Promise<{ text: string; metadata: Record<string, unknown> }> {
  const row = (await fixture.pgDatabase.query<{
    content: Uint8Array;
    metadata: Record<string, unknown>;
  }>(
    `select content,metadata from bakery.artifact_versions where id=$1`,
    [versionId],
  )).rows[0];
  assertExists(row);
  return {
    text: new TextDecoder().decode(row.content),
    metadata: row.metadata,
  };
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

Deno.test("publishing freezes the checkpoint as the next version, once, and is recoverable", async () => {
  const registry = createCollaborationRegistry();
  const notices: [string, DraftPublicationNotice][] = [];
  const notify = registry.notifyDraftPublished.bind(registry);
  registry.notifyDraftPublished = (organizationId, publication) => {
    notices.push([organizationId, publication]);
    notify(organizationId, publication);
  };
  const fixture = await openDraftFixture("alpha target omega", {
    collaborationSocket: { registry },
  });
  try {
    const opened = await openDraft(fixture);
    assertEquals(opened.canPublish, true);
    await editTarget(fixture, opened, "first");
    const cutoff = await readDraft(fixture, opened.id);
    assertEquals(cutoff.text, "alpha first omega");

    // Not published yet: the read answers 404.
    const before = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${opened.id}/publications/${cutoff.checkpointId}`,
    ));
    assertEquals(before.status, 404);
    await before.body?.cancel();

    const key = crypto.randomUUID();
    const first = await publish(fixture, cutoff, key);
    assertEquals(first.status, 201, await first.clone().text());
    const publication = await responseJson(first) as Publication;
    assertEquals(publication.draftId, opened.id);
    assertEquals(publication.checkpointId, cutoff.checkpointId);
    assertEquals(publication.serverSequence, cutoff.serverSequence);
    assertEquals(publication.textDigest, cutoff.textDigest);
    assertEquals(publication.sha256, cutoff.textDigest);
    assertEquals(publication.artifactId, fixture.ids.artifactId);
    assertEquals(publication.versionNumber, 2);
    assertEquals(publication.publishedById, fixture.ids.principalId);
    assertEquals(publication.publishedByName, "Draft Developer");
    assertEquals(publication.actorKind, "person");

    // Editing continues after the cutoff; the version keeps the cutoff text.
    await editTarget(fixture, cutoff, "later", 11);
    assertEquals(
      (await readDraft(fixture, opened.id)).text,
      "alpha later omega",
    );
    const version = await versionContent(
      fixture,
      publication.artifactVersionId,
    );
    assertEquals(version.text, "alpha first omega");
    assertEquals(version.metadata, {
      sourceDraftId: opened.id,
      sourceDraftEpoch: cutoff.epoch,
      sourceDraftCheckpointId: cutoff.checkpointId,
      sourceDraftServerSequence: cutoff.serverSequence,
      publishedActorKind: "person",
    });

    // Retries: the same key, then another key for the same checkpoint, both
    // answer with the one committed version.
    const sameKey = await publish(fixture, cutoff, key);
    assertEquals(sameKey.status, 201);
    assertEquals(await responseJson(sameKey), publication);
    const otherKey = await publish(fixture, cutoff, crypto.randomUUID());
    assertEquals(otherKey.status, 201);
    assertEquals(await responseJson(otherKey), publication);
    const noKey = await publish(fixture, cutoff);
    assertEquals(await responseJson(noKey), publication);

    // A lost answer is recovered by the read, and by artifactVersions.list.
    const recovered = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${opened.id}/publications/${cutoff.checkpointId}`,
    ));
    assertEquals(recovered.status, 200);
    assertEquals(await responseJson(recovered), publication);
    const listed = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/artifacts/${fixture.ids.artifactId}/versions`,
    ));
    assertEquals(listed.status, 200, await listed.clone().text());
    const items = (await responseJson(listed) as {
      items: { id: string; metadata: Record<string, unknown> }[];
    }).items;
    assert(
      items.some((item) =>
        item.id === publication.artifactVersionId &&
        item.metadata.sourceDraftCheckpointId === cutoff.checkpointId
      ),
    );

    const facts = await fixture.pgDatabase.query<{
      publications: number;
      versions: number;
      events: number;
      current: string;
      audits: number;
    }>(
      `select
         (select count(*)::int from bakery.artifact_draft_publications
           where draft_id=$2) as publications,
         (select count(*)::int from bakery.artifact_versions
           where artifact_id=$3) as versions,
         (select count(*)::int from bakery.domain_events
           where organization_id=$1 and event_type='draft.published'
             and aggregate_id=$2 and aggregate_version=2
             and payload->>'resourceId'=$2::text) as events,
         (select current_version_id::text from bakery.artifacts where id=$3)
           as current,
         (select count(*)::int from bakery.audit_events
           where organization_id=$1 and operation='draftPublications.create'
             and resource_id=$4 and details->>'actorKind'='person') as audits`,
      [
        fixture.ids.organizationId,
        opened.id,
        fixture.ids.artifactId,
        publication.artifactVersionId,
      ],
    );
    assertEquals(facts.rows[0], {
      publications: 1,
      versions: 2,
      events: 1,
      current: publication.artifactVersionId,
      audits: 1,
    });
    // Pushed to the draft's room once, after commit; retries announce nothing.
    assertEquals(notices, [[fixture.ids.organizationId, publication]]);

    // A key reused for another checkpoint is refused.
    const latest = await readDraft(fixture, opened.id);
    const reused = await publish(fixture, latest, key);
    assertEquals(reused.status, 422);
    assertEquals(
      (await reused.json() as { code: string }).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    // A digest the publisher did not preview is refused.
    const wrongDigest = await publish(fixture, {
      ...latest,
      textDigest: "0".repeat(64),
    });
    assertEquals(wrongDigest.status, 412);
    await wrongDigest.body?.cancel();

    // The next cutoff becomes version 3; the older one cannot follow it.
    const next = await publish(fixture, latest);
    assertEquals(next.status, 201, await next.clone().text());
    assertEquals((await responseJson(next) as Publication).versionNumber, 3);
    const older = await publish(fixture, opened);
    assertEquals(older.status, 412);
    await older.body?.cancel();
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a version written elsewhere while the draft is open is a conflict", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    await fixture.pgDatabase.query(
      `update bakery.artifacts set current_version_id=null where id=$1`,
      [fixture.ids.artifactId],
    );
    const response = await publish(fixture, draft);
    assertEquals(response.status, 409, await response.clone().text());
    assertEquals(
      (await response.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a viewer cannot publish and another organization cannot see the draft", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  const foreign = await openDraftFixture("foreign");
  const viewer = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    token: crypto.randomUUID(),
  };
  try {
    const draft = await openDraft(fixture);
    const db = fixture.pgDatabase;
    const now = new Date();
    await db.query(
      `insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt")
       values ($1,'Draft Viewer',$2,true,$3,$3)`,
      [
        viewer.providerUserId,
        `viewer-${viewer.providerUserId}@example.test`,
        now,
      ],
    );
    await db.query(
      `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
       values ($1,$2,'Draft Viewer','human')`,
      [viewer.principalId, viewer.providerUserId],
    );
    await db.query(
      `insert into public.member (id,"organizationId","userId",role,status,"createdAt","joinedAt","updatedAt")
       values ($1,$2,$3,'viewer','active',$4,$4,$4)`,
      [
        crypto.randomUUID(),
        fixture.ids.organizationId,
        viewer.providerUserId,
        now,
      ],
    );
    await db.query(
      `insert into bakery.organization_memberships (id,organization_id,principal_id,role,status,joined_at,created_at,updated_at,version)
       values ($1,$2,$3,'viewer','active',$4,$4,$4,1)`,
      [
        crypto.randomUUID(),
        fixture.ids.organizationId,
        viewer.principalId,
        now,
      ],
    );
    await db.query(
      `insert into public.session (id,token,"userId","expiresAt","createdAt","updatedAt")
       values ($1,$2,$3,$4,$5,$5)`,
      [
        crypto.randomUUID(),
        viewer.token,
        viewer.providerUserId,
        new Date(Date.now() + 3_600_000),
        now,
      ],
    );
    const asViewer = {
      ...fixture,
      cookie: await signSessionCookie(
        viewer.token,
        fixture.config.auth!.secret,
      ),
    };
    const seen = await readDraft(asViewer, draft.id);
    assertEquals(seen.canPublish, false);
    const refused = await publish(asViewer, draft);
    assertEquals(refused.status, 403, await refused.clone().text());
    await refused.body?.cancel();

    const hidden = await publish(foreign, draft);
    assertEquals(hidden.status, 404, await hidden.clone().text());
    await hidden.body?.cancel();
    const hiddenRead = await foreign.app.fetch(draftRequest(
      foreign,
      `/v1/drafts/${draft.id}/publications/${draft.checkpointId}`,
    ));
    assertEquals(hiddenRead.status, 404);
    await hiddenRead.body?.cancel();

    const published = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.artifact_draft_publications
        where draft_id=$1`,
      [draft.id],
    );
    assertEquals(published.rows[0]?.count, 0);
  } finally {
    try {
      await cleanupDraftFixture(fixture);
      await fixture.pgDatabase.query(
        'delete from public.session where "userId"=$1',
        [viewer.providerUserId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.principals where id=$1",
        [
          viewer.principalId,
        ],
      );
      await fixture.pgDatabase.query('delete from public."user" where id=$1', [
        viewer.providerUserId,
      ]);
    } finally {
      await fixture.close();
      await cleanup(foreign);
    }
  }
});

Deno.test("an agent with the grant publishes for its principal, labelled as an agent", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const secret = `bky_${
      crypto.randomUUID().replaceAll("-", "").padEnd(43, "x")
    }`;
    const tokenId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.access_tokens (
         id,organization_id,principal_id,created_by_principal_id,name,prefix,
         secret_sha256,scopes,expires_at
       ) values ($1,$2,$3,$3,'agent token',$4,$5,$6,$7)`,
      [
        tokenId,
        fixture.ids.organizationId,
        fixture.ids.principalId,
        secret.slice(0, 12),
        await sha256Hex(secret),
        ["bakery:operate"],
        new Date(Date.now() + 3_600_000),
      ],
    );
    const headers = new Headers({
      authorization: `Bearer ${secret}`,
      "Bakery-Organization-Id": fixture.ids.organizationId,
      "content-type": "application/json",
    });
    const read = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/drafts/${draft.id}`, { headers }),
    );
    assertEquals(read.status, 200, await read.clone().text());
    assertEquals((await read.json() as Draft).canPublish, true);
    const response = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/drafts/${draft.id}/publications`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          checkpointId: draft.checkpointId,
          textDigest: draft.textDigest,
        }),
      }),
    );
    assertEquals(response.status, 201, await response.clone().text());
    const publication = await response.json() as Publication;
    assertEquals(publication.actorKind, "agent");
    assertEquals(publication.publishedById, fixture.ids.principalId);
    const version = await versionContent(
      fixture,
      publication.artifactVersionId,
    );
    assertEquals(version.metadata.publishedActorKind, "agent");
    const row = await fixture.pgDatabase.query<{
      access_token_id: string;
      author_id: string;
    }>(
      `select p.access_token_id::text,v.author_id::text
         from bakery.artifact_draft_publications p
         join bakery.artifact_versions v on v.id=p.artifact_version_id
        where p.draft_id=$1`,
      [draft.id],
    );
    assertEquals(row.rows[0], {
      access_token_id: tokenId,
      author_id: fixture.ids.principalId,
    });

    // A read-only token is refused before anything is written.
    await fixture.pgDatabase.query(
      `update bakery.access_tokens set scopes=$2 where id=$1`,
      [tokenId, ["bakery:read"]],
    );
    const readOnly = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/drafts/${draft.id}`, { headers }),
    );
    assertEquals((await readOnly.json() as Draft).canPublish, false);
  } finally {
    await cleanup(fixture);
  }
});
