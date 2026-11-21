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
export type Target = Offer["targets"][number];
export type Unavailable = Offer["unavailable"][number];

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
  /** The button that opens the chooser, or null when nothing else can run it. */
  button: string | null;
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
    button: offer.targets.length > 0 ? t("tasks.waiting.choose") : null,
  };
}

/** The step's row while it waits on a model. */
export function stepRowCopy(offer: Offer, t: Translator): string {
  return t("tasks.waiting.stepRow", {
    agent: agentName(t, offer.source.harness),
    model: offer.source.model,
  });
}

// ---- The chooser (#70, slice 2, UX revision 3): providers on the left, that
// provider's models in a table on the right, search across every provider.

const HEALTH_RANK: Record<Target["health"], number> = {
  healthy: 0,
  unverified: 1,
  degraded: 2,
  open: 3,
};

/** Working, then Not tried yet, then Having trouble too, then by name. */
export function orderTargets(targets: readonly Target[]): Target[] {
  return [...targets].sort((a, b) =>
    HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
    a.modelName.localeCompare(b.modelName) ||
    a.providerName.localeCompare(b.providerName) ||
    a.routeId.localeCompare(b.routeId)
  );
}

/** The most the Suggested list holds. */
export const SUGGESTED_MAX = 5;

/**
 * Suggested: routes that are Working, priced and paid the same way as the
 * step's route today; the same provider first, at most five.
 */
export function suggestedTargets(
  offer: Pick<Offer, "source" | "targets">,
): Target[] {
  const { source } = offer;
  return orderTargets(
    offer.targets.filter((target) =>
      target.health === "healthy" && target.priced &&
      target.billingRoute === source.billingRoute
    ),
  ).sort((a, b) =>
    Number(b.provider === source.provider) -
    Number(a.provider === source.provider)
  ).slice(0, SUGGESTED_MAX);
}

export type ProviderEntry = Readonly<{
  /** The provider key, or `SUGGESTED` for the Suggested entry. */
  key: string;
  name: string;
  count: number;
}>;

/** The key of the Suggested entry in the provider list. */
export const SUGGESTED = "@suggested";

/**
 * The provider list: Suggested first when it has any, then every provider
 * with a usable route, by name, each with how many models it has.
 */
export function providerEntries(
  offer: Pick<Offer, "source" | "targets">,
  suggestedName: string,
): ProviderEntry[] {
  const byProvider = new Map<string, { name: string; count: number }>();
  for (const target of offer.targets) {
    const entry = byProvider.get(target.provider);
    if (entry) entry.count += 1;
    else {byProvider.set(target.provider, {
        name: target.providerName,
        count: 1,
      });}
  }
  const providers = [...byProvider].map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const suggested = suggestedTargets(offer).length;
  return suggested === 0 ? providers : [
    { key: SUGGESTED, name: suggestedName, count: suggested },
    ...providers,
  ];
}

/** The models one entry of the provider list shows, in table order. */
export function targetsOf(
  offer: Pick<Offer, "source" | "targets">,
  key: string,
): Target[] {
  if (key === SUGGESTED) return suggestedTargets(offer);
  return orderTargets(offer.targets.filter((one) => one.provider === key));
}

/**
 * Search across every provider: the text matches a model or provider name or
 * key, ignoring case. Blank text matches nothing (search is off).
 */
export function searchTargets(
  targets: readonly Target[],
  text: string,
): { matches: Target[]; providers: number } {
  const needle = text.trim().toLocaleLowerCase();
  if (needle === "") return { matches: [], providers: 0 };
  const matches = orderTargets(
    targets.filter((target) =>
      [target.modelName, target.model, target.providerName, target.provider]
        .some((field) => field.toLocaleLowerCase().includes(needle))
    ),
  );
  return {
    matches,
    providers: new Set(matches.map((one) => one.provider)).size,
  };
}

/** A target can be chosen only when Bakery has a price for it. */
export function choosable(target: Pick<Target, "priced">): boolean {
  return target.priced;
}

