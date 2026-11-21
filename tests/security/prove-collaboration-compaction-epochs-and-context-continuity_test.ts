// #38 B12.07: security proofs for collaboration compaction, epochs and context
// continuity (AC3: revoked access reuses no private state; exhausted budgets do
// not loop). Through the mounted API and a real database.
import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
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

function asAgent(
  fixture: DraftFixture,
  bearer: string,
  path: string,
  body: unknown,
) {
  const request = jsonDraftRequest(fixture, path, "POST", body);
  request.headers.set("authorization", `Bearer ${bearer}`);
  request.headers.delete("cookie");
  return Promise.resolve(fixture.app.fetch(request));
}

/** An agent principal with an access token of the given scopes. */
async function agentToken(fixture: DraftFixture, scopes: string[]) {
  const principalId = crypto.randomUUID();
  const body = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const secret = `bky_${body}`;
  await fixture.pgDatabase.query(
    `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
     values ($1,null,'test agent','service')`,
    [principalId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id,organization_id,principal_id,role,status,joined_at,created_at,
       updated_at,version
     ) values ($1,$2,$3,'developer','active',now(),now(),now(),1)`,
    [crypto.randomUUID(), fixture.ids.organizationId, principalId],
  );
  const token = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.access_tokens (
       organization_id,principal_id,created_by_principal_id,name,prefix,
       secret_sha256,scopes,expires_at
     ) values ($1,$2,$3,'test agent',$4,$5,$6,$7) returning id`,
    [
      fixture.ids.organizationId,
      principalId,
      fixture.ids.principalId,
      secret.slice(0, 12),
      await sha256Hex(secret),
      scopes,
      new Date(Date.now() + 3_600_000),
    ],
  );
  return { bearer: secret, tokenId: token.rows[0].id };
}

async function suggestionCount(fixture: DraftFixture, draftId: string) {
  const result = await fixture.pgDatabase.query<{ n: number }>(
    `select count(*)::int as n from bakery.artifact_draft_suggestions
      where organization_id=$1 and draft_id=$2`,
    [fixture.ids.organizationId, draftId],
  );
  return result.rows[0].n;
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

Deno.test("a revoked token or a read-only token reuses no draft state and records nothing", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const body = await editBody(fixture, draft, "agent!");
    const path = `/v1/drafts/${draft.id}/suggestions`;

    const writer = await agentToken(fixture, ["bakery:read", "bakery:operate"]);
    const ok = await asAgent(fixture, writer.bearer, path, body);
    assertEquals(ok.status, 201, await ok.clone().text());
    await ok.body?.cancel();
    assertEquals(await suggestionCount(fixture, draft.id), 1);

    // The token is revoked: the same call, new mutation, is refused and nothing is recorded.
    await fixture.pgDatabase.query(
      "update bakery.access_tokens set revoked_at = clock_timestamp() where id = $1",
      [writer.tokenId],
    );
    const revoked = await asAgent(fixture, writer.bearer, path, {
      ...body,
      mutationId: crypto.randomUUID(),
    });
    assertEquals(revoked.status, 401, await revoked.clone().text());
    await revoked.body?.cancel();
    const revokedRead = await fixture.app.fetch(
      new Request(
        `${
          new URL(draftRequest(fixture, "/v1/drafts/x").url).origin
        }/v1/drafts/${draft.id}`,
        {
          headers: { authorization: `Bearer ${writer.bearer}` },
        },
      ),
    );
    assert(revokedRead.status === 401 || revokedRead.status === 403);
    await revokedRead.body?.cancel();

    // A token without the operate scope cannot propose either.
    const reader = await agentToken(fixture, ["bakery:read"]);
    const readOnly = await asAgent(fixture, reader.bearer, path, {
      ...body,
      mutationId: crypto.randomUUID(),
    });
    assertEquals(readOnly.status, 403, await readOnly.clone().text());
    await readOnly.body?.cancel();
    assertEquals(await suggestionCount(fixture, draft.id), 1);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("another organization can neither roll over nor propose on a draft", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const body = await editBody(fixture, draft, "other!");
    const stranger = crypto.randomUUID();
    for (
      const [path, payload] of [
        [`/v1/drafts/${draft.id}/rollover`, {
          epoch: draft.epoch,
          checkpointId: draft.checkpointId,
        }],
        [`/v1/drafts/${draft.id}/suggestions`, body],
      ] as const
    ) {
      const response = await fixture.app.fetch(
        jsonDraftRequest(fixture, path, "POST", payload, stranger),
      );
      assert(
        [403, 404].includes(response.status),
        `${path} answered ${response.status}`,
      );
      await response.body?.cancel();
    }
    assertEquals((await readDraft(fixture, draft.id)).epoch, 1);
    assertEquals(await suggestionCount(fixture, draft.id), 0);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("an epoch at its cap is refused every time without looping, and its rows do not change", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    // Three newest checkpoints of 6 MiB each: pinned by recency, so no pass can
    // free space and the next edit would pass the 16 MiB cap.
    for (const sequence of [100, 101, 102]) {
      await fixture.pgDatabase.query(
        `insert into bakery.artifact_draft_checkpoints (
           organization_id,draft_id,epoch,server_sequence,state,frontiers,
           text_content,text_digest
         ) values ($1,$2,1,$3,convert_to(repeat('a',$4::int),'UTF8'),'\\x00'::bytea,'','x')`,
        [fixture.ids.organizationId, draft.id, sequence, 6 * 1_048_576],
      );
    }
    const counts = async () =>
      (await fixture.pgDatabase.query<{ c: number; u: number; r: number }>(
        `select
           (select count(*)::int from bakery.artifact_draft_checkpoints where draft_id=$1) as c,
           (select count(*)::int from bakery.artifact_draft_updates where draft_id=$1) as u,
           (select count(*)::int from bakery.artifact_draft_receipts where draft_id=$1) as r`,
        [draft.id],
      )).rows[0];
    const before = await counts();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = Date.now();
      const refused = await fixture.app.fetch(jsonDraftRequest(
        fixture,
        `/v1/drafts/${draft.id}/edits`,
        "POST",
        await editBody(fixture, draft, `try${attempt}!`),
      ));
      assertEquals(refused.status, 409, await refused.clone().text());
      assertEquals(
        (await refused.json() as { code: string }).code,
        "STORAGE_QUOTA_EXCEEDED",
      );
      assert(
        Date.now() - started < 20_000,
        "an exhausted epoch answers promptly",
      );
      assertEquals(await counts(), before);
    }
  } finally {
    await cleanup(fixture);
  }
});
