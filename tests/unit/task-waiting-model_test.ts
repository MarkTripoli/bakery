import { assert, assertEquals } from "@std/assert";
import { createTranslator } from "../../packages/i18n/src/index.ts";
import english from "../../packages/i18n/locales/en.json" with { type: "json" };
import {
  canChoose,
  cardCopy,
  choiceDetail,
  choiceLabel,
  continuedNotice,
  continueLabel,
  costLine,
  eligibleTargets,
  healthBadge,
  isShown,
  msUntilNextShown,
  type Offer,
  outcomeUnknown,
  paymentNotice,
  providerName,
  REFUSAL_REASONS,
  refusalOf,
  shownOffers,
  stepRowCopy,
  type Target,
  unavailableChoices,
  whenText,
} from "../../apps/web/src/pages/task-waiting/model.ts";

const t = createTranslator({ locale: "en" });
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
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
    );
    assertEquals(
      copy.text,
      `The step "implement" runs on Claude Code with claude-opus, using the subscription on a machine. ${sentence}`,
    );
  }
});

Deno.test("a reason the page does not know reads as errors, never as raw text", () => {
  const copy = cardCopy(
    offer({ reason: "something_new" as Offer["reason"] }),
    t,
    when,
  );
  assert(copy.text.includes("has been returning errors since"));
});

Deno.test("the card names the agent, the badge and the button", () => {
  const copy = cardCopy(offer(), t, when);
  assertEquals(copy.badge, "Waiting on a model");
  assertEquals(copy.title, "Waiting: Claude Code cannot reach its model");
  assertEquals(copy.button, "Choose another way to run it");
});

Deno.test("the second line, with a next check", () => {
  assertEquals(
    cardCopy(offer(), t, when).second,
    "Bakery has not moved this work anywhere else, and the step does not start again by itself. It stays waiting until someone chooses another way to run it. Bakery tries Anthropic again at <12:05>.",
  );
});

Deno.test("the second line, with no next check, drops the last sentence", () => {
  assertEquals(
    cardCopy(offer({ nextCheckAt: null }), t, when).second,
    "Bakery has not moved this work anywhere else, and the step does not start again by itself. It stays waiting until someone chooses another way to run it.",
  );
});

