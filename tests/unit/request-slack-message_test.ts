import { assert, assertEquals } from "@std/assert";
import {
  capSlackTitle,
  REQUEST_SLACK_TITLE_LIMIT,
  requestSlackMarker,
  requestSlackText,
} from "../../apps/server/src/modules/work/request-slack.ts";

const facts = {
  requestId: "6f1d3c1e-1111-4222-8333-944455556666",
  organizationId: "0b8c5f0a-1111-4222-8333-944455556666",
  taskId: "a1b2c3d4-1111-4222-8333-944455556666",
  intent: "approve",
  askerName: "Ada",
  groupName: null,
  workItem: "Release",
};

Deno.test("the Slack request text names who asks for what, links the task and carries the marker", () => {
  const text = requestSlackText("https://bakery.example.test", facts);
  assertEquals(
    text,
    [
      "Ada asked you to approve: Release",
      `Open in Bakery: https://bakery.example.test/tasks/${facts.taskId}?organization=${facts.organizationId}`,
      requestSlackMarker(facts.requestId),
    ].join("\n"),
  );
});

Deno.test("a title longer than the limit is cut to the limit", () => {
  const long = "x".repeat(300);
  const capped = capSlackTitle(long);
  assertEquals([...capped].length, REQUEST_SLACK_TITLE_LIMIT);
  assert(capped.endsWith("\u2026"));
  assertEquals(capSlackTitle("short"), "short");
  const text = requestSlackText("https://bakery.example.test", {
    ...facts,
    workItem: long,
  });
  assert(!text.includes("x".repeat(REQUEST_SLACK_TITLE_LIMIT)));
});

Deno.test("the closing text says how the request ended and keeps the link and marker", () => {
  const handled = requestSlackText("https://bakery.example.test", facts, {
    status: "handled",
    closedByName: "Grace",
  });
  assert(handled.startsWith("Handled by Grace: Release\n"));
  assert(handled.includes(requestSlackMarker(facts.requestId)));
  assert(handled.includes(`/tasks/${facts.taskId}`));
  assertEquals(
    requestSlackText("https://bakery.example.test", facts, {
      status: "expired",
      closedByName: null,
    }).split("\n")[0],
    "Expired: Release",
  );
});
