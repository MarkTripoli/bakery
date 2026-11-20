// What the task page says about a step that waits on a model (#70, slice 2), as
// plain functions: which offers are shown and when, the words of the card, the
// dialog and the step's row, and what each refusal of a choice means. No React,
// so one unit test proves the rules.
//
// The words are design-ux's (the slice 2 design and its ruling on the second
// line). Nothing here chooses for the person: Bakery never switches by itself,
// and a card only offers the choice.
import type { MessageKey, Translator } from "@bakery/i18n";
import type { RouteContinuationOffersResponse } from "../../api/client.ts";

export type Offer = RouteContinuationOffersResponse["offers"][number];
export type Target = Offer["targets"][number];
type Harness = Offer["source"]["harness"];
type Billing = Offer["source"]["billingRoute"];
type Reason = Offer["reason"];

/** The card and the run badge appear only once the incident is this old. */
export const SHOWN_AFTER_MS = 60_000;

const sinceMs = (offer: Pick<Offer, "since">): number =>
  Date.parse(offer.since);

/** True once the incident the step waits behind is old enough to say so. */
export function isShown(offer: Pick<Offer, "since">, nowMs: number): boolean {
  const since = sinceMs(offer);
  return Number.isFinite(since) && nowMs - since >= SHOWN_AFTER_MS;
}

/** The offers to show: old enough, oldest first (one card per step). */
export function shownOffers(
  offers: readonly Offer[],
  nowMs: number,
): Offer[] {
  return offers
    .filter((offer) => isShown(offer, nowMs))
    .sort((a, b) =>
      sinceMs(a) - sinceMs(b) || a.stepKey.localeCompare(b.stepKey) ||
      a.runStepId.localeCompare(b.runStepId)
    );
}

/** Milliseconds until the next hidden offer becomes old enough, or null. */
export function msUntilNextShown(
  offers: readonly Offer[],
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const offer of offers) {
    const since = sinceMs(offer);
    if (!Number.isFinite(since) || isShown(offer, nowMs)) continue;
    const wait = since + SHOWN_AFTER_MS - nowMs;
    if (next === null || wait < next) next = wait;
  }
  return next;
}

const AGENT_KEYS: Record<Harness, MessageKey> = {
  pi: "tasks.waiting.agent.pi",
  claude_code: "tasks.waiting.agent.claude_code",
  codex: "tasks.waiting.agent.codex",
  mastra: "tasks.waiting.agent.mastra",
};

/** The coding agent, by the name a person knows it by. */
export function agentName(t: Translator, harness: Harness): string {
  return t(AGENT_KEYS[harness]);
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** A provider's name: the known brands spelled out, any other as it is keyed. */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

const PAYMENT_KEYS: Record<Billing, MessageKey> = {
  subscription: "tasks.waiting.payment.subscription",
  api_metered: "tasks.waiting.payment.api_metered",
  local: "tasks.waiting.payment.local",
};

const PAYMENT_INLINE_KEYS: Record<Billing, MessageKey> = {
  subscription: "tasks.waiting.payment.subscription.inline",
  api_metered: "tasks.waiting.payment.api_metered.inline",
  local: "tasks.waiting.payment.local.inline",
};

/** How the work is paid, as a label ("The subscription on a machine"). */
export function paymentLabel(t: Translator, billing: Billing): string {
  return t(PAYMENT_KEYS[billing]);
}

/** How the work is paid, to read inside a sentence ("paid by …"). */
export function paymentInline(t: Translator, billing: Billing): string {
  return t(PAYMENT_INLINE_KEYS[billing]);
}

const REASON_KEYS: Record<Reason, MessageKey> = {
  rate_limited: "tasks.waiting.reason.rate_limited",
  quota_exhausted: "tasks.waiting.reason.quota_exhausted",
  credential_invalid: "tasks.waiting.reason.credential_invalid",
  timeout: "tasks.waiting.reason.timeout",
  transport_failure: "tasks.waiting.reason.transport_failure",
  provider_error: "tasks.waiting.reason.provider_error",
};

/** The reason sentence; a reason this page does not know reads as errors. */
function reasonKey(reason: string): MessageKey {
  return REASON_KEYS[reason as Reason] ?? REASON_KEYS.provider_error;
}

/**
 * Says a moment: the time alone when it is today, the date and time otherwise.
 * `format` is the page's own date formatter (its language and time zone).
 */
export function whenText(
  iso: string,
  nowMs: number,
  format: (value: Date, options: Intl.DateTimeFormatOptions) => string,
): string {
  const moment = new Date(iso);
  const day: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  };
  return format(moment, day) === format(new Date(nowMs), day)
    ? format(moment, { timeStyle: "short" })
    : format(moment, { dateStyle: "medium", timeStyle: "short" });
}