const PAYMENT_KEYS: Record<Billing, MessageKey> = {
  subscription: "tasks.waiting.payment.subscription",
  api_metered: "tasks.waiting.payment.api_metered",
  local: "tasks.waiting.payment.local",
};
const PAYMENT_SHORT_KEYS: Record<Billing, MessageKey> = {
  subscription: "tasks.waiting.payment.subscription.short",
  api_metered: "tasks.waiting.payment.api_metered.short",
  local: "tasks.waiting.payment.local.short",
};

/** How the work is paid, as a column or a line reads it. */
export function paymentLabel(t: Translator, billing: Billing): string {
  return t(PAYMENT_KEYS[billing]);
}

/** How the work is paid, shortened for the search table. */
export function paymentShort(t: Translator, billing: Billing): string {
  return t(PAYMENT_SHORT_KEYS[billing]);
}

/** The State column: how far to trust a route, or that it has no price. */
export function stateLabel(
  t: Translator,
  target: Pick<Target, "health" | "priced">,
): { tone: "success" | "warning" | "neutral"; text: string } {
  if (!target.priced) {
    return { tone: "neutral", text: t("tasks.waiting.state.noPrice") };
  }
  if (target.health === "degraded") {
    return { tone: "warning", text: t("tasks.waiting.health.degraded") };
  }
  if (target.health === "unverified") {
    return { tone: "neutral", text: t("tasks.waiting.health.unverified") };
  }
  return { tone: "success", text: t("tasks.waiting.health.healthy") };
}

/** The chooser's first line: what stays, what to do, and what runs now. */
export function chooserIntro(
  t: Translator,
  offer: Pick<Offer, "source">,
): string {
  const { source } = offer;
  return t("tasks.waiting.chooser.intro", {
    agent: agentName(t, source.harness),
    provider: source.providerName,
    model: source.modelName,
    payment: paymentInline(t, source.billingRoute),
  });
}

/** The end bar's summary of the choice: "{Provider} · {model} · {payment}". */
export function choiceSummary(t: Translator, target: Target): string {
  return t("tasks.waiting.chooser.summary", {
    provider: target.providerName,
    model: target.modelName,
    payment: paymentLabel(t, target.billingRoute),
  });
}

/** Said only when the choice is paid differently from the step's route. */
export function paymentNotice(
  t: Translator,
  source: Pick<Offer["source"], "billingRoute">,
  target: Pick<Target, "billingRoute">,
): string | null {
  if (source.billingRoute === target.billingRoute) return null;
  return t("tasks.waiting.chooser.paymentChanges", {
    from: paymentInline(t, source.billingRoute),
    to: paymentInline(t, target.billingRoute),
  });
}

/** The cost line; a figure replaces "Unknown" only when the server sent one. */
export function costLine(
  t: Translator,
  target: Pick<Target, "estimatedIncrementalCost"> | null,
  money: (value: number) => string,
): string {
  const raw = target?.estimatedIncrementalCost ?? null;
  const figure = raw === null ? Number.NaN : Number(raw);
  return t("tasks.waiting.chooser.cost", {
    cost: Number.isFinite(figure)
      ? money(figure)
      : t("tasks.waiting.chooser.costUnknown"),
  });
}

/** The button that makes the choice, naming the model. */
export function continueLabel(t: Translator, target: Target | null): string {
  return target === null
    ? t("tasks.waiting.chooser.continueNone")
    : t("tasks.waiting.chooser.continue", { model: target.modelName });
}

/** The notice after a choice worked. */
export function continuedNotice(t: Translator, target: Target): string {
  return t("tasks.waiting.continued", {
    agent: agentName(t, target.harness),
    model: target.modelName,
  });
}

/** The named routes of a group, with "and {n} more" past the names sent. */
function routeNames(t: Translator, group: Unavailable): string {
  const names = (group.routes ?? []).map((one) =>
    t("tasks.waiting.unavailable.routeName", {
      provider: one.providerName,
      model: one.modelName,
    })
  );
  const more = group.count - names.length;
  return more > 0
    ? t("tasks.waiting.unavailable.andMore", {
      names: names.join(", "),
      count: more,
    })
    : names.join(", ");
}

