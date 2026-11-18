import { assert, assertEquals } from "@std/assert";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import { authTestOrigin, openAuthFixture } from "../helpers/auth.ts";
import {
  call,
  cleanupSeededOrganizations,
  type Fixture,
  type Seed,
  seedOrganization,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import type {
  CoordinatorEffect,
  CoordinatorTurnExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";
import { processNextConversationTurn } from "../../apps/server/src/modules/conversation/turn-runtime.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  seedFundedCodingAgent,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";

// Issue #420: unlisted definitions, the definitionProposal coordinator effect,
// running a frozen unlisted version and save as workflow.

type Proposal = {
  id: string;
  state: string;
  workflowId: string | null;
  baseDraftVersion: number | null;
  version: number;
  decidedBy: string | null;
};
type Workflow = {
  id: string;
  name: string;
  visibility: string;
  version: number;
  origin: {
    kind: string;
    conversationId: string | null;
    turnId: string | null;
  };
};

const definition = JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec));

async function withFixture(work: (fixture: Fixture) => Promise<void>) {
  const fixture = await openAuthFixture();
  try {
    await work(fixture);
  } finally {
    try {
      await cleanupSeededOrganizations(fixture);
    } finally {
      await fixture.close();
    }
  }
}

/** One coordinator turn answering with exactly these effects. */
async function runTurn(
  fixture: Fixture,
  seed: Seed,
  effects: CoordinatorEffect[],
): Promise<{ id: string; status: string; failure: { code: string } | null }> {
  const sent = await sendMessage(fixture, seed, "agent_request", "build it");
  assert(sent.status === 201, `send ${sent.status}`);
  const executor: CoordinatorTurnExecutor = {
    execute: () => Promise.resolve({ status: "completed", effects }),
  };
  await processNextConversationTurn({
    database: fixture.runtimePgDatabase,
    executor,
    leaseMs: 60_000,
    heartbeatMs: 100,
  }, {
    organizationId: seed.organizationId,
    conversationId: seed.conversationId,
  });
  const turn = await fixture.pgDatabase.query<
    { id: string; status: string; failure: { code: string } | null }
  >(
    `select id, status, failure from bakery.conversation_turns
      where organization_id = $1 and conversation_id = $2
      order by created_at desc limit 1`,
    [seed.organizationId, seed.conversationId],
  );
  return turn.rows[0];
}

async function latestProposalId(fixture: Fixture, seed: Seed) {
  const row = await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.workflow_definition_proposals
      where organization_id = $1 order by created_at desc, id desc limit 1`,
    [seed.organizationId],
  );
  return row.rows[0]?.id;
}

/** An admin-role service principal with an access token: an agent. */
async function agentToken(fixture: Fixture, seed: Seed): Promise<string> {
  const principalId = crypto.randomUUID();
  const body = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const secret = `bky_${body}`;
  const db = fixture.pgDatabase;
  await db.query(
    `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
     values ($1,null,'proposal agent','service')`,
    [principalId],
  );
  await db.query(
    `insert into bakery.organization_memberships (
       id,organization_id,principal_id,role,status,joined_at,created_at,
       updated_at,version
     ) values ($1,$2,$3,'admin','active',now(),now(),now(),1)`,
    [crypto.randomUUID(), seed.organizationId, principalId],
  );
  await db.query(
    `insert into bakery.access_tokens (
       organization_id,principal_id,created_by_principal_id,name,prefix,
       secret_sha256,scopes,expires_at
     ) values ($1,$2,$3,'proposal agent',$4,$5,$6,$7)`,
    [
      seed.organizationId,
      principalId,
      seed.principalId,
      secret.slice(0, 12),
      await sha256Hex(secret),
      ["bakery:read", "bakery:operate", "bakery:admin"],
      new Date(Date.now() + 3_600_000),
    ],
  );
  return secret;
}

async function agentPost(
  fixture: Fixture,
  organizationId: string,
  bearer: string,
  path: string,
  ifMatch: number,
  body: unknown,
): Promise<Response> {
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "Bakery-Organization-Id": organizationId,
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "If-Match": `"${ifMatch}"`,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as T;
}

async function decide(
  fixture: Fixture,
  seed: Seed,
  proposal: Proposal,
  decision: "accept" | "reject",
): Promise<Response> {
  return await call(
    fixture,
    seed,
    `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
    { method: "POST", ifMatch: proposal.version, body: { decision } },
  );
}

