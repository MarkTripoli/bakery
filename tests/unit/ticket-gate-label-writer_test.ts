import { assertEquals } from "@std/assert";
import { createGateTicketLabelWriter } from "../../apps/server/src/modules/integrations/ticket-labels.ts";
import type {
  GateSend,
  GateSendResult,
} from "../../apps/server/src/modules/integrations/ticket-gate.ts";

const ADD = { id: "github.issue.labels.add", version: 1 };
const REMOVE = { id: "github.issue.label.remove", version: 1 };

function writer(answers: GateSendResult[] = []) {
  const sent: GateSend[] = [];
  const label = createGateTicketLabelWriter({
    send: (send) => {
      sent.push(send);
      return Promise.resolve(
        answers.shift() ??
          { kind: "sent", effectId: "e", outcome: "confirmed" },
      );
    },
    labelActions: { github: { add: ADD, remove: REMOVE } },
  });
  return { label, sent };
}

const change = {
  organizationId: "org",
  actorPrincipalId: "principal",
  provider: "github",
  connectionId: "connection",
  resourceId: "resource",
  issueNumber: 7,
  idempotencyKey: "k",
  signal: new AbortController().signal,
};

Deno.test("the new label is added before the old one comes off, one effect each, named apart", async () => {
  const { label, sent } = writer();
  const result = await label.apply({
    ...change,
    add: ["bakery:working"],
    remove: ["bakery:queued"],
  });
  assertEquals(result, { kind: "applied" });
  assertEquals(
    sent.map((s) => [s.action.id, s.arguments, s.idempotencyKey]),
    [
      [ADD.id, { issueNumber: 7, labels: ["bakery:working"] }, "k:add"],
      [
        REMOVE.id,
        { issueNumber: 7, label: "bakery:queued" },
        "k:remove:bakery:queued",
      ],
    ],
  );
});

Deno.test("the first refused effect stops the change and names its code; nothing to change sends nothing", async () => {
  const { label, sent } = writer([{
    kind: "failed",
    problemCode: "grant_missing",
  }]);
  assertEquals(
    await label.apply({
      ...change,
      add: ["bakery:done"],
      remove: ["bakery:review"],
    }),
    { kind: "failed", problemCode: "grant_missing" },
  );
  assertEquals(sent.length, 1, "the remove is not sent after a refused add");
  const idle = writer();
  assertEquals(await idle.label.apply({ ...change, add: [], remove: [] }), {
    kind: "applied",
  });
  assertEquals(idle.sent.length, 0);
});

Deno.test("a provider with no label actions fails closed", async () => {
  const { label, sent } = writer();
  assertEquals(
    await label.apply({ ...change, provider: "jira", add: ["x"], remove: [] }),
    { kind: "failed", problemCode: "provider_capability_missing" },
  );
  assertEquals(sent.length, 0);
});
