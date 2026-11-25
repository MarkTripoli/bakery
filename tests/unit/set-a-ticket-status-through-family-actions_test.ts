import { assertEquals, assertRejects } from "@std/assert";
import {
  githubIntegration,
  githubIssueStateOf,
} from "../../apps/server/src/modules/catalog/integration-providers/github.ts";
import { createGateTicketStatusWriter } from "../../apps/server/src/modules/integrations/ticket-statuses.ts";
import type { GateSend } from "../../apps/server/src/modules/integrations/ticket-gate.ts";
import { ticketFamilyActionsOf } from "../../apps/server/src/modules/work/ticket-family-actions.ts";

type Handler = {
  input: { safeParse(value: unknown): { success: boolean } };
  execute(ctx: unknown, input: unknown): Promise<unknown>;
};
const setState = (githubIntegration.handlers as Record<string, Handler>)[
  "github.issue.state.update@1"
];

function recordingProvider(answer: Record<string, unknown>) {
  const sent: { id: string; input: unknown }[] = [];
  return {
    sent,
    ctx: {
      provider: {
        request(ref: { id: string }, input: unknown) {
          sent.push({ id: ref.id, input });
          return Promise.resolve(answer);
        },
      },
    },
  };
}

Deno.test("github's status action maps a status id to state and state_reason", async () => {
  assertEquals(githubIssueStateOf("open"), {
    state: "open",
    state_reason: null,
  });
  assertEquals(githubIssueStateOf("closed:not_planned"), {
    state: "closed",
    state_reason: "not_planned",
  });
  const provider = recordingProvider({
    number: 7,
    state: "closed",
    state_reason: "completed",
  });
  assertEquals(
    await setState.execute(provider.ctx, {
      issueNumber: 7,
      statusId: "closed:completed",
    }),
    { statusId: "closed:completed" },
  );
  assertEquals(provider.sent, [{
    id: "github.issue.state.update",
    input: { issue_number: 7, state: "closed", state_reason: "completed" },
  }]);
});

Deno.test("github's status action refuses an unknown status id before sending", async () => {
  assertEquals(
    setState.input.safeParse({ issueNumber: 7, statusId: "closed:completed" })
      .success,
    true,
  );
  for (const statusId of ["In Progress", "closed:reopened", "", "OPEN"]) {
    assertEquals(
      setState.input.safeParse({ issueNumber: 7, statusId }).success,
      false,
      statusId,
    );
  }
  const provider = recordingProvider({ number: 7, state: "open" });
  await assertRejects(() =>
    setState.execute(provider.ctx, { issueNumber: 7, statusId: "In Progress" })
  );
  assertEquals(provider.sent, []);
});

Deno.test("github declares status.set and the gate writer sends it, or answers provider_capability_missing", async () => {
  assertEquals(ticketFamilyActionsOf("github")["status.set"], {
    id: "github.issue.state.update",
    version: 1,
  });
  const sent: GateSend[] = [];
  const writer = createGateTicketStatusWriter({
    send: (send) => {
      sent.push(send);
      return Promise.resolve({
        kind: "sent",
        effectId: "e",
        outcome: "confirmed",
      });
    },
  });
  const change = {
    organizationId: "o",
    actorPrincipalId: "p",
    provider: "github",
    connectionId: "c",
    resourceId: "r",
    issueNumber: 7,
    statusId: "closed:completed",
    idempotencyKey: "req:status:delivered",
    signal: new AbortController().signal,
  };
  assertEquals(await writer.set(change), { kind: "set" });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].action, {
    id: "github.issue.state.update",
    version: 1,
  });
  assertEquals(sent[0].arguments, {
    issueNumber: 7,
    statusId: "closed:completed",
  });
  assertEquals(sent[0].idempotencyKey, "req:status:delivered");
  assertEquals(await writer.set({ ...change, provider: "linear" }), {
    kind: "failed",
    problemCode: "provider_capability_missing",
  });
  assertEquals(sent.length, 1);
});
