import type { SecretsKeyConfig } from "@bakery/config";
import {
  type AlertMessage,
  type AlertMessageType,
  sendSignedWebhook,
} from "../../platform/alerts/webhook.ts";
import {
  ALERT_RULE_CATALOG,
  type AlertCondition,
  type AlertRuleKey,
  type AlertRuleSetting,
  evaluateRules,
  isAlertRuleKey,
} from "../../platform/alerts/rules.ts";
import {
  advanceAlerts,
  type AlertState,
  type AlertTransition,
} from "../../platform/alerts/state.ts";
import { readHealthSnapshot } from "../../platform/alerts/snapshot.ts";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import type { AddressPolicy } from "../../platform/telemetry-destinations/address-policy.ts";
import type { DestinationFanout } from "../../platform/telemetry-destinations/index.ts";
import { openInstallationSecret } from "../secrets/installation-secrets.ts";

/** How often the running server checks the five rules. */
export const ALERT_CHECK_INTERVAL_MS = 60_000;
/** How long one message waits for a receiver. */
export const ALERT_SEND_TIMEOUT_MS = 10_000;
/** A test alert answers the person who asked, inside the request deadline of 10 seconds. */
export const ALERT_TEST_SEND_TIMEOUT_MS = 8_000;
/** Held for the length of a check, so two servers never act on one check. */
const EVALUATION_LOCK = 739_001;

export type AlertEvaluatorDependencies = Readonly<{
  database: PgDatabase;
  secretsKey: SecretsKeyConfig | undefined;
  fetch: typeof fetch;
  addressPolicy: AddressPolicy;
  /** The telemetry destinations' fan-out, for what each dropped since the last check. */
  fanout?: Pick<DestinationFanout, "states">;
  /** Milliseconds since the epoch; replaced in tests. */
  now?: () => number;
}>;

/** What one check did. */
export type AlertCheckResult = Readonly<{
  /** False when another server held the check. */
  ran: boolean;
  fired: number;
  resolved: number;
  /** Messages that reached a receiver, and ones that did not. */
  delivered: number;
  failed: number;
}>;

/** One channel's answer to a test message. */
export type AlertTestChannelResult = Readonly<{
  channelId: string;
  name: string;
  ok: boolean;
  status: number | null;
  reason: string | null;
}>;

type ChannelRow = {
  id: string;
  name: string;
  settings: { address?: string };
  secret_id: string;
};

const minutes = (seconds: number): string => {
  const whole = Math.max(1, Math.round(seconds / 60));
  return whole === 1 ? "1 minute" : `${whole} minutes`;
};

/** The sentence an alert message carries. */
export function alertText(transition: AlertTransition): string {
  return transition.kind === "fire"
    ? `Alert: ${transition.condition.text}`
    : `Resolved: ${transition.state.text} It cleared after ${
      minutes(transition.clearedAfterSeconds)
    }.`;
}

