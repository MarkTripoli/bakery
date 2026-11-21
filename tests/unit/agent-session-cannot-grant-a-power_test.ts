import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createAgentPowerGrant,
  deleteAgentPowerGrant,
} from "../../apps/server/src/modules/workflows/agent-power-grants.ts";
import {
  AgentPower,
  assertAgentMayExercise,
} from "../../apps/server/src/modules/auth/application/agent-power-grants.ts";
import { attributeAction } from "../../apps/server/src/modules/auth/application/action-attribution.ts";

// O51: delegating authority is never an agent's act. An agent session acts with
// the person's own human principal, so only the session marker tells it apart.
// These pin that the grant operations refuse that caller before they read or
// write anything.

const PERSON = "00000000-0000-4000-8000-0000000000a1";
const ORGANIZATION = "00000000-0000-4000-8000-0000000000a2";
const ATTEMPT = "00000000-0000-4000-8000-0000000000a3";

/** A transaction that fails the test the moment anything touches it. */
const untouchable = {
  query: () => {
    throw new Error("the grant operation touched the database");
  },
};

function context(
  extra: Partial<ActionContext> = {},
  params: Record<string, string> = {},
): ActionContext {
  return {
    request: new Request("http://localhost/v1/agent-power-grants"),
    params,
    requestId: "request",
    traceId: "trace",
    signal: new AbortController().signal,
    principal: { principalId: PERSON, principalType: "human" },
    authority: {
      organizationId: ORGANIZATION,
      subject: { principalId: PERSON },
    },
    transaction: untouchable,
    ...extra,
  } as unknown as ActionContext;
}

Deno.test("a call dispatched by an agent session is attributed to an agent, not the person", () => {
  const person = attributeAction(context(), PERSON);
  assertEquals(person.actorKind, "person");
  const session = attributeAction(
    context({ agentSession: { attemptId: ATTEMPT } }),
    PERSON,
  );
  // The principal is the same human; only the marker differs.
  assertEquals(session.principalId, PERSON);
  assertEquals(session.actorKind, "agent");
});

Deno.test("an agent session cannot create a grant, so it cannot grant itself a power", async () => {
  const refused = await assertRejects(
    () =>
      createAgentPowerGrant(
        context({ agentSession: { attemptId: ATTEMPT } }),
        { power: "decide", workflowId: crypto.randomUUID() },
      ),
    StandardError,
  );
  assertEquals(refused.code, "AUTH_FORBIDDEN");
  assert(
    refused.params?.reason === "agent_power_grant_requires_person",
    "the refusal names why",
  );
});

Deno.test("an agent session cannot revoke a grant either", async () => {
  const refused = await assertRejects(
    () =>
      deleteAgentPowerGrant(
        context({ agentSession: { attemptId: ATTEMPT } }, {
          id: crypto.randomUUID(),
        }),
      ),
    StandardError,
  );
  assertEquals(refused.code, "AUTH_FORBIDDEN");
});

Deno.test("a session whose attempt belongs to no run holds no power", async () => {
  // A job with no run (a coordinator turn) has no workflow a grant could name,
  // so the guard refuses instead of guessing. A stub transaction that finds no
  // origin stands in for the attempt with no run.
  const noOrigin = { query: () => Promise.resolve({ rows: [] }) };
  const refused = await assertRejects(
    () =>
      assertAgentMayExercise(
        noOrigin as never,
        context({ agentSession: { attemptId: ATTEMPT } }),
        {
          organizationId: ORGANIZATION,
          principalId: PERSON,
          power: AgentPower.Decide,
        },
      ),
    StandardError,
  );
  assertEquals(refused.code, "AUTH_FORBIDDEN");
  assertEquals(refused.params?.reason, "agent_power_requires_grant");
});
