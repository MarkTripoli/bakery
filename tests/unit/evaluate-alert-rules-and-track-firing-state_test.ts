import { assertEquals } from "@std/assert";
import {
  ALERT_RULE_CATALOG,
  ALERT_RULE_KEYS,
  type AlertRuleKey,
  type AlertRuleSetting,
  evaluateRules,
  type HealthSnapshot,
} from "../../apps/server/src/platform/alerts/rules.ts";
import {
  advanceAlerts,
  type AlertState,
} from "../../apps/server/src/platform/alerts/state.ts";

/**
 * AC4 of #739, the logic half: given a service or worker that stops, the rule
 * holds; the alert fires once, repeats are suppressed, and a recovery follows.
 */

const calm: HealthSnapshot = {
  oldestUndeliveredEventSeconds: 0,
  silentWorkers: [],
  oldestQueuedJobSeconds: 0,
  openRouteIncidents: [],
  lostByDestination: [],
};

const allOn = (
  overrides: Partial<Record<AlertRuleKey, AlertRuleSetting>> = {},
): Record<AlertRuleKey, AlertRuleSetting> => {
  const base = {} as Record<AlertRuleKey, AlertRuleSetting>;
  for (const key of ALERT_RULE_KEYS) {
    base[key] = { enabled: true, threshold: null };
  }
  return { ...base, ...overrides };
};

Deno.test("a calm installation trips nothing", () => {
  assertEquals(evaluateRules(calm, allOn()), []);
});

Deno.test("each rule holds only past its limit, and the default limit applies when none is saved", () => {
  const trouble: HealthSnapshot = {
    oldestUndeliveredEventSeconds: 301,
    silentWorkers: [{ id: "w-b", name: "Build box", silentSeconds: 301 }, {
      id: "w-a",
      name: "Mac mini",
      silentSeconds: 600,
    }],
    oldestQueuedJobSeconds: 901,
    openRouteIncidents: [{
      id: "i-1",
      route: "Anthropic API",
      severity: "major",
    }],
    lostByDestination: [{ id: "d-1", name: "Grafana", lost: 3 }],
  };
  const found = evaluateRules(trouble, allOn());
  assertEquals(
    found.map((c) => [c.rule, c.subject]),
    [
      ["service_down", "event-delivery"],
      ["worker_lost", "w-a"],
      ["worker_lost", "w-b"],
      ["queue_age", "queue"],
      ["route_incident", "i-1"],
      ["export_loss", "d-1"],
    ],
  );
  // Exactly at the limit is not past it.
  assertEquals(
    evaluateRules({
      ...calm,
      oldestUndeliveredEventSeconds: 300,
      oldestQueuedJobSeconds: 900,
      silentWorkers: [{ id: "w", name: "x", silentSeconds: 300 }],
    }, allOn()),
    [],
  );
});

Deno.test("a saved limit replaces the default, and a bad one falls back to it", () => {
  const snapshot: HealthSnapshot = { ...calm, oldestQueuedJobSeconds: 100 };
  const rule = (threshold: number | null) =>
    allOn({ queue_age: { enabled: true, threshold } });
  assertEquals(evaluateRules(snapshot, rule(60)).length, 1);
  assertEquals(evaluateRules(snapshot, rule(120)).length, 0);
  assertEquals(evaluateRules(snapshot, rule(-5)).length, 0, "default 900");
  assertEquals(evaluateRules(snapshot, rule(Number.NaN)).length, 0);
});

Deno.test("a rule that is off reports nothing, whatever the snapshot says", () => {
  const trouble: HealthSnapshot = {
    oldestUndeliveredEventSeconds: 9_999,
    silentWorkers: [{ id: "w", name: "x", silentSeconds: 9_999 }],
    oldestQueuedJobSeconds: 9_999,
    openRouteIncidents: [{ id: "i", route: "r", severity: "minor" }],
    lostByDestination: [{ id: "d", name: "n", lost: 9 }],
  };
  const off = {} as Record<AlertRuleKey, AlertRuleSetting>;
  for (const key of ALERT_RULE_KEYS) {
    off[key] = { enabled: false, threshold: null };
  }
  assertEquals(evaluateRules(trouble, off), []);
});

Deno.test("every rule is in the catalogue with a plain label and a bounded limit", () => {
  for (const key of ALERT_RULE_KEYS) {
    const spec = ALERT_RULE_CATALOG[key];
    assertEquals(spec.label.length > 0 && spec.help.length > 0, true, key);
    if (spec.unit === null) {
      assertEquals([spec.defaultThreshold, spec.maxThreshold], [null, null]);
    } else {
      assertEquals(
        spec.defaultThreshold! <= spec.maxThreshold!,
        true,
        key,
      );
    }
  }
});

const stuck = evaluateRules(
  {
    ...calm,
    silentWorkers: [{ id: "w", name: "Mac mini", silentSeconds: 700 }],
  },
  allOn(),
);

Deno.test("trouble fires once, stays quiet while it lasts, and resolves after it is clear for two checks", () => {
  let states: AlertState[] = [];
  const first = advanceAlerts(states, stuck, 1_000);
  assertEquals(first.transitions.map((t) => t.kind), ["fire"]);
  states = first.states;
  // The same trouble again: no message.
  for (const at of [1_060, 1_120, 1_180]) {
    const again = advanceAlerts(states, stuck, at);
    assertEquals(again.transitions, [], "a repeat is suppressed");
    states = again.states;
  }
  assertEquals(states[0].firedAt, 1_000, "it keeps the time it first fired");
  // One clear check is not enough.
  const clearOnce = advanceAlerts(states, [], 1_240);
  assertEquals(clearOnce.transitions, []);
  states = clearOnce.states;
  // Trouble returning resets the count, with no new message.
  const back = advanceAlerts(states, stuck, 1_300);
  assertEquals(back.transitions, []);
  assertEquals(back.states[0].cleanChecks, 0);
  states = back.states;
  // Two clear checks resolve it, once.
  states = advanceAlerts(states, [], 1_360).states;
  const resolved = advanceAlerts(states, [], 1_420);
  assertEquals(resolved.transitions.length, 1);
  const done = resolved.transitions[0];
  assertEquals(done.kind, "resolve");
  assertEquals(done.kind === "resolve" && done.clearedAfterSeconds, 420);
  assertEquals(resolved.states, []);
  // And a later check says nothing more.
  assertEquals(advanceAlerts(resolved.states, [], 1_480).transitions, []);
});

Deno.test("a new subject is its own alert and a second trouble does not repeat the first", () => {
  const one = advanceAlerts([], stuck, 10);
  const both = advanceAlerts(
    one.states,
    [
      ...stuck,
      {
        rule: "queue_age",
        subject: "queue",
        text: "Work ready to run has waited 20 minutes.",
      },
    ],
    70,
  );
  assertEquals(both.transitions.map((t) => t.kind), ["fire"]);
  assertEquals(
    both.transitions[0].kind === "fire" &&
      both.transitions[0].condition.rule,
    "queue_age",
  );
  assertEquals(both.states.length, 2);
});
