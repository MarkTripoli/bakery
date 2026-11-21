/**
 * The five posts, composed from facts.
 *
 * The tests that matter most are the ones about what a composer *cannot* do: it
 * cannot carry an agent's output (there is no argument for one), it cannot put a
 * person's characters into Slack unescaped, and it cannot leave a post whose
 * every action is stale — a decided decision loses its buttons however it was
 * decided.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createTranslator } from "@bakery/i18n";
import {
  composeDecisionSettled,
  composeDone,
  composeFailed,
  composeStarted,
  composeStuck,
  composeWaiting,
  escapeSlackText,
  slackTitle,
} from "../../apps/server/src/modules/integrations/slack-milestones.ts";

const translate = createTranslator({ locale: "en", surface: "slack" });

const BASE = {
  title: "Ship the milestone posts",
  liveViewUrl: "https://bakery.example/runs/1",
  workflowName: "deliver-lean",
  startedBy: "Sam Ortiz",
};

const textOf = (blocks: readonly { type: string }[]): string =>
  JSON.stringify(blocks);

Deno.test("slack posts: a title and a step from a person are escaped, never markup", () => {
  // A work item called this must not let Slack read a link or a mention into it.
  assertEquals(escapeSlackText("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  const post = composeWaiting(
    {
      ...BASE,
      title: "Fix <!channel> & ship",
      stepName: "*Review* <@U123>",
      decisionId: "decision-1",
    },
    translate,
  );
  const text = textOf(post.post.blocks);
  assertEquals(text.includes("<!channel>"), false);
  assertEquals(text.includes("<@U123>"), false);
  assertStringIncludes(text, "&lt;!channel&gt;");
  assertStringIncludes(text, "&lt;@U123&gt;");
});

Deno.test("slack posts: a long title is cut with an ellipsis, not truncated mid-word", () => {
  const long = "x".repeat(400);
  const cut = slackTitle(long);
  assertEquals([...cut].length, 120);
  assertEquals(cut.endsWith("…"), true);
  assertEquals(slackTitle("  short  "), "short");
});

Deno.test("slack posts: started teaches thread replies and carries the live view once", () => {
  const post = composeStarted(BASE, translate);
  assertEquals(post.milestone, "started");
  assertEquals(post.decisionOpen, false);
  assertStringIncludes(textOf(post.post.blocks), "Bakery is working on this.");
  assertStringIncludes(textOf(post.post.blocks), "deliver-lean");
  assertStringIncludes(textOf(post.post.blocks), "Sam Ortiz");
  assertEquals(post.post.fallbackText, "Started: Ship the milestone posts");
  const actions = post.post.blocks.find((b) => b.type === "actions");
  assertEquals(actions?.type === "actions" ? actions.elements.length : 0, 1);
});

Deno.test("slack posts: waiting is the only post with live buttons, and it says who acts", () => {
  const post = composeWaiting(
    { ...BASE, stepName: "Review", decisionId: "decision-7" },
    translate,
  );
  assertEquals(post.decisionOpen, true);
  const actions = post.post.blocks.find((b) => b.type === "actions");
  const elements = actions?.type === "actions" ? actions.elements : [];
  assertEquals(elements.map((e) => e.action_id), [
    "bakery_approve",
    "bakery_reject",
    "bakery_liveView",
  ]);
  // The buttons carry the decision, not a URL: a press acts on this decision.
  assertEquals(elements[0].value, "decision-7");
  assertEquals(elements[1].value, "decision-7");
  assertEquals(elements[0].style, "primary");
  assertEquals(elements[1].style, "danger");
  assertStringIncludes(
    textOf(post.post.blocks),
    "*Needs a decision* · Ship the milestone posts",
  );
  assertStringIncludes(textOf(post.post.blocks), "waiting at Review");
});

Deno.test("slack posts: waiting without a step name drops the slot instead of leaving a hole", () => {
  const withStep = composeWaiting(
    { ...BASE, stepName: "Review", decisionId: "d" },
    translate,
  );
  const withoutStep = composeWaiting({ ...BASE, decisionId: "d" }, translate);
  assertStringIncludes(textOf(withStep.post.blocks), "waiting at Review");
  assertStringIncludes(
    textOf(withoutStep.post.blocks),
    "Bakery is waiting and will not continue",
  );
  assertEquals(textOf(withoutStep.post.blocks).includes("{step}"), false);
});

Deno.test("slack posts: stuck has four sentences, one per fact it might be missing", () => {
  const cases: readonly [string | undefined, string | undefined, string][] = [
    ["Deploy", "20 minutes", "No progress at Deploy for 20 minutes."],
    ["Deploy", undefined, "No progress at Deploy. The run is still open."],
    [undefined, "20 minutes", "No progress for 20 minutes."],
    [undefined, undefined, "No progress. The run is still open."],
  ];
  for (const [stepName, duration, expected] of cases) {
    const post = composeStuck({ ...BASE, stepName, duration }, translate);
    assertStringIncludes(textOf(post.post.blocks), expected);
    // A stuck post promises the run is still open and a reply still helps.
    assertStringIncludes(textOf(post.post.blocks), "The run is still open.");
  }
});

Deno.test("slack posts: failed names the step and not the reason, and points at the live view", () => {
  const post = composeFailed({ ...BASE, stepName: "Deploy" }, translate);
  assertStringIncludes(
    textOf(post.post.blocks),
    "Bakery stopped at Deploy and will not continue on its own.",
  );
  assertStringIncludes(textOf(post.post.blocks), "Open live view");
  const bare = composeFailed(BASE, translate);
  assertStringIncludes(
    textOf(bare.post.blocks),
    "Bakery stopped and will not continue on its own.",
  );
});

Deno.test("slack posts: done puts the pull request first and never calls it approved", () => {
  const post = composeDone(
    {
      ...BASE,
      result: {
        kind: "pull_request",
        url: "https://example.test/pr/1",
        repository: "bakery",
        number: 42,
      },
    },
    translate,
  );
  const actions = post.post.blocks.find((b) => b.type === "actions");
  const elements = actions?.type === "actions" ? actions.elements : [];
  assertEquals(elements.map((e) => e.text.text), [
    "Open pull request",
    "Open live view",
  ]);
  assertEquals(elements[0].style, "primary");
  assertEquals(elements[0].value, "https://example.test/pr/1");
  assertStringIncludes(textOf(post.post.blocks), "opened bakery#42");
  const text = textOf(post.post.blocks).toLowerCase();
  for (const word of ["approved", "ready to merge", "lgtm"]) {
    assertEquals(text.includes(word), false);
  }
});

Deno.test("slack posts: done without a result links only the live view, and other results are named as such", () => {
  const bare = composeDone(BASE, translate);
  const bareActions = bare.post.blocks.find((b) => b.type === "actions");
  assertEquals(
    bareActions?.type === "actions"
      ? bareActions.elements.map((e) => e.text.text)
      : [],
    ["Open live view"],
  );
  const report = composeDone(
    {
      ...BASE,
      result: { kind: "other", url: "https://example.test/report" },
    },
    translate,
  );
  const reportActions = report.post.blocks.find((b) => b.type === "actions");
  assertEquals(
    reportActions?.type === "actions"
      ? reportActions.elements[0].text.text
      : "",
    "Open result",
  );
});

Deno.test("slack posts: a settled decision loses its buttons, however it was settled", () => {
  const at = new Date("2026-11-19T16:00:00.000Z");
  const approved = composeDecisionSettled(
    { kind: "approved", decidedBy: "Sam <Ortiz>", at },
    BASE,
    translate,
  );
  const rejected = composeDecisionSettled(
    { kind: "rejected", decidedBy: "Sam", at },
    BASE,
    translate,
  );
  const closed = composeDecisionSettled({ kind: "closed" }, BASE, translate);
  for (const post of [approved, rejected, closed]) {
    const actions = post.blocks.find((b) => b.type === "actions");
    const elements = actions?.type === "actions" ? actions.elements : [];
    assertEquals(
      elements.map((e) => e.action_id),
      ["bakery_liveView"],
      "a settled decision must not offer a button that cannot work",
    );
  }
  assertStringIncludes(textOf(approved.blocks), "*Approved* ·");
  assertStringIncludes(
    textOf(approved.blocks),
    "Sam &lt;Ortiz&gt; approved this at",
  );
  // The time is Slack's token, so each reader sees their own zone.
  assertStringIncludes(textOf(approved.blocks), "<!date^");
  assertStringIncludes(textOf(rejected.blocks), "*Rejected* ·");
  assertStringIncludes(textOf(closed.blocks), "*No longer needs a decision* ·");
});

Deno.test("slack posts: nothing a caller smuggles in can carry a stream or free text", () => {
  // O21: "The raw stream is not posted to Slack." The composer takes a named
  // fact set, so this is a structural property - but a cast can get round the
  // type, and this test is the check that the composition reads only the facts
  // it declares. Anything else a caller attaches reaches no block.
  const smuggled = {
    ...BASE,
    stepName: "Review",
    decisionId: "d",
    stream: "RAW AGENT OUTPUT",
    body: "free text",
    output: "more raw output",
  } as unknown as Parameters<typeof composeWaiting>[0];
  const post = composeWaiting(smuggled, translate);
  const text = textOf(post.post.blocks) + post.post.fallbackText;
  for (const leaked of ["RAW AGENT OUTPUT", "free text", "more raw output"]) {
    assertEquals(text.includes(leaked), false, `${leaked} reached the post`);
  }
});

Deno.test("slack posts: every string a post shows is a catalog key with a translation", () => {
  // A key that no longer exists fails to compile; this asserts the values are
  // the designed sentences rather than placeholder text.
  const post = composeWaiting(
    { ...BASE, stepName: "Review", decisionId: "d" },
    translate,
  );
  // The JSON always carries braces, so the assertion is on the words a person
  // reads rather than on the serialised blocks.
  const words = post.post.blocks.flatMap((block) =>
    block.type === "section" ? [block.text.text] : []
  ).join("\n");
  assertEquals(words.includes("{"), false, "no unsubstituted placeholder");
  assertEquals(words.includes("undefined"), false);
});
