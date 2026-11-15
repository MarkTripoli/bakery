import { assertEquals, assertExists } from "@std/assert";
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
};
type Suggestion = {
  id: string;
  draftId: string;
  epoch: number;
  state: string;
  refusalReason: string | null;
  requestedById: string;
  requestedByName: string;
  actorKind: string;
  agentName: string | null;
  requestId: string;
  decidedById: string | null;
  appliedServerSequence: string | null;
  expectedText: string;
  replacement: string;
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

async function readDraft(fixture: DraftFixture, draftId: string) {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draftId}`,
  ));
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

function proposal(
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

async function list(
  fixture: DraftFixture,
  draftId: string,
  query = "",
): Promise<{ items: Suggestion[]; nextCursor: string | null }> {
  const response = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draftId}/suggestions${query}`,
  ));
  assertEquals(response.status, 200);
  return await responseJson(response) as {
    items: Suggestion[];
    nextCursor: string | null;
  };
}

async function decide(
  fixture: DraftFixture,
  draftId: string,
  suggestionId: string,
  decision: "accept" | "reject",
  init: RequestInit = {},
): Promise<Response> {
  return await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/drafts/${draftId}/suggestions/${suggestionId}/${decision}`,
    { method: "POST", ...init },
  ));
}

async function cleanup(fixture: DraftFixture): Promise<void> {
  try {
    await cleanupDraftFixture(fixture);
  } finally {
    await fixture.close();
  }
}

/** An agent principal with an access token that may write drafts. */
async function agentToken(
  fixture: DraftFixture,
  name = "test agent",
): Promise<{ bearer: string; principalId: string }> {
  const principalId = crypto.randomUUID();
  const body = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const secret = `bky_${body}`;
  await fixture.pgDatabase.query(
    `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
     values ($1,null,$2,'service')`,
    [principalId, name],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id,organization_id,principal_id,role,status,joined_at,created_at,
       updated_at,version
     ) values ($1,$2,$3,'developer','active',now(),now(),now(),1)`,
    [crypto.randomUUID(), fixture.ids.organizationId, principalId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.access_tokens (
       organization_id,principal_id,created_by_principal_id,name,prefix,
       secret_sha256,scopes,expires_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      fixture.ids.organizationId,
      principalId,
      fixture.ids.principalId,
      name,
      secret.slice(0, 12),
      await sha256Hex(secret),
      ["bakery:read", "bakery:operate"],
      new Date(Date.now() + 3_600_000),
    ],
  );
  return { bearer: secret, principalId };
}

function bearerHeaders(bearer: string): HeadersInit {
  return { authorization: `Bearer ${bearer}` };
}