Deno.test("with no target to choose there is no button and the line says so", () => {
  for (
    const targets of [
      [],
      [target({ eligible: false, ineligibleReason: "route_open" })],
    ]
  ) {
    const given = offer({ targets });
    assertEquals(canChoose(given), false);
    const copy = cardCopy(given, t, when);
    assertEquals(copy.button, null);
    assertEquals(
      copy.second,
      "Bakery has not moved this work anywhere else, and the step does not start again by itself. There is no other way to run this step right now.",
    );
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
    const { second } = cardCopy(given, t, when);
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
  const detail = (billingRoute: Target["billingRoute"]) =>
    choiceDetail(t, target({ billingRoute }));
  assertEquals(
    detail("subscription"),
    "OpenAI · The subscription on a machine",
  );
  assertEquals(detail("api_metered"), "OpenAI · Charged per use to an API key");
  assertEquals(detail("local"), "OpenAI · A model running on a machine");
  const source = offer().source;
  assertEquals(
    cardCopy(
      offer({ source: { ...source, billingRoute: "api_metered" } }),
      t,
      when,
    ).text.includes("using an API key charged per use."),
    true,
  );
});

Deno.test("a provider's name is spelled out, an unknown one is shown as keyed", () => {
  assertEquals(providerName("anthropic"), "Anthropic");
  assertEquals(providerName("openai"), "OpenAI");
  assertEquals(providerName("google"), "Google");
  assertEquals(providerName("mistral"), "Mistral");
  assertEquals(providerName("xai"), "xAI");
  assertEquals(providerName("acme-llm"), "acme-llm");
});

Deno.test("a choice is called agent with model, and badges mark the doubtful ones", () => {
  assertEquals(choiceLabel(t, target()), "Codex with gpt-5");
  assertEquals(healthBadge(t, { health: "healthy" }), null);
  assertEquals(healthBadge(t, { health: "open" }), null);
  assertEquals(healthBadge(t, { health: "degraded" }), {
    tone: "warning",
    text: "Having trouble too",
  });
  assertEquals(healthBadge(t, { health: "unverified" }), {
    tone: "neutral",
    text: "Not tried yet",
  });
});

Deno.test("the payment notice appears only when the choice is paid differently", () => {
  const source = offer().source;
  assertEquals(
    paymentNotice(t, source, target({ billingRoute: "subscription" })),
    null,
  );
  assertEquals(
    paymentNotice(t, source, target({ billingRoute: "api_metered" })),
    "This changes how the work is paid for: from the subscription on a machine to an API key charged per use.",
  );
  assertEquals(
    paymentNotice(
      t,
      { billingRoute: "api_metered" },
      target({ billingRoute: "local" }),
    ),
    "This changes how the work is paid for: from an API key charged per use to a model running on a machine.",
  );
});

Deno.test("the button and the success notice name the choice", () => {
  assertEquals(
    continueLabel(t, target({ billingRoute: "api_metered" })),
    "Continue with gpt-5, an API key charged per use",
  );
  assertEquals(
    continuedNotice(t, target()),
    "Continuing with Codex with gpt-5. The step starts again.",
  );
});

Deno.test("only eligible targets are choices, in the server's order", () => {
  const given = offer({
    targets: [
      target({ routeId: "b", model: "second" }),
      target({
        routeId: "x",
        eligible: false,
        ineligibleReason: "different_harness",
      }),
      target({ routeId: "a", model: "first" }),
    ],
  });
  assertEquals(eligibleTargets(given).map((one) => one.routeId), ["b", "a"]);
});

Deno.test("routes that cannot be used are counted and each says why", () => {
  assertEquals(unavailableChoices(t, offer()), null);
  const given = offer({
    targets: [
      target(),
      target({
        model: "m1",
        harness: "pi",
        eligible: false,
        ineligibleReason: "different_harness",
      }),
      target({
        model: "m2",
        eligible: false,
        ineligibleReason: "route_open",
      }),
      target({
        model: "m3",
        eligible: false,
        ineligibleReason: "route_not_active",
      }),
    ],
  });
  assertEquals(unavailableChoices(t, given), {
    summary: "3 others cannot be used",
    lines: [
      "Pi with m1: A different coding agent",
      "Codex with m2: Not working right now",
      "Codex with m3: Turned off",
    ],
  });
  assertEquals(
    unavailableChoices(
      t,
      offer({
        targets: [
          target(),
          target({ eligible: false, ineligibleReason: "route_open" }),
        ],
      }),
    )?.summary,
    "1 other cannot be used",
  );
});

Deno.test("the cost is unknown until the server sends a figure", () => {
  const money = (value: number) => `$${value.toFixed(2)}`;
  assertEquals(
    costLine(t, { estimatedIncrementalCost: null }, money),
    "The amount held for this run stays the same. What the rest will cost this way: Unknown.",
  );
  assertEquals(
    costLine(t, { estimatedIncrementalCost: "1.5000" }, money),
    "The amount held for this run stays the same. What the rest will cost this way: $1.50.",
  );
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

const problem = (code: string, reason?: string, status = 409) => ({
  kind: "problem",
  problem: { code, status, retryable: false, ...(reason ? { reason } : {}) },
});

Deno.test("every refusal the server names has its place and its sentence", () => {
  const catalog = english as Record<string, string>;
  const expected: Record<string, [string, string]> = {
    incident_not_current: [
      "page",
      "This changed while you were choosing. Nothing was switched; the latest is shown.",
    ],
    step_not_pinned_to_route: [
      "page",
      "This changed while you were choosing. Nothing was switched; the latest is shown.",
    ],
    already_continued: [
      "page",
      "Someone already chose another way for this step. The latest is shown.",
    ],
    run_not_active: [
      "page",
      "This run has ended or is being canceled. Nothing was switched.",
    ],
    cancel_requested: [
      "page",
      "This run has ended or is being canceled. Nothing was switched.",
    ],
    target_route_not_active: [
      "dialog",
      "That one can no longer be used. Pick another.",
    ],
    target_route_open: [
      "dialog",
      "That one can no longer be used. Pick another.",
    ],
    target_different_harness: [
      "dialog",
      "That one can no longer be used. Pick another.",
    ],
    target_pin_unchanged: [
      "dialog",
      "That one can no longer be used. Pick another.",
    ],
    target_pricing_unavailable: [
      "dialog",
      "Bakery has no price for that one, so it cannot hold a budget for it. Pick another.",
    ],
    awaiting_reconciliation: [
      "dialog",
      "Bakery is still confirming what the last attempt did. Try again in a moment.",
    ],
    spend_in_flight: [
      "dialog",
      "Bakery is still confirming what the last attempt did. Try again in a moment.",
    ],
    job_not_funded: [
      "dialog",
      "This step has no budget or attempts left, so it cannot be moved.",
    ],
    attempt_budget_exhausted: [
      "dialog",
      "This step has no budget or attempts left, so it cannot be moved.",
    ],
  };
  assertEquals([...REFUSAL_REASONS].sort(), Object.keys(expected).sort());
  for (const reason of REFUSAL_REASONS) {
    const refusal = refusalOf(problem("STATE_CONFLICT", reason));
    assertEquals(
      [refusal.where, catalog[refusal.key]],
      expected[reason],
      reason,
    );
  }
});

Deno.test("a changed run, read from the precondition, closes the dialog and reloads", () => {
  const refusal = refusalOf(problem("PRECONDITION_FAILED", undefined, 412));
  assertEquals(refusal.where, "page");
  assertEquals(
    t(refusal.key),
    "This changed while you were choosing. Nothing was switched; the latest is shown.",
  );
});

Deno.test("a target that can no longer be used reloads the choices", () => {
  for (
    const reason of [
      "target_route_not_active",
      "target_route_open",
      "target_different_harness",
      "target_pin_unchanged",
    ]
  ) {
    assertEquals(refusalOf(problem("STATE_CONFLICT", reason)).reload, true);
  }
  assertEquals(
    refusalOf(problem("STATE_CONFLICT", "job_not_funded")).reload,
    false,
  );
});

Deno.test("any other refusal says nothing was switched", () => {
  for (
    const failure of [
      problem("STATE_CONFLICT", "something_new"),
      problem("STATE_CONFLICT"),
      problem("RESOURCE_NOT_FOUND", undefined, 404),
      problem("UNPROCESSABLE", undefined, 422),
      { kind: "network" },
      { kind: "invalid-response" },
    ]
  ) {
    const refusal = refusalOf(failure);
    assertEquals(refusal.where, "dialog");
    assertEquals(t(refusal.key), "Nothing was switched. Try again.");
  }
});

Deno.test("an answer that never arrived keeps its key for the retry", () => {
  assertEquals(outcomeUnknown({ kind: "network" }), true);
  assertEquals(outcomeUnknown(problem("INTERNAL_ERROR", undefined, 503)), true);
  assertEquals(
    outcomeUnknown(problem("STATE_CONFLICT", "spend_in_flight")),
    false,
  );
  assertEquals(
    outcomeUnknown(problem("PRECONDITION_FAILED", undefined, 412)),
    false,
  );
});
