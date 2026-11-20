// What the task page says about a step that waits on a model (#70, slice 2), as
// plain functions: which offers are shown and when, and the words of the card
// and the step's row. No React, so one unit test proves the rules.
//
// The words are design-ux's (the slice 2 design and its ruling on the second
// line). Nothing here chooses for the person: Bakery never switches by itself,
// and the card only says what waits and why.
import type { MessageKey, Translator } from "@bakery/i18n";
import type { RouteContinuationOffersResponse } from "../../api/client.ts";
// The one list of providers a person knows by name: the contract types a
// provider as an open key, so the usage page's list is the source.
import { providerName } from "../../screens/usage/usage-display.ts";

export { providerName };

export type Offer = RouteContinuationOffersResponse["offers"][number];
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

const PAYMENT_INLINE_KEYS: Record<Billing, MessageKey> = {
  subscription: "tasks.waiting.payment.subscription.inline",
  api_metered: "tasks.waiting.payment.api_metered.inline",
  local: "tasks.waiting.payment.local.inline",
};

/** How the work is paid, to read inside a sentence ("using …"). */
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

export type CardCopy = Readonly<{
  /** "Waiting on a model", the run's badge. */
  badge: string;
  title: string;
  /** What the step runs on and why it waits, since when. */
  text: string;
  /** What Bakery has and has not done, and what happens next. */
  second: string;
}>;

/** The words of one waiting card. */
export function cardCopy(
  offer: Offer,
  t: Translator,
  when: (iso: string) => string,
  /** The step's name as its stage tab shows it. */
  stepName: (stepKey: string) => string,
): CardCopy {
  const { source } = offer;
  const agent = agentName(t, source.harness);
  const provider = providerName(source.provider);
  // No way to choose ships yet (the chooser is a later slice), so the second
  // line promises no choice: only what Bakery has not done and when it tries
  // the provider again.
  const second = [
    t("tasks.waiting.second"),
    ...(offer.nextCheckAt === null ? [] : [
      t("tasks.waiting.second.check", {
        provider,
        time: when(offer.nextCheckAt),
      }),
    ]),
  ].join(" ");
  return {
    badge: t("tasks.waiting.badge"),
    title: t("tasks.waiting.title", { agent }),
    text: [
      t("tasks.waiting.runsOn", {
        step: stepName(offer.stepKey),
        agent,
        model: source.model,
        payment: paymentInline(t, source.billingRoute),
      }),
      t(reasonKey(offer.reason), { provider, time: when(offer.since) }),
    ].join(" "),
    second,
  };
}

/** The step's row while it waits on a model. */
export function stepRowCopy(offer: Offer, t: Translator): string {
  return t("tasks.waiting.stepRow", {
    agent: agentName(t, offer.source.harness),
    model: offer.source.model,
  });
}
