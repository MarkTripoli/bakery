import { assert, assertEquals } from "@std/assert";
import { createTranslator } from "../../packages/i18n/src/index.ts";
import {
  cardCopy,
  choiceSummary,
  continueLabel,
  costLine,
  isShown,
  msUntilNextShown,
  type Offer,
  orderTargets,
  outcomeUnknown,
  paymentNotice,
  providerEntries,
  providerName,
  refusalOf,
  searchTargets,
  shownOffers,
  stateLabel,
  stepRowCopy,
  SUGGESTED,
  suggestedTargets,
  targetsOf,
  unavailableLines,
  unavailableSummary,
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
  providerName: "OpenAI",
  modelName: "gpt-5",
  health: "healthy",
  priced: true,
  estimatedIncrementalCost: null,
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
    providerName: "Anthropic",
    modelName: "claude-opus",
    harness: "claude_code",
    billingRoute: "subscription",
    health: "open",
  },
  reason: "rate_limited",
  since: ago(120),
  nextCheckAt: "2026-11-20T12:05:00.000Z",
  runVersion: 4,
  targets: [target()],
  unavailable: [],
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
    "Bakery has not moved this work anywhere else. It tries the step again with the same model, and the waiting ends when a try works. Bakery also checks Anthropic at <12:05>.",
  );
});

Deno.test("the second line, with no next check, drops the last sentence", () => {
  assertEquals(
    cardCopy(offer({ nextCheckAt: null }), t, when, name).second,
    "Bakery has not moved this work anywhere else. It tries the step again with the same model, and the waiting ends when a try works.",
  );
});

Deno.test("the second line says there is no other way only when no target can be chosen", () => {
  const waits =
    "Bakery has not moved this work anywhere else. It tries the step again with the same model, and the waiting ends when a try works.";
  const second = (targets: ReturnType<typeof target>[]) =>
    cardCopy(offer({ targets, nextCheckAt: null }), t, when, name).second;
  assertEquals(
    second([]),
    `${waits} There is no other way to run this step right now.`,
  );
  for (const targets of [[target({ priced: false })], [target()]]) {
    assertEquals(second(targets), waits);
    assert(!second(targets).includes("choose"));
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
    assert(second.includes("waiting ends when a try works"));
    assert(!second.includes("checks again"));
  }
});