Deno.test("a waiting suggestion is listed, accepted and applied as an edit", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    assertEquals(selected.text, "target");

    const proposed = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      "POST",
      proposal(draft, selected, crypto.randomUUID(), "replacement"),
    ));
    assertEquals(proposed.status, 201);
    const suggestion = await responseJson(proposed) as Suggestion;
    assertEquals(suggestion.state, "waiting");
    assertEquals(suggestion.actorKind, "person");
    assertEquals(suggestion.expectedText, "target");
    assertEquals(suggestion.replacement, "replacement");
    assertEquals(suggestion.decidedById, null);
    assertEquals(suggestion.appliedServerSequence, null);
    assertExists(suggestion.requestId);
    // Nothing was applied: a suggestion changes the draft only when accepted.
    assertEquals(
      (await readDraft(fixture, draft.id)).text,
      "alpha target omega",
    );

    const listed = await list(fixture, draft.id, "?state=waiting");
    assertEquals(listed.items.length, 1);
    assertEquals(listed.items[0].id, suggestion.id);
    assertEquals(listed.nextCursor, null);

    const accepted = await decide(fixture, draft.id, suggestion.id, "accept");
    assertEquals(accepted.status, 201);
    const decided = await responseJson(accepted) as Suggestion;
    assertEquals(decided.state, "accepted");
    assertEquals(decided.decidedById, fixture.ids.principalId);
    assertExists(decided.appliedServerSequence);

    const applied = await readDraft(fixture, draft.id);
    assertEquals(applied.text, "alpha replacement omega");
    assertEquals(applied.receipts.length, 1);
    assertEquals(applied.receipts[0].actorId, fixture.ids.principalId);
    // The applied edit is an ordinary idempotent edit: its mutation id is the
    // one the acceptance committed, and it is not the suggestion's.
    assertEquals(
      applied.receipts[0].mutationId === suggestion.id,
      false,
    );
    assertEquals(
      applied.serverSequence,
      decided.appliedServerSequence,
    );

    // Accepting again answers with the same suggestion and applies nothing.
    const replayed = await decide(fixture, draft.id, suggestion.id, "accept");
    assertEquals(replayed.status, 201);
    assertEquals(
      (await responseJson(replayed) as Suggestion).appliedServerSequence,
      decided.appliedServerSequence,
    );
    assertEquals((await readDraft(fixture, draft.id)).receipts.length, 1);
    // The other decision cannot change a decided suggestion.
    const rejection = await decide(fixture, draft.id, suggestion.id, "reject");
    assertEquals(rejection.status, 409);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a suggestion whose anchored text changed no longer fits and applies nothing", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    const proposed = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      "POST",
      proposal(draft, selected, crypto.randomUUID(), "replacement"),
    ));
    assertEquals(proposed.status, 201);
    const suggestion = await responseJson(proposed) as Suggestion;

    // A person edits the same range, so the suggestion's text is gone.
    const edited = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/edits`,
      "POST",
      proposal(
        draft,
        selected,
        crypto.randomUUID(),
        "person's words",
      ),
    ));
    assertEquals(edited.status, 201);

    const accepted = await decide(fixture, draft.id, suggestion.id, "accept");
    assertEquals(accepted.status, 201);
    const decided = await responseJson(accepted) as Suggestion;
    assertEquals(decided.state, "no_longer_fits");
    assertEquals(decided.refusalReason, "text_changed");
    assertEquals(decided.decidedById, fixture.ids.principalId);
    assertEquals(decided.appliedServerSequence, null);
    const after = await readDraft(fixture, draft.id);
    assertEquals(after.text, "alpha person's words omega");
    assertEquals(after.receipts.length, 1);

    const listed = await list(fixture, draft.id, "?state=no_longer_fits");
    assertEquals(listed.items.length, 1);
    assertEquals(listed.items[0].refusalReason, "text_changed");
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a suggestion from a moved-on draft is refused when proposed", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    const stale = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      "POST",
      { ...proposal(draft, selected, crypto.randomUUID(), "x"), epoch: 2 },
    ));
    assertEquals(stale.status, 412);
    assertEquals((await stale.json()).reason, "draft_moved_on");
    assertEquals((await list(fixture, draft.id)).items.length, 0);

    // The anchor is verified before anything is recorded: text that no longer
    // matches the draft is refused, not stored as an unusable suggestion.
    const wrongText = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      "POST",
      {
        ...proposal(draft, selected, crypto.randomUUID(), "x"),
        expectedText: "nothing like this",
        expectedDigest: await sha256Hex("nothing like this"),
      },
    ));
    assertEquals(wrongText.status, 412);
    assertEquals((await wrongText.json()).reason, "text_changed");
    assertEquals((await list(fixture, draft.id)).items.length, 0);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("a retried proposal answers with the same suggestion, a changed payload does not", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    const mutationId = crypto.randomUUID();
    const first = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      "POST",
      proposal(draft, selected, mutationId, "replacement"),
    ));
    assertEquals(first.status, 201);
    const suggestion = await responseJson(first) as Suggestion;

    const retried = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      "POST",
      proposal(draft, selected, mutationId, "replacement"),
    ));
    assertEquals(retried.status, 201);
    assertEquals((await responseJson(retried) as Suggestion).id, suggestion.id);
    assertEquals((await list(fixture, draft.id)).items.length, 1);

    const changed = await fixture.app.fetch(jsonDraftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      "POST",
      proposal(draft, selected, mutationId, "different"),
    ));
    assertEquals(changed.status, 422);
    assertEquals((await changed.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("an agent proposes suggestions and may never decide or edit one", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    const agent = await agentToken(fixture);
    const proposed = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearerHeaders(agent.bearer),
        },
        body: JSON.stringify(
          proposal(draft, selected, crypto.randomUUID(), "agent words"),
        ),
      },
    ));
    assertEquals(proposed.status, 201);
    const suggestion = await responseJson(proposed) as Suggestion;
    // O50: attributed to the principal the agent acts for, labelled as an
    // agent's action, naming the token it presented.
    assertEquals(suggestion.actorKind, "agent");
    assertEquals(suggestion.requestedById, agent.principalId);
    assertEquals(suggestion.agentName, "test agent");

    // A decision belongs to a person (O52): an agent may not accept or reject.
    for (const decision of ["accept", "reject"] as const) {
      const refused = await decide(
        fixture,
        draft.id,
        suggestion.id,
        decision,
        { headers: bearerHeaders(agent.bearer) },
      );
      assertEquals(refused.status, 403);
      assertEquals(
        (await refused.json()).reason,
        "suggestion_decision_requires_person",
      );
    }
    // An agent changes a shared draft only by suggesting, never directly.
    const direct = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/edits`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearerHeaders(agent.bearer),
        },
        body: JSON.stringify(
          proposal(draft, selected, crypto.randomUUID(), "agent words"),
        ),
      },
    ));
    assertEquals(direct.status, 403);
    assertEquals(
      (await direct.json()).reason,
      "agent_edit_requires_suggestion",
    );

    // A person accepting the agent's suggestion applies it as that person's
    // own edit.
    const accepted = await decide(fixture, draft.id, suggestion.id, "accept");
    assertEquals(accepted.status, 201);
    assertEquals(
      (await responseJson(accepted) as Suggestion).state,
      "accepted",
    );
    const applied = await readDraft(fixture, draft.id);
    assertEquals(applied.text, "alpha agent words omega");
    assertEquals(applied.receipts[0].actorId, fixture.ids.principalId);
  } finally {
    await cleanup(fixture);
  }
});

