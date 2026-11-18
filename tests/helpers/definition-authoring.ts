import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import { processNextConversationTurn } from "../../apps/server/src/modules/conversation/turn-runtime.ts";
import type {
  CoordinatorEffect,
  CoordinatorTurnExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";
import { authTestOrigin, openAuthFixture } from "./auth.ts";
import {
  call,
  cleanupSeededOrganizations,
  type Fixture,
  type Seed,
  sendMessage,
} from "./coordinator-turns.ts";

// Shared by the #421 integration and security tests: agent tokens, requests
// as a person or an agent, and a definition proposal waiting on a draft.

/** The smallest definition that validates and publishes. */
export const PUBLISHABLE = Object.freeze({
  kind: "fixed",
  steps: [{ id: "first", uses: "workflow.noop" }],
});
/** A second publishable definition, the content a proposal asks for. */
export const PROPOSED = Object.freeze({
  kind: "fixed",
  steps: [{ id: "proposed", uses: "workflow.noop" }],
});

export async function withFixture(work: (fixture: Fixture) => Promise<void>) {
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

export type Agent = { bearer: string; tokenId: string; principalId: string };

/** An admin-role service principal with an access token: an agent seat. */
export async function agentToken(
  fixture: Fixture,
  seed: Seed,
): Promise<Agent> {
  const principalId = crypto.randomUUID();
  const body = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const secret = `bky_${body}`;
  const db = fixture.pgDatabase;
  await db.query(
    `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
     values ($1,null,'authoring agent','service')`,
    [principalId],
  );
  await db.query(
    `insert into bakery.organization_memberships (
       id,organization_id,principal_id,role,status,joined_at,created_at,
       updated_at,version
     ) values ($1,$2,$3,'admin','active',now(),now(),now(),1)`,
    [crypto.randomUUID(), seed.organizationId, principalId],
  );
  const token = await db.query<{ id: string }>(
    `insert into bakery.access_tokens (
       organization_id,principal_id,created_by_principal_id,name,prefix,
       secret_sha256,scopes,expires_at
     ) values ($1,$2,$3,'authoring agent',$4,$5,$6,$7)
     returning id`,
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
  return { bearer: secret, tokenId: token.rows[0].id, principalId };
}

export type Who = { seed: Seed; agent?: Agent };

/** One request as the seed's person, or as `agent` when given. */
export async function send(
  fixture: Fixture,
  who: Who,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { body?: unknown; ifMatch?: number; key?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    "Bakery-Organization-Id": who.seed.organizationId,
  });
  if (who.agent) headers.set("authorization", `Bearer ${who.agent.bearer}`);
  else headers.set("cookie", who.seed.cookie);
  if (method !== "GET") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", options.key ?? crypto.randomUUID());
    if (options.ifMatch !== undefined) {
      headers.set("If-Match", `"${options.ifMatch}"`);
    }
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { body: JSON.stringify(options.body ?? {}) }),
    }),
  );
}

export async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return (text === "" ? null : JSON.parse(text)) as T;
}

/** Status and problem code of a refusal. */
export async function refusal(
  response: Response,
): Promise<{ status: number; code: string | undefined }> {
  const text = await response.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  return { status: response.status, code };
}

/** One coordinator turn answering with exactly these effects. */
export async function runTurn(
  fixture: Fixture,
  seed: Seed,
  effects: CoordinatorEffect[],
): Promise<void> {
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
}

export type Proposal = {
  id: string;
  state: string;
  workflowId: string | null;
  baseDraftVersion: number | null;
  version: number;
  decidedBy: string | null;
  supersededByVersionId: string | null;
};