Deno.test("the step's row says what it waits on and that it does not restart", () => {
  assertEquals(
    stepRowCopy(offer(), t),
    "Waiting on Claude Code with claude-opus. Bakery tries it again with the same model.",
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

// ---- the chooser (UX revision 3)

let n = 200;
const route = (over: Partial<Target> = {}): Target =>
  target({
    routeId: `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
    provider: "anthropic",
    providerName: "Anthropic",
    harness: "claude_code",
    model: over.modelName ?? "claude-sonnet",
    ...over,
  });

Deno.test("models read Working, Not tried yet, Having trouble too, then by name", () => {
  const rows = orderTargets([
    route({ modelName: "b", health: "degraded" }),
    route({ modelName: "z", health: "healthy" }),
    route({ modelName: "a", health: "unverified" }),
    route({ modelName: "a", health: "degraded" }),
    route({ modelName: "c", health: "healthy" }),
  ]);
  assertEquals(rows.map((r) => `${r.health}:${r.modelName}`), [
    "healthy:c",
    "healthy:z",
    "unverified:a",
    "degraded:a",
    "degraded:b",
  ]);
});

Deno.test("Suggested: Working, priced and paid the same way, same provider first, at most five", () => {
  const openai = (m: string) =>
    route({ provider: "openai", providerName: "OpenAI", modelName: m });
  const targets = [
    openai("a-openai"),
    openai("b-openai"),
    route({ modelName: "z-same" }),
    route({ modelName: "y-same" }),
    route({ modelName: "trouble", health: "degraded" }),
    route({ modelName: "new", health: "unverified" }),
    route({ modelName: "metered", billingRoute: "api_metered" }),
    route({ modelName: "unpriced", priced: false }),
    openai("c-openai"),
    openai("d-openai"),
  ];
  const suggested = suggestedTargets(offer({ targets }));
  assertEquals(suggested.map((r) => r.modelName), [
    "y-same",
    "z-same",
    "a-openai",
    "b-openai",
    "c-openai",
  ]);
  const list = providerEntries(offer({ targets }), "Suggested");
  assertEquals(list.map((e) => [e.key, e.count]), [
    [SUGGESTED, 5],
    ["anthropic", 6],
    ["openai", 4],
  ]);
  assertEquals(targetsOf(offer({ targets }), SUGGESTED), suggested);
  assertEquals(
    targetsOf(offer({ targets }), "openai").map((r) => r.modelName),
    ["a-openai", "b-openai", "c-openai", "d-openai"],
  );
  // Nothing qualifies: no Suggested entry, the first provider leads.
  const none = providerEntries(
    offer({ targets: [route({ health: "degraded" })] }),
    "Suggested",
  );
  assertEquals(none.map((e) => e.key), ["anthropic"]);
});

Deno.test("search matches model and provider names across every provider", () => {
  const targets = [
    route({ modelName: "claude-sonnet" }),
    route({ provider: "openai", providerName: "OpenAI", modelName: "gpt-5" }),
    route({
      provider: "openrouter",
      providerName: "OpenRouter",
      modelName: "gpt-5-mini",
    }),
  ];
  const gpt = searchTargets(targets, " GPT ");
  assertEquals(gpt.matches.map((r) => r.modelName), ["gpt-5", "gpt-5-mini"]);
  assertEquals(gpt.providers, 2);
  assertEquals(
    searchTargets(targets, "anthropic").matches.map((r) => r.modelName),
    ["claude-sonnet"],
  );
  assertEquals(searchTargets(targets, "   ").matches, []);
  assertEquals(searchTargets(targets, "llama").matches, []);
  assertEquals(
    t("tasks.waiting.chooser.searchResults", {
      count: 2,
      text: "gpt",
      providers: 2,
    }),
    '2 models match "gpt" across 2 providers.',
  );
});

Deno.test("the end bar names the choice, the payment change and the cost", () => {
  const metered = route({
    provider: "openai",
    providerName: "OpenAI",
    modelName: "gpt-5-mini",
    billingRoute: "api_metered",
  });
  assertEquals(
    choiceSummary(t, metered),
    "OpenAI · gpt-5-mini · Charged per use to an API key",
  );
  assertEquals(
    paymentNotice(t, offer().source, metered),
    "This changes how the work is paid for: from the subscription on a machine to an API key charged per use.",
  );
  assertEquals(paymentNotice(t, offer().source, route()), null);
  assertEquals(continueLabel(t, null), "Continue");
  assertEquals(continueLabel(t, metered), "Continue with gpt-5-mini");
  assertEquals(
    costLine(t, metered, (v) => `$${v}`),
    "The amount held for this run stays the same. What the rest will cost this way: Unknown.",
  );
  assert(
    costLine(t, { estimatedIncrementalCost: "1.5" }, (v) => `$${v}`)
      .endsWith("this way: $1.5."),
  );
  assertEquals(stateLabel(t, route({ priced: false })).text, "No price set");
  assertEquals(stateLabel(t, route()).text, "Working");
});

Deno.test("routes that cannot be used read as counts, one line per reason", () => {
  const o = offer({
    unavailable: [
      {
        reason: "route_not_active",
        count: 3,
        routes: [{
          provider: "openai",
          model: "o3",
          providerName: "OpenAI",
          modelName: "o3",
        }],
      },
      {
        reason: "different_harness",
        count: 4,
        harnesses: [{ harness: "codex", count: 3 }, {
          harness: "pi",
          count: 1,
        }],
      },
      {
        reason: "route_open",
        count: 2,
        routes: [{
          provider: "openai",
          model: "gpt-5",
          providerName: "OpenAI",
          modelName: "gpt-5",
        }],
      },
    ],
  });
  assertEquals(unavailableSummary(t, o), "9 routes cannot be used");
  assertEquals(unavailableSummary(t, offer()), null);
  assertEquals(unavailableLines(t, o).map((l) => l.text), [
    "Turned off in Settings, Providers.",
    "A different coding agent (4): Codex 3, Pi 1",
    "Not working right now (2): OpenAI gpt-5 and 1 more",
  ]);
  // Turned off routes name themselves behind "Show the {n}", once.
  assertEquals(unavailableLines(t, o)[0]!.more, {
    label: "Show the 3",
    names: "OpenAI o3 and 2 more",
  });
  assertEquals(
    unavailableLines(
      t,
      offer({
        unavailable: [{ reason: "route_not_active", count: 1 }],
      }),
    )[0]!.more,
    undefined,
  );
});

Deno.test("a refused choice maps to where it is said and whether choices reload", () => {
  const conflict = (reason?: string) => ({
    kind: "problem",
    problem: { code: "STATE_CONFLICT", reason, status: 409, retryable: false },
  });
  assertEquals(
    refusalOf({
      kind: "problem",
      problem: { code: "PRECONDITION_FAILED" },
    }),
    { where: "page", reload: true, key: "tasks.waiting.refused.changed" },
  );
  assertEquals(refusalOf(conflict("already_continued")).where, "page");
  assertEquals(
    refusalOf(conflict("cancel_requested")).key,
    "tasks.waiting.refused.runEnded",
  );
  assertEquals(refusalOf(conflict("target_route_open")), {
    where: "chooser",
    reload: true,
    key: "tasks.waiting.refused.targetGone",
  });
  assertEquals(refusalOf(conflict("target_pricing_unavailable")), {
    where: "chooser",
    reload: false,
    key: "tasks.waiting.refused.noPrice",
  });
  assertEquals(
    refusalOf(conflict("spend_in_flight")).key,
    "tasks.waiting.refused.confirming",
  );
  assertEquals(
    refusalOf(conflict("job_not_funded")).key,
    "tasks.waiting.refused.noBudget",
  );
  assertEquals(
    refusalOf(conflict("something_new")).key,
    "tasks.waiting.refused.other",
  );
  assertEquals(refusalOf(conflict()).key, "tasks.waiting.refused.other");
  assertEquals(
    refusalOf({ kind: "network" }).key,
    "tasks.waiting.refused.other",
  );
  // A lost answer keeps the idempotency key for the retry; a definite one ends it.
  assertEquals(outcomeUnknown({ kind: "network" }), true);
  assertEquals(outcomeUnknown(conflict("job_not_funded")), false);
  assertEquals(
    outcomeUnknown({
      kind: "problem",
      problem: { status: 503, retryable: false },
    }),
    true,
  );
});