/** Targets the step may continue on, in the server's order. */
export function eligibleTargets(offer: Pick<Offer, "targets">): Target[] {
  return offer.targets.filter((target) => target.eligible);
}

/** True when there is a way to run the step; otherwise the button is hidden. */
export function canChoose(offer: Pick<Offer, "targets">): boolean {
  return offer.targets.some((target) => target.eligible);
}

export type CardCopy = Readonly<{
  /** "Waiting on a model", the run's badge. */
  badge: string;
  title: string;
  /** What the step runs on and why it waits, since when. */
  text: string;
  /** What Bakery has and has not done, and what happens next. */
  second: string;
  /** The button's label, or null when no other way can be chosen. */
  button: string | null;
}>;

/** The words of one waiting card. */
export function cardCopy(
  offer: Offer,
  t: Translator,
  when: (iso: string) => string,
): CardCopy {
  const { source } = offer;
  const agent = agentName(t, source.harness);
  const provider = providerName(source.provider);
  const choosable = canChoose(offer);
  const second = !choosable
    ? t("tasks.waiting.second.noTarget")
    : offer.nextCheckAt === null
    ? t("tasks.waiting.second.noCheck")
    : t("tasks.waiting.second.withCheck", {
      provider,
      time: when(offer.nextCheckAt),
    });
  return {
    badge: t("tasks.waiting.badge"),
    title: t("tasks.waiting.title", { agent }),
    text: [
      t("tasks.waiting.runsOn", {
        step: offer.stepKey,
        agent,
        model: source.model,
        payment: paymentInline(t, source.billingRoute),
      }),
      t(reasonKey(offer.reason), { provider, time: when(offer.since) }),
    ].join(" "),
    second,
    button: choosable ? t("tasks.waiting.choose") : null,
  };
}

/** The step's row while it waits on a model. */
export function stepRowCopy(offer: Offer, t: Translator): string {
  return t("tasks.waiting.stepRow", {
    agent: agentName(t, offer.source.harness),
    model: offer.source.model,
  });
}

/** What a choice is called: "{Agent} with {model}". */
export function choiceLabel(t: Translator, target: Target): string {
  return t("tasks.waiting.dialog.choice", {
    agent: agentName(t, target.harness),
    model: target.model,
  });
}

/** The line under a choice: "{Provider} · {how it is paid}". */
export function choiceDetail(t: Translator, target: Target): string {
  return t("tasks.waiting.dialog.choiceDetail", {
    provider: providerName(target.provider),
    payment: paymentLabel(t, target.billingRoute),
  });
}

/** The badge beside a choice, only for a target that is not simply healthy. */
export function healthBadge(
  t: Translator,
  target: Pick<Target, "health">,
): { tone: "warning" | "neutral"; text: string } | null {
  if (target.health === "degraded") {
    return { tone: "warning", text: t("tasks.waiting.health.degraded") };
  }
  if (target.health === "unverified") {
    return { tone: "neutral", text: t("tasks.waiting.health.unverified") };
  }
  return null;
}

/** Said only when the choice is paid differently from the step's route. */
export function paymentNotice(
  t: Translator,
  source: Pick<Offer["source"], "billingRoute">,
  target: Pick<Target, "billingRoute">,
): string | null {
  if (source.billingRoute === target.billingRoute) return null;
  return t("tasks.waiting.dialog.paymentChanges", {
    from: paymentInline(t, source.billingRoute),
    to: paymentInline(t, target.billingRoute),
  });
}

const INELIGIBLE_KEYS: Record<
  NonNullable<Target["ineligibleReason"]>,
  MessageKey
> = {
  different_harness: "tasks.waiting.ineligible.different_harness",
  route_open: "tasks.waiting.ineligible.route_open",
  route_not_active: "tasks.waiting.ineligible.route_not_active",
};

/** The routes that cannot be used, each with its reason, for the disclosure. */
export function unavailableChoices(
  t: Translator,
  offer: Pick<Offer, "targets">,
): { summary: string; lines: string[] } | null {
  const others = offer.targets.filter((target) => !target.eligible);
  if (others.length === 0) return null;
  return {
    summary: t("tasks.waiting.dialog.cannotUse", { count: others.length }),
    lines: others.map((target) =>
      t("tasks.waiting.dialog.cannotUseLine", {
        agent: agentName(t, target.harness),
        model: target.model,
        reason: t(
          target.ineligibleReason === null
            ? INELIGIBLE_KEYS.route_not_active
            : INELIGIBLE_KEYS[target.ineligibleReason],
        ),
      })
    ),
  };
}

