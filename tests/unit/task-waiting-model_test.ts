import { assert, assertEquals } from "@std/assert";
import { createTranslator } from "../../packages/i18n/src/index.ts";
import {
  cardCopy,
  isShown,
  msUntilNextShown,
  type Offer,
  providerName,
  shownOffers,
  stepRowCopy,
  whenText,
} from "../../apps/web/src/pages/task-waiting/model.ts";

type Target = Offer["targets"][number];

const t = createTranslator({ locale: "en" });
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
// The page's step titles, as the stage tab shows them.
const name = (stepKey: string) =>
  stepKey === "implement" ? "Implement" : stepKey;
const when = (iso: string) => `<${iso.slice(11, 16)}>`;

const target = (over: Partial<Target> = {}): Target => ({
  routeId: "00000000-0000-4000-8000-000000000101",
  provider: "openai",
  model: "gpt-5",
  harness: "codex",
  billingRoute: "subscription",
  health: "healthy",
  eligible: true,
  ineligibleReason: null,
  ...over,
});

const offer = (over: Partial<Offer> = {}): Offer => ({
  runStepId: "00000000-0000-4000-8000-000000000001",
  stepKey: "implement",
  incidentId: "00000000-0000-4000-8000-000000000002",
  incidentGeneration: 1,
  sourceRouteId: "00000000-0000-4000-8000-000000000003",
  source: {
    provider: "anthropic",
    model: "claude-opus",
    harness: "claude_code",
    billingRoute: "subscription",
    health: "open",
  },
  reason: "rate_limited",
  since: ago(120),
  nextCheckAt: "2026-11-20T12:05:00.000Z",
  runVersion: 4,
  estimatedIncrementalCost: null,
  targets: [target()],
  ...over,
});

Deno.test("the card and the run badge wait until the incident is sixty seconds old", () => {
  assertEquals(isShown(offer({ since: ago(59) }), NOW), false);
  assertEquals(isShown(offer({ since: ago(60) }), NOW), true);
  assertEquals(isShown(offer({ since: ago(3600) }), NOW), true);
  assertEquals(isShown(offer({ since: "not a time" }), NOW), false);
  const young = offer({ runStepId: "a", since: ago(10) });
  const old = offer({ runStepId: "b", since: ago(300) });
  assertEquals(shownOffers([young, old], NOW).map((o) => o.runStepId), ["b"]);
});

Deno.test("several waiting steps show one card each, oldest first", () => {
  const first = offer({ runStepId: "a", stepKey: "plan", since: ago(900) });
  const second = offer({ runStepId: "b", stepKey: "build", since: ago(200) });
  const third = offer({ runStepId: "c", stepKey: "ship", since: ago(200) });
  assertEquals(
    shownOffers([third, second, first], NOW).map((o) => o.stepKey),
    ["plan", "build", "ship"],
  );
});

Deno.test("the page knows when the next hidden card is due", () => {
  assertEquals(msUntilNextShown([], NOW), null);
  assertEquals(msUntilNextShown([offer({ since: ago(120) })], NOW), null);
  assertEquals(
    msUntilNextShown([
      offer({ since: ago(10) }),
      offer({ since: ago(40) }),
    ], NOW),
    20_000,
  );
});

Deno.test("every reason reads as its own sentence", () => {
  const expected = {
    rate_limited: "Anthropic has been limiting requests since <12:00>.",
    quota_exhausted: "It has been at its usage limit since <12:00>.",
    credential_invalid: "Anthropic has refused its sign-in since <12:00>.",
    timeout: "Anthropic has not answered in time since <12:00>.",
    transport_failure:
      "Bakery has not been able to reach Anthropic since <12:00>.",
    provider_error: "Anthropic has been returning errors since <12:00>.",
  } as const;
  for (const [reason, sentence] of Object.entries(expected)) {
    const copy = cardCopy(
      offer({
        reason: reason as Offer["reason"],
        since: "2026-11-20T12:00:00.000Z",
      }),
      t,
      when,
      name,
    );
    assertEquals(
      copy.text,
      `The step "Implement" runs on Claude Code with claude-opus, using the subscription on a machine. ${sentence}`,
    );
  }
});

