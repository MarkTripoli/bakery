/**
 * The five things Bakery alerts on, and when each one holds.
 *
 * A rule looks at a snapshot of how the installation is doing and says which
 * subjects are in trouble. It decides nothing about sending: that is the state
 * machine's and the sender's. Keeping it a pure function of a snapshot is what
 * lets every rule be proved without a database or a clock.
 */

/** The alert rules, in the order a person sees them. */
export const ALERT_RULE_KEYS = Object.freeze(
  [
    "service_down",
    "worker_lost",
    "queue_age",
    "route_incident",
    "export_loss",
  ] as const,
);
export type AlertRuleKey = typeof ALERT_RULE_KEYS[number];

/** Whether a string is one of the five rules. */
export function isAlertRuleKey(value: unknown): value is AlertRuleKey {
  return typeof value === "string" &&
    (ALERT_RULE_KEYS as readonly string[]).includes(value);
}

/** What a rule is called, what it watches and how its limit is measured. */
export const ALERT_RULE_CATALOG: Readonly<
  Record<
    AlertRuleKey,
    Readonly<{
      label: string;
      help: string;
      /** What the limit counts, or null when the rule has no limit. */
      unit: "seconds" | "records" | null;
      defaultThreshold: number | null;
      maxThreshold: number | null;
    }>
  >
> = Object.freeze({
  service_down: {
    label: "Service down",
    help:
      "Events are not being delivered: the oldest one has waited longer than the limit.",
    unit: "seconds",
    defaultThreshold: 300,
    maxThreshold: 86_400,
  },
  worker_lost: {
    label: "Worker lost",
    help:
      "A machine that took work has stopped reporting for longer than the limit.",
    unit: "seconds",
    defaultThreshold: 300,
    maxThreshold: 86_400,
  },
  queue_age: {
    label: "Work is waiting too long",
    help: "The oldest job ready to run has waited longer than the limit.",
    unit: "seconds",
    defaultThreshold: 900,
    maxThreshold: 604_800,
  },
  route_incident: {
    label: "Model route incident",
    help: "A model route has an open incident.",
    unit: null,
    defaultThreshold: null,
    maxThreshold: null,
  },
  export_loss: {
    label: "Telemetry is being lost",
    help:
      "A telemetry destination dropped at least the limit's number of records since the last check.",
    unit: "records",
    defaultThreshold: 1,
    maxThreshold: 1_000_000,
  },
});

/** One rule's saved setting. */
export type AlertRuleSetting = Readonly<{
  enabled: boolean;
  /** The limit, in the rule's unit; ignored by a rule with none. */
  threshold: number | null;
}>;

/** What the evaluator is given: how the installation is doing right now. */
export type HealthSnapshot = Readonly<{
  /** Seconds since the oldest event waiting for delivery was ready; 0 when none. */
  oldestUndeliveredEventSeconds: number;
  /** Machines that took work and have been silent, with how long. */
  silentWorkers: readonly Readonly<
    { id: string; name: string; silentSeconds: number }
  >[];
  /** Seconds the oldest job ready to run has waited; 0 when none. */
  oldestQueuedJobSeconds: number;
  /** Open incidents on model routes. */
  openRouteIncidents: readonly Readonly<
    { id: string; route: string; severity: string }
  >[];
  /** Records each telemetry destination dropped since the last check. */
  lostByDestination: readonly Readonly<
    { id: string; name: string; lost: number }
  >[];
}>;

/** A rule that holds for one subject: the thing in trouble. */
export type AlertCondition = Readonly<{
  rule: AlertRuleKey;
  /** Stable for the same trouble, so the same trouble is one alert. */
  subject: string;
  /** The sentence a person reads. */
  text: string;
}>;

/** The alert's identity: one per rule and subject. */
export const alertKey = (rule: AlertRuleKey, subject: string): string =>
  `${rule}:${subject}`;

const minutes = (seconds: number): string => {
  const whole = Math.max(1, Math.round(seconds / 60));
  return whole === 1 ? "1 minute" : `${whole} minutes`;
};

/**
 * Which subjects are in trouble under these settings. A rule that is off, or
 * has no limit it needs, reports nothing; the order is the catalogue's, then
 * the subject's, so the same snapshot always gives the same answer.
 */
export function evaluateRules(
  snapshot: HealthSnapshot,
  settings: Readonly<Record<AlertRuleKey, AlertRuleSetting>>,
): AlertCondition[] {
  const found: AlertCondition[] = [];
  const limit = (rule: AlertRuleKey): number | undefined => {
    const setting = settings[rule];
    if (!setting?.enabled) return undefined;
    const spec = ALERT_RULE_CATALOG[rule];
    if (spec.unit === null) return 0;
    const value = setting.threshold ?? spec.defaultThreshold;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : spec.defaultThreshold ?? undefined;
  };

  const serviceLimit = limit("service_down");
  if (
    serviceLimit !== undefined &&
    snapshot.oldestUndeliveredEventSeconds > serviceLimit
  ) {
    found.push({
      rule: "service_down",
      subject: "event-delivery",
      text: `Events have waited ${
        minutes(snapshot.oldestUndeliveredEventSeconds)
      } for delivery, so a service that delivers them looks down.`,
    });
  }

  const workerLimit = limit("worker_lost");
  if (workerLimit !== undefined) {
    for (
      const worker of [...snapshot.silentWorkers].sort((a, b) =>
        a.id.localeCompare(b.id)
      )
    ) {
      if (worker.silentSeconds > workerLimit) {
        found.push({
          rule: "worker_lost",
          subject: worker.id,
          text: `The machine ${worker.name} has not reported for ${
            minutes(worker.silentSeconds)
          }.`,
        });
      }
    }
  }

  const queueLimit = limit("queue_age");
  if (
    queueLimit !== undefined && snapshot.oldestQueuedJobSeconds > queueLimit
  ) {
    found.push({
      rule: "queue_age",
      subject: "queue",
      text: `Work ready to run has waited ${
        minutes(snapshot.oldestQueuedJobSeconds)
      }.`,
    });
  }

  if (limit("route_incident") !== undefined) {
    for (
      const incident of [...snapshot.openRouteIncidents].sort((a, b) =>
        a.id.localeCompare(b.id)
      )
    ) {
      found.push({
        rule: "route_incident",
        subject: incident.id,
        text:
          `The model route ${incident.route} has an open ${incident.severity} incident.`,
      });
    }
  }

  const lossLimit = limit("export_loss");
  if (lossLimit !== undefined) {
    for (
      const destination of [...snapshot.lostByDestination].sort((a, b) =>
        a.id.localeCompare(b.id)
      )
    ) {
      if (destination.lost >= Math.max(1, lossLimit)) {
        found.push({
          rule: "export_loss",
          subject: destination.id,
          text: `The telemetry destination ${destination.name} dropped ${
            destination.lost === 1 ? "1 record" : `${destination.lost} records`
          } since the last check.`,
        });
      }
    }
  }
  return found;
}