/** The cost line; a figure replaces "Unknown" only when the server sent one. */
export function costLine(
  t: Translator,
  offer: Pick<Offer, "estimatedIncrementalCost">,
  money: (value: number) => string,
): string {
  const figure = offer.estimatedIncrementalCost === null
    ? Number.NaN
    : Number(offer.estimatedIncrementalCost);
  return t("tasks.waiting.dialog.cost", {
    cost: Number.isFinite(figure)
      ? money(figure)
      : t("tasks.waiting.dialog.costUnknown"),
  });
}

/** The button that makes the choice, naming it. */
export function continueLabel(t: Translator, target: Target): string {
  return t("tasks.waiting.dialog.continue", {
    model: target.model,
    payment: paymentInline(t, target.billingRoute),
  });
}

/** The notice after a choice worked. */
export function continuedNotice(t: Translator, target: Target): string {
  return t("tasks.waiting.continued", {
    agent: agentName(t, target.harness),
    model: target.model,
  });
}

/** What the server named when it refused a choice (`problem.reason`). */
export const REFUSAL_REASONS = [
  "incident_not_current",
  "step_not_pinned_to_route",
  "already_continued",
  "run_not_active",
  "cancel_requested",
  "target_route_not_active",
  "target_route_open",
  "target_different_harness",
  "target_pin_unchanged",
  "target_pricing_unavailable",
  "awaiting_reconciliation",
  "spend_in_flight",
  "job_not_funded",
  "attempt_budget_exhausted",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/**
 * Where a refusal is said. `page`: the choice is stale, so the dialog closes,
 * the page reads the latest and the notice sits above the steps. `dialog`: the
 * dialog stays open with the sentence; `reload` also reads the choices again,
 * for a target that can no longer be used.
 */
export type Refusal = Readonly<{
  where: "page" | "dialog";
  reload: boolean;
  key: MessageKey;
}>;

const REFUSALS: Record<RefusalReason, Refusal> = {
  incident_not_current: page("tasks.waiting.refused.changed"),
  step_not_pinned_to_route: page("tasks.waiting.refused.changed"),
  already_continued: page("tasks.waiting.refused.alreadyContinued"),
  run_not_active: page("tasks.waiting.refused.runEnded"),
  cancel_requested: page("tasks.waiting.refused.runEnded"),
  target_route_not_active: dialog("tasks.waiting.refused.targetGone", true),
  target_route_open: dialog("tasks.waiting.refused.targetGone", true),
  target_different_harness: dialog("tasks.waiting.refused.targetGone", true),
  target_pin_unchanged: dialog("tasks.waiting.refused.targetGone", true),
  target_pricing_unavailable: dialog("tasks.waiting.refused.noPrice"),
  awaiting_reconciliation: dialog("tasks.waiting.refused.confirming"),
  spend_in_flight: dialog("tasks.waiting.refused.confirming"),
  job_not_funded: dialog("tasks.waiting.refused.noBudget"),
  attempt_budget_exhausted: dialog("tasks.waiting.refused.noBudget"),
};

function page(key: MessageKey): Refusal {
  return { where: "page", reload: true, key };
}

function dialog(key: MessageKey, reload = false): Refusal {
  return { where: "dialog", reload, key };
}

/** The one sentence for a refusal the page does not know. */
const OTHER: Refusal = dialog("tasks.waiting.refused.other");

/**
 * What a failed choice means. The run having changed since the offer is the
 * server's `PRECONDITION_FAILED`; every other refusal is a `STATE_CONFLICT`
 * with a reason. A reason the page does not know, or none, reads as the plain
 * "Nothing was switched. Try again."
 */
export function refusalOf(
  failure: {
    readonly kind: string;
    readonly problem?: { readonly code: string; readonly reason?: string };
  },
): Refusal {
  if (failure.kind !== "problem" || !failure.problem) return OTHER;
  const { code, reason } = failure.problem;
  if (code === "PRECONDITION_FAILED") {
    return page("tasks.waiting.refused.changed");
  }
  if (code !== "STATE_CONFLICT" || reason === undefined) return OTHER;
  return (REFUSALS as Record<string, Refusal | undefined>)[reason] ?? OTHER;
}

/**
 * True when the answer to a choice never arrived or the server could not say,
 * so the choice may have gone through: the same key is sent again on a retry.
 */
export function outcomeUnknown(
  failure: {
    readonly kind: string;
    readonly problem?: { readonly status: number; readonly retryable: boolean };
  },
): boolean {
  if (failure.kind !== "problem" || !failure.problem) return true;
  const { status, retryable } = failure.problem;
  return retryable || status >= 500 || status === 408;
}