export function createAlertEvaluator(deps: AlertEvaluatorDependencies) {
  const now = deps.now ?? Date.now;
  const previousDropped = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  /**
   * What each destination dropped since the last check, and the counts that
   * look saw. The counts are only remembered once the check has committed, so a
   * check that lost the lock or failed leaves its drops to the next one.
   */
  async function lostSinceLastCheck(): Promise<{
    lost: { id: string; name: string; lost: number }[];
    seen: Map<string, number>;
  }> {
    const seen = new Map<string, number>();
    if (deps.fanout === undefined) return { lost: [], seen };
    const names = new Map(
      (await deps.database.query<{ id: string; name: string }>(
        "select id, name from bakery.telemetry_destinations",
      )).rows.map((row) => [row.id, row.name]),
    );
    const lost: { id: string; name: string; lost: number }[] = [];
    for (const [id, state] of deps.fanout.states()) {
      const before = previousDropped.get(id);
      seen.set(id, state.dropped);
      // The first look only records the count: what was dropped before the
      // server started watching is not news.
      if (before === undefined) continue;
      const delta = state.dropped - before;
      if (delta > 0) lost.push({ id, name: names.get(id) ?? id, lost: delta });
    }
    return { lost, seen };
  }

  async function deliver(
    type: AlertMessageType,
    text: string,
    timeoutMs: number = ALERT_SEND_TIMEOUT_MS,
  ): Promise<{ results: AlertTestChannelResult[] }> {
    const channels = (await deps.database.query<ChannelRow>(
      `select id, name, settings, secret_id from bakery.alert_channels
        where enabled order by created_at, id`,
    )).rows;
    // Every channel at once: one that never answers waits its own timeout, not
    // everyone else's, so the whole send takes about one timeout however many
    // channels there are.
    const results = await Promise.all(channels.map(async (channel) => {
      let outcome;
      try {
        const secret = await openInstallationSecret(
          deps.database,
          deps.secretsKey,
          channel.secret_id,
        );
        const message: AlertMessage = {
          id: crypto.randomUUID(),
          type,
          text,
          sentAt: Math.floor(now() / 1000),
        };
        outcome = await sendSignedWebhook({
          address: channel.settings.address ?? "",
          secret,
          message,
          fetch: deps.fetch,
          addressPolicy: deps.addressPolicy,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        outcome = {
          ok: false,
          status: null,
          reason: "Bakery could not read this channel's signing secret.",
          answer: null,
        };
      }
      await deps.database.query(
        `update bakery.alert_channels
            set last_answer_at = now(), last_answer_ok = $2,
                last_answer_status = $3, last_answer_reason = $4
          where id = $1`,
        [channel.id, outcome.ok, outcome.status, outcome.reason],
      );
      const result: AlertTestChannelResult = {
        channelId: channel.id,
        name: channel.name,
        ok: outcome.ok,
        status: outcome.status,
        reason: outcome.reason,
      };
      return result;
    }));
    return { results };
  }

  /** Checks the rules once, records what changed and tells every enabled channel. */
  async function evaluateOnce(): Promise<AlertCheckResult> {
    let seen = new Map<string, number>();
    const planned = await withPgTransaction(deps.database, async (tx) => {
      const lock = await tx.query<{ locked: boolean }>(
        "select pg_try_advisory_xact_lock($1) as locked",
        [EVALUATION_LOCK],
      );
      if (!lock.rows[0]?.locked) return undefined;
      // A rule nobody has changed has no row and runs on its defaults.
      const settings = Object.fromEntries(
        Object.keys(ALERT_RULE_CATALOG).map((key) => [
          key,
          { enabled: true, threshold: null },
        ]),
      ) as Record<AlertRuleKey, AlertRuleSetting>;
      for (
        const row of (await tx.query<
          { rule: string; enabled: boolean; threshold: number | null }
        >("select rule, enabled, threshold from bakery.alert_rules")).rows
      ) {
        if (isAlertRuleKey(row.rule)) {
          settings[row.rule] = {
            enabled: row.enabled,
            threshold: row.threshold,
          };
        }
      }
      // Looked at only once this server holds the check, and remembered only
      // after the check commits.
      const watched = await lostSinceLastCheck();
      seen = watched.seen;
      const snapshot = await readHealthSnapshot(tx, watched.lost);
      const conditions: AlertCondition[] = evaluateRules(snapshot, settings);
      const stored = (await tx.query<{
        rule: string;
        subject: string;
        text: string;
        fired_at_seconds: number | string;
        clean_checks: number;
      }>(
        `select rule, subject, text, clean_checks,
                extract(epoch from fired_at)::float8 as fired_at_seconds
           from bakery.alert_states order by rule, subject`,
      )).rows.flatMap((row): AlertState[] =>
        isAlertRuleKey(row.rule)
          ? [{
            rule: row.rule,
            subject: row.subject,
            text: row.text,
            firedAt: Number(row.fired_at_seconds),
            cleanChecks: row.clean_checks,
          }]
          : []
      );
      const { states, transitions } = advanceAlerts(
        stored,
        conditions,
        Math.floor(now() / 1000),
      );
      const kept = new Set(states.map((s) => `${s.rule}:${s.subject}`));
      for (const old of stored) {
        if (!kept.has(`${old.rule}:${old.subject}`)) {
          await tx.query(
            "delete from bakery.alert_states where rule = $1 and subject = $2",
            [old.rule, old.subject],
          );
        }
      }
      const known = new Set(stored.map((s) => `${s.rule}:${s.subject}`));
      for (const state of states) {
        if (known.has(`${state.rule}:${state.subject}`)) {
          await tx.query(
            `update bakery.alert_states set text = $3, clean_checks = $4
              where rule = $1 and subject = $2`,
            [state.rule, state.subject, state.text, state.cleanChecks],
          );
        } else {
          await tx.query(
            `insert into bakery.alert_states (rule, subject, text, fired_at)
             values ($1, $2, $3, to_timestamp($4))`,
            [state.rule, state.subject, state.text, state.firedAt],
          );
        }
      }
      const events: { id: string; transition: AlertTransition }[] = [];
      for (const transition of transitions) {
        const id = crypto.randomUUID();
        const rule = transition.kind === "fire"
          ? transition.condition.rule
          : transition.state.rule;
        const subject = transition.kind === "fire"
          ? transition.condition.subject
          : transition.state.subject;
        await tx.query(
          `insert into bakery.alert_events (id, kind, rule, subject, text)
           values ($1, $2, $3, $4, $5)`,
          [
            id,
            transition.kind === "fire" ? "fired" : "resolved",
            rule,
            subject,
            alertText(transition),
          ],
        );
        events.push({ id, transition });
      }
      return events;
    });
    if (planned === undefined) {
      return { ran: false, fired: 0, resolved: 0, delivered: 0, failed: 0 };
    }
    for (const [id, dropped] of seen) previousDropped.set(id, dropped);
    // The states are saved, so a repeat of the same trouble is already
    // suppressed; delivery follows, and what each channel answered is recorded.
    let delivered = 0;
    let failed = 0;
    for (const event of planned) {
      const type: AlertMessageType = event.transition.kind === "fire"
        ? "alert.fired"
        : "alert.resolved";
      const { results } = await deliver(type, alertText(event.transition));
      const ok = results.filter((r) => r.ok).length;
      delivered += ok;
      failed += results.length - ok;
      await deps.database.query(
        `update bakery.alert_events set channels_ok = $2, channels_failed = $3
          where id = $1`,
        [event.id, ok, results.length - ok],
      );
    }
    return {
      ran: true,
      fired: planned.filter((e) => e.transition.kind === "fire").length,
      resolved: planned.filter((e) => e.transition.kind === "resolve").length,
      delivered,
      failed,
    };
  }

  /** Sends one test message to every enabled channel and says what each answered. */
  async function sendTest(): Promise<AlertTestChannelResult[]> {
    const text =
      "This is a test alert from Bakery. If you can read it, alerts reach you.";
    const { results } = await deliver(
      "alert.test",
      text,
      ALERT_TEST_SEND_TIMEOUT_MS,
    );
    const ok = results.filter((r) => r.ok).length;
    await deps.database.query(
      `insert into bakery.alert_events (kind, text, channels_ok, channels_failed)
       values ('test', $1, $2, $3)`,
      [text, ok, results.length - ok],
    );
    return results;
  }

  return {
    evaluateOnce,
    sendTest,
    /** Starts checking on a timer; a check still running is never doubled. */
    start(intervalMs = ALERT_CHECK_INTERVAL_MS): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        evaluateOnce().catch(() => {}).finally(() => {
          running = false;
        });
      }, intervalMs);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type AlertEvaluator = ReturnType<typeof createAlertEvaluator>;
export { ALERT_RULE_CATALOG };
