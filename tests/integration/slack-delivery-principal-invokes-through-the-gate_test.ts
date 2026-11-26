import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { invokeIntegration } from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import {
  BOT_TOKEN,
  connectOnce,
  deliveryIds,
  fakeSlack,
  open,
  type SentSlackRequest,
  slackGateDeps,
} from "../helpers/slack-connect.ts";

const DM = "D0DELIVERY";
const POSTED_TS = "1700000000.000100";

function answer(request: SentSlackRequest) {
  if (request.path === "/api/conversations.open") {
    return { ok: true, channel: { id: DM } };
  }
  if (request.path === "/api/chat.postMessage") {
    return { ok: true, channel: DM, ts: POSTED_TS };
  }
  if (request.path === "/api/chat.update") {
    return { ok: true, channel: DM, ts: POSTED_TS };
  }
  return { ok: false, error: "unknown_method" };
}

Deno.test("the delivery principal opens a DM and posts to the connected workspace through the gate, and nothing it holds no grant for", async () => {
  const o = await open(fakeSlack());
  try {
    const connectionId = await connectOnce(o);
    const ids = await deliveryIds(o.fixture, connectionId);
    const { deps, sent } = slackGateDeps(o.fixture.runtimePgDatabase, answer);
    const invoke = (
      actorRef: string,
      actionId: string,
      args: Record<string, unknown>,
      idempotencyKey: string,
    ) =>
      invokeIntegration(deps, {
        organizationId: o.fixture.organizationId,
        actorRef,
        connectionId,
        input: {
          actionId,
          actionVersion: 1,
          resourceId: ids.resourceId,
          arguments: args,
        },
        idempotencyKey,
      });

    const opened = await invoke(
      ids.principalId,
      "slack.dm.open",
      { userId: "U0RECIPIENT" },
      "slack-open-1",
    );
    assertEquals(opened.output, { channelId: DM });
    const posted = await invoke(
      ids.principalId,
      "slack.message.post",
      {
        channelId: DM,
        text: "A request needs you [bkr-00000001]",
        marker: "[bkr-00000001]",
      },
      "slack-post-1",
    );
    assertEquals(posted.route, "ledger");
    assertEquals(posted.output, { channelId: DM, ts: POSTED_TS });
    assertEquals(sent.map((request) => request.path), [
      "/api/conversations.open",
      "/api/chat.postMessage",
    ]);
    assertEquals(sent[1]!.authorization, `Bearer ${BOT_TOKEN}`);
    assertEquals(sent[1]!.body, {
      channel: DM,
      text: "A request needs you [bkr-00000001]",
    });

    await o.fixture.pgDatabase.query(
      `update bakery.integration_grants set revoked_at = now(),
         revoked_by = $2
        where connection_id = $1 and capability = 'slack.message.update'`,
      [connectionId, o.fixture.adminId],
    );
    const unGranted = await assertRejects(() =>
      invoke(
        ids.principalId,
        "slack.message.update",
        { channelId: DM, ts: POSTED_TS, text: "Answered" },
        "slack-update-1",
      )
    );
    const notGrantee = await assertRejects(() =>
      invoke(
        o.fixture.adminId,
        "slack.message.post",
        {
          channelId: DM,
          text: "Hello [bkr-00000002]",
          marker: "[bkr-00000002]",
        },
        "slack-post-admin",
      )
    );
    assertEquals((unGranted as StandardError).code, "AUTH_FORBIDDEN");
    assertEquals((notGrantee as StandardError).code, "AUTH_FORBIDDEN");
    assertEquals(sent.length, 2);
  } finally {
    await o.finish();
  }
});