/** The closed "cannot be used" line, or null when every route can be used. */
export function unavailableSummary(
  t: Translator,
  offer: Pick<Offer, "unavailable">,
): string | null {
  const count = offer.unavailable.reduce((sum, one) => sum + one.count, 0);
  return count === 0 ? null : t("tasks.waiting.unavailable.summary", { count });
}

/**
 * One line per reason routes cannot be used, with its count: other coding
 * agents by agent only, routes not working by name, turned off routes as a
 * pointer to Settings with their names behind "Show the {n}" (`more`).
 */
export function unavailableLines(
  t: Translator,
  offer: Pick<Offer, "unavailable">,
): {
  reason: Unavailable["reason"];
  text: string;
  more?: { label: string; names: string };
}[] {
  return offer.unavailable.map((group) => {
    if (group.reason === "different_harness") {
      return {
        reason: group.reason,
        text: t("tasks.waiting.unavailable.different_harness", {
          count: group.count,
          agents: (group.harnesses ?? []).map((one) =>
            t("tasks.waiting.unavailable.agentCount", {
              agent: agentName(t, one.harness),
              count: one.count,
            })
          ).join(", "),
        }),
      };
    }
    if (group.reason === "route_open") {
      return {
        reason: group.reason,
        text: t("tasks.waiting.unavailable.route_open", {
          count: group.count,
          names: routeNames(t, group),
        }),
      };
    }
    return {
      reason: group.reason,
      text: t("tasks.waiting.unavailable.route_not_active"),
      ...(group.routes === undefined || group.routes.length === 0 ? {} : {
        more: {
          label: t("tasks.waiting.unavailable.showTurnedOff", {
            count: group.count,
          }),
          names: routeNames(t, group),
        },
      }),
    };
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
 * Where a refusal is said. `page`: the choice is stale, so the chooser
 * closes, the page reads the latest and the notice sits above the steps.
 * `chooser`: it stays open with the sentence above its buttons; `reload`
 * also reads the choices again, for a target that can no longer be used.
 */
export type Refusal = Readonly<{
  where: "page" | "chooser";
  reload: boolean;
  key: MessageKey;
}>;

function onPage(key: MessageKey): Refusal {
  return { where: "page", reload: true, key };
}

function inChooser(key: MessageKey, reload = false): Refusal {
  return { where: "chooser", reload, key };
}

const REFUSALS: Record<RefusalReason, Refusal> = {
  incident_not_current: onPage("tasks.waiting.refused.changed"),
  step_not_pinned_to_route: onPage("tasks.waiting.refused.changed"),
  already_continued: onPage("tasks.waiting.refused.alreadyContinued"),
  run_not_active: onPage("tasks.waiting.refused.runEnded"),
  cancel_requested: onPage("tasks.waiting.refused.runEnded"),
  target_route_not_active: inChooser("tasks.waiting.refused.targetGone", true),
  target_route_open: inChooser("tasks.waiting.refused.targetGone", true),
  target_different_harness: inChooser("tasks.waiting.refused.targetGone", true),
  target_pin_unchanged: inChooser("tasks.waiting.refused.targetGone", true),
  target_pricing_unavailable: inChooser("tasks.waiting.refused.noPrice"),
  awaiting_reconciliation: inChooser("tasks.waiting.refused.confirming"),
  spend_in_flight: inChooser("tasks.waiting.refused.confirming"),
  job_not_funded: inChooser("tasks.waiting.refused.noBudget"),
  attempt_budget_exhausted: inChooser("tasks.waiting.refused.noBudget"),
};

/** The one sentence for a refusal the page does not know. */
const OTHER: Refusal = inChooser("tasks.waiting.refused.other");

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
    return onPage("tasks.waiting.refused.changed");
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