Deno.test("a coordinator proposes an unlisted definition, a person decides it and saves it as a workflow", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "unlisted-a", {
      role: "admin",
    });
    const other = await seedOrganization(fixture, "unlisted-b", {
      role: "admin",
    });

    // The effect records a waiting proposal and writes no definition.
    const before = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.workflow_definitions
        where organization_id = $1`,
      [seed.organizationId],
    );
    const first = await runTurn(fixture, seed, [
      { type: "definitionProposal", name: "Triage pipeline", definition },
      { type: "reply", body: "I drafted a triage pipeline." },
    ]);
    assertEquals(first.status, "completed");
    const proposalId = await latestProposalId(fixture, seed);
    assert(proposalId);
    const after = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.workflow_definitions
        where organization_id = $1`,
      [seed.organizationId],
    );
    assertEquals(after.rows[0].count, before.rows[0].count);
    const waiting = await json<Proposal>(
      await call(
        fixture,
        seed,
        `/v1/workflow-definition-proposals/${proposalId}`,
      ),
      200,
    );
    assertEquals(waiting.state, "waiting");
    assertEquals(waiting.workflowId, null);

    // Cross-organization reads of the proposal are not found.
    assertEquals(
      (await call(
        fixture,
        other,
        `/v1/workflow-definition-proposals/${proposalId}`,
      ))
        .status,
      404,
    );

    // An agent cannot accept (or reject) the coordinator's proposal.
    const agent = await agentToken(fixture, seed);
    for (const decision of ["accept", "reject"] as const) {
      const refused = await agentPost(
        fixture,
        seed.organizationId,
        agent,
        `/v1/workflow-definition-proposals/${proposalId}/decisions`,
        waiting.version,
        { decision },
      );
      // The handler's person-only guard answers; the problem body carries no
      // reason, so the code and the unchanged waiting state prove it.
      const refusedBody = await refused.text();
      assertEquals(refused.status, 403, refusedBody);
      assertEquals(JSON.parse(refusedBody).code, "AUTH_FORBIDDEN");
      assertEquals(
        (await json<Proposal>(
          await call(
            fixture,
            seed,
            `/v1/workflow-definition-proposals/${proposalId}`,
          ),
          200,
        )).state,
        "waiting",
      );
    }

    // A decision naming a stale proposal version is refused with 412 and
    // decides nothing (the proposal's own If-Match, not the draft's).
    assertEquals(
      (await decide(fixture, seed, {
        ...waiting,
        version: waiting.version + 5,
      }, "accept")).status,
      412,
    );
    assertEquals(
      (await json<Proposal>(
        await call(
          fixture,
          seed,
          `/v1/workflow-definition-proposals/${proposalId}`,
        ),
        200,
      )).state,
      "waiting",
    );

    // A person accepts: an unlisted, coordinator-origin definition with a draft.
    const accepted = await json<Proposal>(
      await decide(fixture, seed, waiting, "accept"),
      200,
    );
    assertEquals(accepted.state, "accepted");
    assertEquals(accepted.decidedBy, seed.principalId);
    const workflowId = accepted.workflowId;
    assert(workflowId);
    const unlisted = await json<Workflow>(
      await call(fixture, seed, `/v1/workflows/${workflowId}`),
      200,
    );
    assertEquals(unlisted.visibility, "unlisted");
    assertEquals(unlisted.origin.kind, "coordinator");
    assertEquals(unlisted.origin.conversationId, seed.conversationId);
    assertEquals(unlisted.origin.turnId, first.id);
    assertEquals(unlisted.name, "Triage pipeline");
    // A decided proposal cannot be decided again.
    assertEquals((await decide(fixture, seed, accepted, "reject")).status, 409);

    // The library list excludes the unlisted definition.
    const listIds = async (target: Seed) =>
      (await json<{ items: { id: string }[] }>(
        await call(fixture, target, "/v1/workflows?limit=100"),
        200,
      )).items.map((item) => item.id);
    assert(!(await listIds(seed)).includes(workflowId));
    // Cross-organization reads of the definition are not found.
    assertEquals(
      (await call(fixture, other, `/v1/workflows/${workflowId}`)).status,
      404,
    );

    // A follow-up proposal edits the same draft through the editor's update.
    const drafts = await json<{ items: { id: string; version: number }[] }>(
      await call(fixture, seed, `/v1/workflows/${workflowId}/versions`),
      200,
    );
    const draft = drafts.items[0];
    const changed = { ...definition, limits: { ...definition.limits } };
    await runTurn(fixture, seed, [
      {
        type: "definitionProposal",
        workflowId,
        name: "Triage",
        definition: changed,
      },
    ]);
    const second = await json<Proposal>(
      await call(
        fixture,
        seed,
        `/v1/workflow-definition-proposals/${await latestProposalId(
          fixture,
          seed,
        )}`,
      ),
      200,
    );
    assertEquals(second.baseDraftVersion, draft.version);
    // A person edits the draft meanwhile: the stale proposal is refused and
    // stays waiting.
    await json(
      await call(
        fixture,
        seed,
        `/v1/workflows/${workflowId}/versions/${draft.id}`,
        {
          method: "PATCH",
          ifMatch: draft.version,
          body: { definition },
        },
      ),
      200,
    );
    assertEquals((await decide(fixture, seed, second, "accept")).status, 412);
    const stillWaiting = await json<Proposal>(
      await call(
        fixture,
        seed,
        `/v1/workflow-definition-proposals/${second.id}`,
      ),
      200,
    );
    assertEquals(stillWaiting.state, "waiting");
    assertEquals(
      (await json<Proposal>(
        await decide(fixture, seed, stillWaiting, "reject"),
        200,
      ))
        .state,
      "rejected",
    );

    // A proposal may not target a definition outside this conversation.
    const foreign = await json<{ id: string }>(
      await call(fixture, seed, "/v1/workflows", {
        method: "POST",
        body: { slug: "listed-flow", name: "Listed", description: "" },
      }),
      201,
    );
    const refusedTurn = await runTurn(fixture, seed, [
      {
        type: "definitionProposal",
        workflowId: foreign.id,
        name: "x",
        definition,
      },
    ]);
    assertEquals(refusedTurn.status, "failed");
    assertEquals(
      refusedTurn.failure?.code,
      "definition_proposal_target_invalid",
    );

    // Save as workflow refusals. The copy itself needs a published source
    // version, which the run test below has; these are checked before it.
    const listingPath = `/v1/workflows/${workflowId}/listings`;
    const listingBody = { versionId: crypto.randomUUID() };
    const agentSave = await agentPost(
      fixture,
      seed.organizationId,
      agent,
      listingPath,
      unlisted.version,
      listingBody,
    );
    // Workflow authoring routes accept an agent's token (#421: agents author
    // drafts), but save as workflow is a person's act: the handler refuses.
    const agentSaveBody = await agentSave.text();
    assertEquals(agentSave.status, 403, agentSaveBody);
    assertEquals(JSON.parse(agentSaveBody).code, "AUTH_FORBIDDEN");
    assertEquals(
      (await call(fixture, seed, listingPath, {
        method: "POST",
        ifMatch: unlisted.version + 7,
        body: listingBody,
      })).status,
      412,
    );
    assertEquals(
      (await call(fixture, other, listingPath, {
        method: "POST",
        ifMatch: unlisted.version,
        body: listingBody,
      })).status,
      404,
    );
  }));