Deno.test("a reason the page does not know reads as errors, never as raw text", () => {
  const copy = cardCopy(
    offer({ reason: "something_new" as Offer["reason"] }),
    t,
    when,
    name,
  );
  assert(copy.text.includes("has been returning errors since"));
});

Deno.test("the card names the agent and the badge, and the step as its tab does", () => {
  const copy = cardCopy(offer(), t, when, name);
  assertEquals(copy.badge, "Waiting on a model");
  assertEquals(copy.title, "Waiting: Claude Code cannot reach its model");
  assert(copy.text.startsWith('The step "Implement" runs on Claude Code'));
  // A step the page has no title for keeps its own key.
  assert(
    cardCopy(offer({ stepKey: "custom" }), t, when, name).text.startsWith(
      'The step "custom" runs on',
    ),
  );
});

Deno.test("the second line, with a next check", () => {
  assertEquals(
    cardCopy(offer(), t, when, name).second,
    "Bakery has not moved this work anywhere else, and the step does not start again by itself. Bakery tries Anthropic again at <12:05>.",
  );
});

Deno.test("the second line, with no next check, drops the last sentence", () => {
  assertEquals(
    cardCopy(offer({ nextCheckAt: null }), t, when, name).second,
    "Bakery has not moved this work anywhere else, and the step does not start again by itself.",
  );
});

Deno.test("the card promises no choice, with or without a target", () => {
  for (
    const targets of [
      [],
      [target({ eligible: false, ineligibleReason: "route_open" })],
      [target()],
    ]
  ) {
    const copy = cardCopy(offer({ targets, nextCheckAt: null }), t, when, name);
    assertEquals(
      copy.second,
      "Bakery has not moved this work anywhere else, and the step does not start again by itself.",
    );
    assert(!copy.second.includes("choose"));
  }
});

Deno.test("no card sentence says the step carries on by itself", () => {
  for (
    const given of [
      offer(),
      offer({ nextCheckAt: null }),
      offer({ targets: [] }),
    ]
  ) {
    const { second } = cardCopy(given, t, when, name);
    assert(second.includes("does not start again by itself"));
    assert(!second.includes("checks again"));
  }
});

Deno.test("the step's row says what it waits on and that it does not restart", () => {
  assertEquals(
    stepRowCopy(offer(), t),
    "Waiting on Claude Code with claude-opus. It does not start again by itself.",
  );
});

Deno.test("each payment reads in plain words", () => {
  const source = offer().source;
  const text = (billingRoute: Target["billingRoute"]) =>
    cardCopy(offer({ source: { ...source, billingRoute } }), t, when, name)
      .text;
  assert(text("subscription").includes("using the subscription on a machine."));
  assert(text("api_metered").includes("using an API key charged per use."));
  assert(text("local").includes("using a model running on a machine."));
});

Deno.test("a provider's name is spelled out, an unknown one is shown as keyed", () => {
  assertEquals(providerName("anthropic"), "Anthropic");
  assertEquals(providerName("openai"), "OpenAI");
  assertEquals(providerName("google"), "Google");
  assertEquals(providerName("mistral"), "Mistral");
  assertEquals(providerName("xai"), "xAI");
  assertEquals(providerName("acme-llm"), "acme-llm");
});

Deno.test("a moment is the time today and the date and time otherwise", () => {
  const format = (value: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(
      value,
    );
  assertEquals(whenText("2026-11-20T09:05:00.000Z", NOW, format), "9:05 AM");
  assertEquals(
    whenText("2026-11-19T09:05:00.000Z", NOW, format),
    "Nov 19, 2026, 9:05 AM",
  );
});