Deno.test("the suggestion list pages by keyset and a cursor is bound to its listing", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  try {
    const draft = await openDraft(fixture);
    const selected = await slice(fixture, draft, 6, 12);
    for (let index = 0; index < 3; index += 1) {
      const proposed = await fixture.app.fetch(jsonDraftRequest(
        fixture,
        `/v1/drafts/${draft.id}/suggestions`,
        "POST",
        proposal(draft, selected, crypto.randomUUID(), `replacement ${index}`),
      ));
      assertEquals(proposed.status, 201);
    }
    const first = await list(fixture, draft.id, "?limit=2");
    assertEquals(first.items.length, 2);
    assertExists(first.nextCursor);
    const second = await list(
      fixture,
      draft.id,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    assertEquals(second.items.length, 1);
    assertEquals(second.nextCursor, null);
    assertEquals(
      [first.items[0].replacement, first.items[1].replacement],
      ["replacement 0", "replacement 1"],
    );
    assertEquals(second.items[0].replacement, "replacement 2");

    // The same cursor under a different state filter names another listing.
    const reused = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/drafts/${draft.id}/suggestions?state=accepted&cursor=${
        encodeURIComponent(first.nextCursor!)
      }`,
    ));
    assertEquals(reused.status, 400);
    assertEquals((await reused.json()).code, "INVALID_CURSOR");
  } finally {
    await cleanup(fixture);
  }
});