Deno.test("an unlisted definition runs at its exact published version through normal admission", () =>
  withWorkerFixture(async (fixture) => {
    const scope = fixture;
    const agent = await seedFundedCodingAgent(fixture, scope, "unlisted");
    const repository = await seedPresetRepository(fixture.pgDatabase, scope, {
      agentVersionId: agent,
    });
    const workflow = await expectJson<{ id: string }>(
      await apiCall(fixture, scope, "POST", "/v1/workflows", {
        body: { slug: "frozen-flow", name: "Frozen", description: "" },
      }),
      201,
    );
    // Stands in for an accepted proposal: the conversation path above proves
    // how an unlisted coordinator definition is made.
    await fixture.pgDatabase.query(
      `update bakery.workflow_definitions set visibility = 'unlisted'
        where organization_id = $1 and id = $2`,
      [scope.organizationId, workflow.id],
    );
    const draft = await expectJson<{ id: string }>(
      await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/workflows/${workflow.id}/versions`,
        {
          body: { definition },
        },
      ),
      201,
    );
    // Run freezes the draft into an immutable version with the existing publish.
    const published = await expectJson<{ id: string; status: string }>(
      await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/workflows/${workflow.id}/versions/${draft.id}/publish`,
        { body: {}, headers: { "If-Match": '"1"' } },
      ),
      200,
    );
    assertEquals(published.status, "published");
    // "Use this version" is a library act an unlisted definition does not get.
    const current = await expectJson<{ version: number }>(
      await apiCall(fixture, scope, "GET", `/v1/workflows/${workflow.id}`),
      200,
    );
    assertEquals(
      (await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/workflows/${workflow.id}/activations`,
        {
          body: { versionId: published.id },
          headers: { "If-Match": `"${current.version}"` },
        },
      )).status,
      409,
    );
    const task = await createPresetTask(fixture, scope, repository, {
      title: "Unlisted run",
    });
    const run = await expectJson<{ workflowVersionId: string }>(
      await apiCall(fixture, scope, "POST", `/v1/tasks/${task.id}/runs`, {
        body: {
          workflowVersionId: published.id,
          executionMode: "repository",
          repositoryProfileId: repository.profileId,
          budgetLimitUsd: "5.00",
          inputs: {
            repositoryId: repository.repositoryId,
            brief: {
              title: "Retry",
              description: "Retry failed uploads twice.",
              taskType: "feature",
            },
            instructions: "Retry failed uploads twice.",
          },
        },
      }),
      201,
    );
    assertEquals(run.workflowVersionId, published.id);

    // Save as workflow copies the published version into a new listed
    // definition with a draft; the unlisted source is unchanged.
    const sourceBefore = await expectJson<Workflow>(
      await apiCall(fixture, scope, "GET", `/v1/workflows/${workflow.id}`),
      200,
    );
    const saveKey = crypto.randomUUID();
    const saveRequest = {
      body: { versionId: published.id, name: "Saved flow" },
      headers: { "If-Match": `"${sourceBefore.version}"` },
      idempotencyKey: saveKey,
    };
    const copy = await expectJson<
      Workflow & {
        origin: { sourceWorkflowId: string; sourceVersionId: string };
      }
    >(
      await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/workflows/${workflow.id}/listings`,
        saveRequest,
      ),
      201,
    );
    assert(copy.id !== workflow.id);
    assertEquals(copy.visibility, "listed");
    assertEquals(copy.name, "Saved flow");
    assertEquals(copy.origin.kind, "copy");
    assertEquals(copy.origin.sourceWorkflowId, workflow.id);
    assertEquals(copy.origin.sourceVersionId, published.id);
    const copyVersions = await expectJson<
      { items: { status: string; normalizedSpec: unknown }[] }
    >(
      await apiCall(fixture, scope, "GET", `/v1/workflows/${copy.id}/versions`),
      200,
    );
    assertEquals(copyVersions.items.length, 1);
    assertEquals(copyVersions.items[0].status, "draft");
    assertEquals(copyVersions.items[0].normalizedSpec, definition);
    const sourceAfter = await expectJson<Workflow>(
      await apiCall(fixture, scope, "GET", `/v1/workflows/${workflow.id}`),
      200,
    );
    assertEquals(sourceAfter.visibility, "unlisted");
    assertEquals(sourceAfter.version, sourceBefore.version);
    const listed = (await expectJson<{ items: { id: string }[] }>(
      await apiCall(fixture, scope, "GET", "/v1/workflows?limit=100"),
      200,
    )).items.map((item) => item.id);
    assert(listed.includes(copy.id));
    assert(!listed.includes(workflow.id));
    // A replay of the same save (same Idempotency-Key) returns the original 201.
    const replay = await expectJson<{ id: string }>(
      await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/workflows/${workflow.id}/listings`,
        saveRequest,
      ),
      201,
    );
    assertEquals(replay.id, copy.id);
    // A second save of the same source version is refused and names the copy.
    const second = await apiCall(
      fixture,
      scope,
      "POST",
      `/v1/workflows/${workflow.id}/listings`,
      {
        body: { versionId: published.id },
        headers: { "If-Match": `"${sourceBefore.version}"` },
      },
    );
    const secondBody = await second.text();
    assertEquals(second.status, 409, secondBody);
    assertEquals(JSON.parse(secondBody).reason, "workflow_copy_exists");
    assertEquals(JSON.parse(secondBody).existingResourceId, copy.id);
    // A listed source (here the copy itself) cannot be saved again: 409.
    const listedAgain = await apiCall(
      fixture,
      scope,
      "POST",
      `/v1/workflows/${copy.id}/listings`,
      {
        body: { versionId: published.id },
        headers: { "If-Match": `"${copy.version}"` },
      },
    );
    assertEquals(listedAgain.status, 409, await listedAgain.text());
    // A stale If-Match on the source is refused and copies nothing.
    assertEquals(
      (await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/workflows/${workflow.id}/listings`,
        {
          body: { versionId: published.id },
          headers: { "If-Match": `"${sourceBefore.version + 3}"` },
        },
      )).status,
      412,
    );
  }, { env: presetBudgetEnv }));
