import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
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

Deno.test("a post Slack refuses with ok false fails with Slack's code, and a new key sends again", async () => {
  const o = await open(fakeSlack());
  try {
    const connectionId = await connectOnce(o);
    const ids = await deliveryIds(o.fixture, connectionId);
    let refuse = true;
    const { deps, sent } = slackGateDeps(
      o.fixture.runtimePgDatabase,
      (request) =>
        request.path === "/api/chat.postMessage" && refuse
          ? { ok: false, error: "channel_not_found" }
          : answer(request),
    );
    const post = (idempotencyKey: string) =>
      invokeIntegration(deps, {
        organizationId: o.fixture.organizationId,
        actorRef: ids.principalId,
        connectionId,
        input: {
          actionId: "slack.message.post",
          actionVersion: 1,
          resourceId: ids.resourceId,
          arguments: {
            channelId: DM,
            text: "A request needs you [bkr-00000009]",
            marker: "[bkr-00000009]",
          },
        },
        idempotencyKey,
      });
    const refused = await post("slack-post-refused");
    assertEquals(refused.route, "ledger");
    if (refused.route !== "ledger") throw new Error("expected the ledger");
    assertEquals(refused.run.outcome, "failed");
    assertEquals(refused.run.effect.status, "failed");
    assertEquals(refused.run.effect.failureCode, "provider_rejected");
    assertEquals(refused.run.refusal?.params, {
      reason: "provider_refused",
      providerCode: "channel_not_found",
    });
    const replayed = await post("slack-post-refused");
    if (replayed.route !== "ledger") throw new Error("expected the ledger");
    assertEquals(replayed.run.outcome, "failed");
    assertEquals(sent.length, 1);
    refuse = false;
    const retried = await post("slack-post-retried");
    assertEquals(retried.output, { channelId: DM, ts: POSTED_TS });
    assertEquals(sent.length, 2);
  } finally {
    await o.finish();
  }
});

Deno.test("a workspace resource whose stored team is not the installation's account is refused before Slack is called", async () => {
  const o = await open(fakeSlack());
  try {
    const connectionId = await connectOnce(o);
    const ids = await deliveryIds(o.fixture, connectionId);
    await o.fixture.pgDatabase.query(
      `update bakery.integration_resources
          set capability_snapshot = jsonb_set(
            capability_snapshot, '{binding,teamId}', '"T0OTHERTEAM"')
        where id = $1`,
      [ids.resourceId],
    );
    const { deps, sent } = slackGateDeps(o.fixture.runtimePgDatabase, answer);
    const refused = await assertRejects(
      () =>
        invokeIntegration(deps, {
          organizationId: o.fixture.organizationId,
          actorRef: ids.principalId,
          connectionId,
          input: {
            actionId: "slack.dm.open",
            actionVersion: 1,
            resourceId: ids.resourceId,
            arguments: { userId: "U0RECIPIENT" },
          },
          idempotencyKey: "slack-open-foreign-team",
        }),
      StandardError,
    );
    assertEquals(refused.code, "RESOURCE_NOT_FOUND");
    assertEquals(sent.length, 0);
  } finally {
    await o.finish();
  }
});

Deno.test("a post Slack answers fatal_error stays uncertain for reconcile, and invalid_auth still fails", async () => {
  const o = await open(fakeSlack());
  try {
    const connectionId = await connectOnce(o);
    const ids = await deliveryIds(o.fixture, connectionId);
    let code = "fatal_error";
    const { deps } = slackGateDeps(
      o.fixture.runtimePgDatabase,
      (request) =>
        request.path === "/api/chat.postMessage"
          ? { ok: false, error: code }
          : request.path === "/api/conversations.history"
          ? { ok: true, messages: [] }
          : answer(request),
    );
    const post = (idempotencyKey: string, marker: string) =>
      invokeIntegration(deps, {
        organizationId: o.fixture.organizationId,
        actorRef: ids.principalId,
        connectionId,
        input: {
          actionId: "slack.message.post",
          actionVersion: 1,
          resourceId: ids.resourceId,
          arguments: {
            channelId: DM,
            text: `A request needs you ${marker}`,
            marker,
          },
        },
        idempotencyKey,
      });
    const uncertain = await post("slack-post-fatal", "[bkr-0000000a]");
    if (uncertain.route !== "ledger") throw new Error("expected the ledger");
    assertNotEquals(uncertain.run.outcome, "failed");
    assertEquals(uncertain.run.effect.status, "uncertain");
    code = "invalid_auth";
    const refused = await post("slack-post-invalid-auth", "[bkr-0000000b]");
    if (refused.route !== "ledger") throw new Error("expected the ledger");
    assertEquals(refused.run.outcome, "failed");
    assertEquals(refused.run.effect.status, "failed");
    assertEquals(refused.run.effect.failureCode, "provider_rejected");
  } finally {
    await o.finish();
  }
});
