import { assert, assertEquals } from "@std/assert";
import {
  capSlackTitle,
  REQUEST_SLACK_TITLE_LIMIT,
  requestSlackMarker,
  requestSlackText,
} from "../../apps/server/src/modules/work/request-slack.ts";

const BASE = "https://bakery.example.test";
const facts = {
  requestId: "6f1d3c1e-1111-4222-8333-944455556666",
  organizationId: "0b8c5f0a-1111-4222-8333-944455556666",
  taskId: "a1b2c3d4-1111-4222-8333-944455556666",
  intent: "approve",
  askerName: "Ada",
  audienceName: null,
  stepName: "deploy",
  workItem: "Release",
  passedOnFrom: null,
  expiresAt: new Date("2026-12-03T09:00:00Z"),
};
const link =
  `<${BASE}/tasks/${facts.taskId}?organization=${facts.organizationId}&request=${facts.requestId}|Open in Bakery>`;

const lines = (text: string) => text.split("\n");

Deno.test("an approval asked directly reads as the design's Needs a decision message", () => {
  assertEquals(lines(requestSlackText(BASE, facts)), [
    "*Needs a decision* · Release",
    "Ada asked you to approve deploy.",
    link,
  ]);
  assert(
    requestSlackText(BASE, facts).includes(requestSlackMarker(facts.requestId)),
  );
});

Deno.test("a request to a group says any one member can answer", () => {
  assertEquals(
    lines(requestSlackText(BASE, { ...facts, audienceName: "Reviewers" }))[1],
    "Ada asked Reviewers to approve deploy. Any one member can answer.",
  );
});

Deno.test("each kind of request has its status word and review, answer and take over send people to Bakery", () => {
  const variant = (intent: string) =>
    lines(requestSlackText(BASE, { ...facts, intent })).slice(0, 2);
  assertEquals(variant("review"), [
    "*Review requested* · Release",
    "Ada asked you to review deploy. Open Bakery to read it.",
  ]);
  assertEquals(variant("answer"), [
    "*Question for you* · Release",
    "Ada asked you to answer a question in deploy. Open Bakery to read it.",
  ]);
  assertEquals(variant("take_over"), [
    "*Take over requested* · Release",
    "Ada asked you to take over deploy. Open Bakery to read it.",
  ]);
  assertEquals(variant("fyi"), [
    "*For your information* · Release",
    "Ada wants you to see this.",
  ]);
});

Deno.test("a request passed on says who did not answer", () => {
  assertEquals(
    lines(requestSlackText(BASE, { ...facts, passedOnFrom: "Grace" }))[1],
    "Grace did not answer, so Ada's request to approve deploy now comes to you.",
  );
});

Deno.test("a closed request is rewritten with the design's wording and keeps the link", () => {
  assertEquals(
    lines(
      requestSlackText(BASE, facts, {
        status: "handled",
        closedByName: "Grace",
      }),
    ),
    ["*Handled by Grace* · Release", link],
  );
  assertEquals(
    lines(
      requestSlackText(BASE, facts, { status: "expired", closedByName: null }),
    ),
    [
      "*Expired* · Release",
      "Nobody answered by <!date^1796288400^{date_short_pretty}|2026-12-03>.",
      link,
    ],
  );
  assertEquals(
    lines(
      requestSlackText(BASE, facts, {
        status: "withdrawn",
        closedByName: null,
      }),
    ),
    ["*Withdrawn* · Release", "Ada withdrew this request.", link],
  );
});

Deno.test("the title is cut to the limit and no note or question text is carried", () => {
  const long = "x".repeat(300);
  const capped = capSlackTitle(long);
  assertEquals([...capped].length, REQUEST_SLACK_TITLE_LIMIT);
  assert(capped.endsWith("\u2026"));
  assertEquals(capSlackTitle("short"), "short");
  const text = requestSlackText(BASE, { ...facts, workItem: long });
  assert(!text.includes("x".repeat(REQUEST_SLACK_TITLE_LIMIT)));
  assertEquals(Object.keys(facts).includes("note"), false);
});
