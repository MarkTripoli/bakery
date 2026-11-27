import { assertEquals } from "@std/assert";
import {
  requestSlackBlocks,
  type RequestSlackFacts,
  type SlackBlock,
} from "../../apps/server/src/modules/work/request-slack.ts";
import {
  readSlackInteractionPayload,
  readSlackPress,
  SLACK_PRESS_NOT_LINKED,
  slackPressReply,
} from "../../apps/server/src/modules/work/request-slack-press.ts";

const BASE_URL = "https://bakery.example.test";
const REQUEST_ID = "6f1e2d3c-4b5a-4968-8776-655443322110";

function facts(intent: string): RequestSlackFacts {
  return {
    requestId: REQUEST_ID,
    organizationId: "0a0b0c0d-0e0f-4011-8213-141516171819",
    taskId: "1a1b1c1d-1e1f-4021-8223-242526272829",
    intent,
    askerName: "Ada",
    audienceName: null,
    stepName: "deploy",
    workItem: "Ship the release",
    passedOnFrom: null,
    expiresAt: new Date("2026-12-01T00:00:00Z"),
  };
}

function buttons(blocks: readonly SlackBlock[]) {
  const row = blocks.find((block) => block.type === "actions");
  return row?.type === "actions" ? row.elements : [];
}

Deno.test("an approve DM has Approve, Reject and Open in Bakery with the confirm dialogs", () => {
  const [approve, reject, open] = buttons(
    requestSlackBlocks(BASE_URL, facts("approve")),
  );
  assertEquals(approve, {
    type: "button",
    action_id: "approve",
    text: { type: "plain_text", text: "Approve" },
    value: REQUEST_ID,
    style: "primary",
    confirm: {
      title: { type: "plain_text", text: "Approve this?" },
      text: {
        type: "plain_text",
        text:
          "Bakery continues from deploy. Your decision is recorded under your name.",
      },
      confirm: { type: "plain_text", text: "Approve" },
      deny: { type: "plain_text", text: "Cancel" },
    },
  });
  assertEquals(reject, {
    type: "button",
    action_id: "reject",
    text: { type: "plain_text", text: "Reject" },
    value: REQUEST_ID,
    style: "danger",
    confirm: {
      title: { type: "plain_text", text: "Reject this?" },
      text: {
        type: "plain_text",
        text:
          "Bakery will not continue past deploy. Your decision is recorded under your name.",
      },
      confirm: { type: "plain_text", text: "Reject" },
      deny: { type: "plain_text", text: "Cancel" },
    },
  });
  assertEquals(open?.text.text, "Open in Bakery");
  assertEquals(open?.url?.startsWith(`${BASE_URL}/tasks/`), true);
});

Deno.test("other intents show only Open in Bakery", () => {
  for (const intent of ["review", "answer", "take_over", "inform"]) {
    assertEquals(
      buttons(requestSlackBlocks(BASE_URL, facts(intent))).map((button) =>
        button.action_id
      ),
      ["open"],
    );
  }
});

Deno.test("a closed approve DM drops Approve and Reject and keeps Open in Bakery", () => {
  const blocks = requestSlackBlocks(BASE_URL, facts("approve"), {
    status: "handled",
    closedByName: "Ada",
  });
  assertEquals(buttons(blocks).map((button) => button.action_id), ["open"]);
  const section = blocks[0];
  assertEquals(
    section?.type === "section" ? section.text.text : "",
    "*Handled by Ada* · Ship the release",
  );
});

function payload(body: Record<string, unknown>) {
  return new TextEncoder().encode(
    new URLSearchParams({ payload: JSON.stringify(body) }).toString(),
  );
}

const PRESS = {
  type: "block_actions",
  api_app_id: "A0TESTAPP",
  team: { id: "T0TEAM" },
  user: { id: "U0USER" },
  channel: { id: "D0DM" },
  container: { message_ts: "1700000000.1" },
  actions: [{ action_id: "reject", value: REQUEST_ID, action_ts: "1.2" }],
};

Deno.test("a block_actions payload reads as one press naming the request", () => {
  assertEquals(readSlackPress(readSlackInteractionPayload(payload(PRESS))), {
    kind: "press",
    press: {
      appId: "A0TESTAPP",
      teamId: "T0TEAM",
      userId: "U0USER",
      channelId: "D0DM",
      messageTs: "1700000000.1",
      actionTs: "1.2",
      decision: "reject",
      requestId: REQUEST_ID,
    },
  });
});

Deno.test("link presses, other payload types and broken bodies are ignored", () => {
  assertEquals(
    readSlackPress(readSlackInteractionPayload(payload({
      ...PRESS,
      actions: [{ action_id: "open", action_ts: "1.2" }],
    }))),
    { kind: "ignored" },
  );
  assertEquals(
    readSlackPress(
      readSlackInteractionPayload(
        payload({ ...PRESS, type: "view_submission" }),
      ),
    ),
    { kind: "ignored" },
  );
  assertEquals(
    readSlackInteractionPayload(new TextEncoder().encode("payload=%7Bnot")),
    null,
  );
  assertEquals(
    readSlackInteractionPayload(new TextEncoder().encode("text=hi")),
    null,
  );
});

Deno.test("each refusal has its exact reply", () => {
  const org = "0a0b0c0d-0e0f-4011-8213-141516171819";
  assertEquals(
    slackPressReply(BASE_URL, org, { kind: "not_linked" })?.text,
    SLACK_PRESS_NOT_LINKED,
  );
  assertEquals(
    slackPressReply(BASE_URL, org, { kind: "no_permission" })?.text,
    "Nothing was decided. You do not have permission to approve or reject this work.",
  );
  assertEquals(
    slackPressReply(BASE_URL, org, {
      kind: "already_decided",
      approvalId: REQUEST_ID,
      name: "Ada <x>",
    })?.text,
    "Nothing changed. Ada &lt;x&gt; already decided this.",
  );
  assertEquals(
    slackPressReply(BASE_URL, org, { kind: "not_recorded" })?.text,
    "Your decision was not recorded. Try again.",
  );
  assertEquals(
    slackPressReply(BASE_URL, org, { kind: "decided", approvalId: REQUEST_ID }),
    null,
  );
});