async function latestProposal(fixture: Fixture, seed: Seed) {
  const row = await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.workflow_definition_proposals
      where organization_id = $1 order by created_at desc, id desc limit 1`,
    [seed.organizationId],
  );
  const id = row.rows[0]?.id;
  assert(id);
  return await json<Proposal>(
    await call(fixture, seed, `/v1/workflow-definition-proposals/${id}`),
    200,
  );
}

export async function readProposal(
  fixture: Fixture,
  seed: Seed,
  id: string,
): Promise<Proposal> {
  return await json<Proposal>(
    await call(fixture, seed, `/v1/workflow-definition-proposals/${id}`),
    200,
  );
}

export type Draft = { id: string; version: number; digest: string };

/**
 * An unlisted coordinator definition with a draft holding PUBLISHABLE, and a
 * second proposal still waiting on that draft that asks for PROPOSED.
 */
export async function seedWaitingProposal(
  fixture: Fixture,
  seed: Seed,
): Promise<{ workflowId: string; draft: Draft; proposal: Proposal }> {
  await runTurn(fixture, seed, [
    {
      type: "definitionProposal",
      name: "Proposed flow",
      definition: PUBLISHABLE,
    },
  ]);
  const first = await latestProposal(fixture, seed);
  const accepted = await json<Proposal>(
    await call(
      fixture,
      seed,
      `/v1/workflow-definition-proposals/${first.id}/decisions`,
      { method: "POST", ifMatch: first.version, body: { decision: "accept" } },
    ),
    200,
  );
  const workflowId = accepted.workflowId;
  assert(workflowId);
  const draft = await currentDraft(fixture, seed, workflowId);
  await runTurn(fixture, seed, [
    {
      type: "definitionProposal",
      workflowId,
      name: "Proposed flow",
      definition: PROPOSED,
    },
  ]);
  const proposal = await latestProposal(fixture, seed);
  assertEquals(proposal.state, "waiting");
  assertEquals(proposal.baseDraftVersion, draft.version);
  return { workflowId, draft, proposal };
}

export async function currentDraft(
  fixture: Fixture,
  seed: Seed,
  workflowId: string,
): Promise<Draft> {
  const versions = await json<
    { items: { id: string; status: string; version: number; digest: string }[] }
  >(await call(fixture, seed, `/v1/workflows/${workflowId}/versions`), 200);
  const draft = versions.items.find((item) => item.status === "draft");
  assert(draft, "no draft");
  return draft;
}

/** A listed workflow with one draft, created by `who`. */
export async function seedWorkflowDraft(
  fixture: Fixture,
  who: Who,
  slug: string,
): Promise<{ workflowId: string; draft: Draft }> {
  const workflow = await json<{ id: string }>(
    await send(fixture, who, "POST", "/v1/workflows", {
      body: { slug, name: slug, description: "" },
    }),
    201,
  );
  const draft = await json<Draft>(
    await send(fixture, who, "POST", `/v1/workflows/${workflow.id}/versions`, {
      body: { definition: PUBLISHABLE },
    }),
    201,
  );
  return { workflowId: workflow.id, draft };
}

export async function publish(
  fixture: Fixture,
  who: Who,
  workflowId: string,
  draft: { id: string; version: number },
  body: Record<string, unknown> = {},
): Promise<Response> {
  return await send(
    fixture,
    who,
    "POST",
    `/v1/workflows/${workflowId}/versions/${draft.id}/publish`,
    { body, ifMatch: draft.version },
  );
}

export async function countRows(
  fixture: Fixture,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: string }>(
    sql,
    [...values],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Audit rows and domain events recorded for one resource id. */
export async function factsFor(
  fixture: Fixture,
  organizationId: string,
  resourceId: string,
): Promise<{ audits: string[]; events: string[] }> {
  const audits = await fixture.pgDatabase.query<{ operation: string }>(
    `select operation from bakery.audit_events
      where organization_id = $1 and resource_id = $2
        and outcome = 'succeeded'
      order by created_at, id`,
    [organizationId, resourceId],
  );
  const events = await fixture.pgDatabase.query<{ event_type: string }>(
    `select event_type from bakery.domain_events
      where organization_id = $1 and aggregate_id = $2 order by sequence`,
    [organizationId, resourceId],
  );
  return {
    audits: audits.rows.map((row) => row.operation),
    events: events.rows.map((row) => row.event_type),
  };
}
