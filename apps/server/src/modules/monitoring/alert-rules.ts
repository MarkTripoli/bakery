import { Hono, type MiddlewareHandler } from "hono";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  AlertRuleImplementedAction as Action,
  alertRuleImplementedActions,
  assertImplementedActionRegistry,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  requireCommandMetadata,
  StandardError,
} from "@bakery/contracts/http";
import type { z } from "zod";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import {
  ALERT_RULE_CATALOG,
  type AlertRuleKey,
  isAlertRuleKey,
} from "../../platform/alerts/rules.ts";
import { installationActor } from "../integrations/postgres.ts";
import type { AlertTestChannelResult } from "./alert-evaluator.ts";

type Rule = z.output<typeof contractSchemas.AlertRule>;
type RuleList = z.output<typeof contractSchemas.AlertRuleList>;
type RuleUpdate = z.output<typeof contractSchemas.AlertRuleUpdate>;
type ListQuery = z.output<typeof contractSchemas.AlertListQuery>;
type AlertPage = z.output<typeof contractSchemas.AlertList>;
type TestSent = z.output<typeof contractSchemas.AlertTestSendResult>;

/** History entries per page when the caller names no limit. */
export const ALERT_HISTORY_PAGE = 25;
/** Alerts firing at once that one answer lists; more is a sign something larger is wrong. */
export const ALERT_FIRING_LIST_LIMIT = 100;

export type AlertRuleDependencies = Readonly<{
  /** Sends one test message to every enabled channel; the evaluator's own. */
  sendTest: () => Promise<readonly AlertTestChannelResult[]>;
}>;

type RuleRow = {
  rule: string;
  enabled: boolean;
  threshold: number | null;
  updated_at: string;
  version: number;
};

