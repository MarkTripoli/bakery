import { type AlertCondition, alertKey, type AlertRuleKey } from "./rules.ts";

/**
 * What the evaluator remembers about each alert, so one trouble is one alert.
 *
 * An alert fires once when its rule first holds for a subject, stays firing
 * without saying anything more while it holds, and resolves once it has been
 * clear for `cleanChecksToResolve` checks in a row, which keeps a rule that
 * flickers from sending a message each way every time it does.
 */
export type AlertState = Readonly<{
  rule: AlertRuleKey;
  subject: string;
  /** The last text the alert had, for the recovery message. */
  text: string;
  firedAt: number;
  /** Consecutive checks since the rule last held. */
  cleanChecks: number;
}>;

/** What to do about the checks just made. */
export type AlertTransition = Readonly<
  | { kind: "fire"; condition: AlertCondition }
  | { kind: "resolve"; state: AlertState; clearedAfterSeconds: number }
>;

/** Clear checks in a row before an alert is called resolved. */
export const CLEAN_CHECKS_TO_RESOLVE = 2;

/**
 * Compares what is firing with what holds now. Pure: the caller keeps the
 * returned states and delivers the transitions, and a repeat of the same
 * trouble returns no transition at all.
 */
export function advanceAlerts(
  previous: readonly AlertState[],
  conditions: readonly AlertCondition[],
  nowSeconds: number,
  cleanChecksToResolve = CLEAN_CHECKS_TO_RESOLVE,
): { states: AlertState[]; transitions: AlertTransition[] } {
  const holding = new Map(
    conditions.map((c) => [alertKey(c.rule, c.subject), c]),
  );
  const states: AlertState[] = [];
  const transitions: AlertTransition[] = [];
  const known = new Set<string>();
  for (const state of previous) {
    const key = alertKey(state.rule, state.subject);
    known.add(key);
    const condition = holding.get(key);
    if (condition !== undefined) {
      states.push({ ...state, text: condition.text, cleanChecks: 0 });
      continue;
    }
    const cleanChecks = state.cleanChecks + 1;
    if (cleanChecks >= cleanChecksToResolve) {
      transitions.push({
        kind: "resolve",
        state,
        clearedAfterSeconds: Math.max(0, nowSeconds - state.firedAt),
      });
    } else {
      states.push({ ...state, cleanChecks });
    }
  }
  for (const condition of conditions) {
    if (known.has(alertKey(condition.rule, condition.subject))) continue;
    states.push({
      rule: condition.rule,
      subject: condition.subject,
      text: condition.text,
      firedAt: nowSeconds,
      cleanChecks: 0,
    });
    transitions.push({ kind: "fire", condition });
  }
  return { states, transitions };
}
