/**
 * #448: granting and revoking an agent file grant is a person's act. Every
 * agent actor (access token, agent session, service principal) is refused by
 * the handler itself, before any row is read or written.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createAgentFileGrant,
  revokeAgentFileGrant,
} from "../../apps/server/src/modules/knowledge/agent-file-grants.ts";

const principalId = "00000000-0000-4000-8000-000000000001";

/** A transaction that fails the test if the handler ever touches it. */
const untouched = {
  query: () => {
    throw new Error("the handler reached the database for an agent actor");
  },
};

function context(actor: Record<string, unknown>): ActionContext {
  return {
    requestId: "req-448",
    traceId: "trace-448",
    transaction: untouched,
    authority: {
      organizationId: "00000000-0000-4000-8000-000000000002",
      subject: { principalId },
    },
    principal: { principalType: "human" },
    ...actor,
  } as unknown as ActionContext;
}

const agents: [string, Record<string, unknown>][] = [
  ["an Admin's access token", { accessToken: { id: "token-448" } }],
  ["an agent session", { agentSession: { id: "session-448" } }],
  ["a service principal", { principal: { principalType: "service" } }],
];

async function reason(run: () => Promise<unknown>): Promise<unknown> {
  const error = await assertRejects(run, StandardError);
  return (error as StandardError & { params?: { reason?: unknown } }).params
    ?.reason;
}

for (const [name, actor] of agents) {
  Deno.test(
    name + " is refused a grant and a revoke by the handler",
    async () => {
      assertEquals(
        await reason(() =>
          createAgentFileGrant(context(actor), {
            workflowId: "00000000-0000-4000-8000-000000000003",
            folderId: "00000000-0000-4000-8000-000000000004",
            access: "write",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })
        ),
        "agent_file_grant_requires_person",
      );
      assertEquals(
        await reason(() => revokeAgentFileGrant(context(actor))),
        "agent_file_grant_requires_person",
      );
    },
  );
}