const stamp = (column: string): string =>
  `to_char(${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const RULE_COLUMNS = `rule, enabled, threshold, ${
  stamp("updated_at")
} as updated_at, version`;

/** A rule as an administrator sees it: the catalogue's words and the saved setting. */
export function ruleProjection(row: RuleRow, firing: number): Rule {
  const rule = row.rule as AlertRuleKey;
  const catalog = ALERT_RULE_CATALOG[rule];
  return contractSchemas.AlertRule.parse({
    rule,
    label: catalog.label,
    help: catalog.help,
    unit: catalog.unit,
    enabled: row.enabled,
    threshold: catalog.unit === null
      ? null
      : row.threshold ?? catalog.defaultThreshold,
    defaultThreshold: catalog.defaultThreshold,
    maxThreshold: catalog.maxThreshold,
    firing,
    version: row.version,
    // A rule nobody has changed is still at version 1.
    updatedAt: row.version === 1 ? null : row.updated_at,
  });
}

function problem(field: string, code: string, message: string): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: [field], code, message }] },
  });
}

function expectedVersion(context: ActionContext): number {
  const expected = requireCommandMetadata(context).expectedVersion;
  if (expected === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return expected;
}

async function firingByRule(
  query: Pick<PgTransactionClient, "query">,
): Promise<Map<string, number>> {
  const rows = await query.query<{ rule: string; firing: number }>(
    "select rule, count(*)::int as firing from bakery.alert_states group by rule",
  );
  return new Map(rows.rows.map((row) => [row.rule, row.firing]));
}

/** alertRules.list */
export async function listAlertRules(
  context: ActionContext,
): Promise<RuleList> {
  const { context: value } = installationActor(context);
  const rows = await value.transaction.query<RuleRow>(
    `select ${RULE_COLUMNS} from bakery.alert_rules`,
  );
  const firing = await firingByRule(value.transaction);
  const byRule = new Map(rows.rows.map((row) => [row.rule, row]));
  // The catalogue's order, not the table's, so the page never reshuffles. A
  // rule with no row has never been changed: it shows its defaults.
  const rules = Object.keys(ALERT_RULE_CATALOG).map((key) =>
    ruleProjection(
      byRule.get(key) ?? {
        rule: key,
        enabled: true,
        threshold: null,
        updated_at: "",
        version: 1,
      },
      firing.get(key) ?? 0,
    )
  );
  return contractSchemas.AlertRuleList.parse({ rules });
}

/** alertRules.update: turn a rule on or off, or set its limit. */
export async function updateAlertRule(
  context: ActionContext,
  input: RuleUpdate,
): Promise<Rule> {
  const { context: value, actor } = installationActor(context);
  const transaction = value.transaction;
  if (!isAlertRuleKey(input.rule)) {
    throw problem("rule", "unknown", "There is no such alert rule.");
  }
  const catalog = ALERT_RULE_CATALOG[input.rule];
  if (input.threshold !== undefined) {
    if (catalog.unit === null || catalog.maxThreshold === null) {
      throw problem(
        "threshold",
        "unsupported",
        "This rule has no limit to set.",
      );
    }
    if (input.threshold > catalog.maxThreshold) {
      throw problem(
        "threshold",
        "too_big",
        `The limit can be at most ${catalog.maxThreshold} ${catalog.unit}.`,
      );
    }
  }
  const expected = expectedVersion(context);
  // A rule nobody has changed has no row yet: it is at its defaults, version 1.
  await transaction.query(
    "insert into bakery.alert_rules (rule) values ($1) on conflict (rule) do nothing",
    [input.rule],
  );
  const current = (await transaction.query<RuleRow>(
    `select ${RULE_COLUMNS} from bakery.alert_rules where rule = $1 for update`,
    [input.rule],
  )).rows[0];
  if (current.version !== expected) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const row = (await transaction.query<RuleRow>(
    `update bakery.alert_rules
        set enabled = $3, threshold = $4, updated_by = $5,
            updated_at = now(), version = version + 1
      where rule = $1 and version = $2
      returning ${RULE_COLUMNS}`,
    [
      input.rule,
      expected,
      input.enabled ?? current.enabled,
      input.threshold === undefined ? current.threshold : input.threshold,
      actor.subject.principalId,
    ],
  )).rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.AlertRulesUpdate,
    resourceType: "alert_rule",
    resourceId: input.rule,
    details: {
      enabled: row.enabled,
      threshold: row.threshold,
      version: row.version,
    },
  });
  const firing = await firingByRule(transaction);
  return ruleProjection(row, firing.get(input.rule) ?? 0);
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(at: string, id: string): string {
  return btoa(JSON.stringify({ a: at, i: id })).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
}

/** A cursor that is not one this server made is a malformed request, never a guess. */
function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(padded)) as { a?: unknown; i?: unknown };
    if (
      typeof parsed.a === "string" && CURSOR_TIME.test(parsed.a) &&
      typeof parsed.i === "string" && UUID.test(parsed.i)
    ) return { at: parsed.a, id: parsed.i };
  } catch {
    // fall through to the refusal below
  }
  throw new StandardError({ code: "MALFORMED_REQUEST" });
}

type EventRow = {
  id: string;
  kind: string;
  rule: string | null;
  subject: string | null;
  text: string;
  occurred_at: string;
  channels_ok: number;
  channels_failed: number;
};

/** alerts.list: what is firing now (first page only) and the history, newest first. */
export async function listAlerts(
  context: ActionContext,
  input: ListQuery,
): Promise<AlertPage> {
  const { context: value } = installationActor(context);
  const query = value.transaction;
  const limit = input.limit ?? ALERT_HISTORY_PAGE;
  const after = input.cursor === undefined
    ? undefined
    : decodeCursor(input.cursor);
  const events = (await query.query<EventRow>(
    `select id, kind, rule, subject, text,
            ${stamp("occurred_at")} as occurred_at, channels_ok, channels_failed
       from bakery.alert_events
      where $1::timestamptz is null
         or (occurred_at, id) < ($1::timestamptz, $2::uuid)
      order by occurred_at desc, id desc
      limit $3`,
    [after?.at ?? null, after?.id ?? null, limit + 1],
  )).rows;
  const page = events.slice(0, limit);
  const last = page.at(-1);
  const firing = after === undefined
    ? (await query.query<
      { rule: string; subject: string; text: string; fired_at: string }
    >(
      `select rule, subject, text, ${stamp("fired_at")} as fired_at
         from bakery.alert_states order by fired_at desc, rule, subject
         limit ${ALERT_FIRING_LIST_LIMIT}`,
    )).rows.map((row) => ({
      rule: row.rule,
      subject: row.subject,
      text: row.text,
      firedAt: row.fired_at,
    }))
    : [];
  return contractSchemas.AlertList.parse({
    firing,
    events: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      rule: row.rule,
      subject: row.subject,
      text: row.text,
      occurredAt: row.occurred_at,
      channelsOk: row.channels_ok,
      channelsFailed: row.channels_failed,
    })),
    nextCursor: events.length > limit && last
      ? encodeCursor(last.occurred_at, last.id)
      : null,
  });
}

/** alerts.sendTest: one test message to every enabled channel, and what each answered. */
export async function sendAlertTest(
  context: ActionContext,
  dependencies: AlertRuleDependencies,
): Promise<TestSent> {
  const { context: value, actor } = installationActor(context);
  const results = await dependencies.sendTest();
  const sent = results.filter((result) => result.ok).length;
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.AlertsSendTest,
    resourceType: "alert",
    resourceId: "installation",
    details: { sent, failed: results.length - sent },
  });
  return contractSchemas.AlertTestSendResult.parse({
    channels: results.map((result) => ({
      channelId: result.channelId,
      name: result.name,
      ok: result.ok,
      status: result.status,
      reason: result.reason,
    })),
    sent,
    failed: results.length - sent,
  });
}

export function createAlertRuleActionRegistry(
  database: PgDatabase,
  dependencies: AlertRuleDependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  const policy = {
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  registry.register({
    name: Action.AlertRulesList,
    method: HttpMethod.Get,
    path: "/v1/installation/alert-rules",
    input: contractSchemas.Empty,
    output: contractSchemas.AlertRuleList,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context) => listAlertRules(context),
  }).register({
    name: Action.AlertRulesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/installation/alert-rules",
    input: contractSchemas.AlertRuleUpdate,
    output: contractSchemas.AlertRule,
    explicitIdempotency: "key-and-if-match",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) => updateAlertRule(context, input),
  }).register({
    name: Action.AlertsList,
    method: HttpMethod.Get,
    path: "/v1/installation/alerts",
    input: contractSchemas.AlertListQuery,
    output: contractSchemas.AlertList,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context, input) => listAlerts(context, input),
  }).register({
    name: Action.AlertsSendTest,
    method: HttpMethod.Post,
    path: "/v1/installation/alert-tests",
    input: contractSchemas.Empty,
    output: contractSchemas.AlertTestSendResult,
    explicitIdempotency: "key",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => sendAlertTest(context, dependencies),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, alertRuleImplementedActions);
  return registry;
}

export function createAlertRuleRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  dependencies: AlertRuleDependencies;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  for (
    const path of [
      "/v1/installation/alert-rules",
      "/v1/installation/alerts",
      "/v1/installation/alert-tests",
    ]
  ) app.use(path, options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createAlertRuleActionRegistry(
        options.database,
        options.dependencies,
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
